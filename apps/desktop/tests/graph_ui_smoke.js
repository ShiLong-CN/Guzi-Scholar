'use strict';

const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const normalizeFontFamily = (value) => String(value || '').replace(/["']/g, '').replace(/\s+/g, '').toLowerCase();
let browserSession;

(async () => {
  browserSession = await launchManagedChromium();
  const page = await browserSession.browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`); });
  await page.addInitScript(() => {
    window.__MY_SCHOLAR_TEST__ = true;
    if (sessionStorage.getItem('__my_scholar_graph_defaults_seeded__') !== '1') {
      localStorage.removeItem('my-scholar-graph-preferences-v2');
      localStorage.setItem('my-scholar-graph-preferences-v1', JSON.stringify({
        showSimilarity: true,
        showAttributes: true,
        attributeIds: null,
        similarityThreshold: 0.5,
        viewportScale: 0.85,
      }));
      sessionStorage.setItem('__my_scholar_graph_defaults_seeded__', '1');
    }
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator('#recent-list .library-row').first().waitFor();
  const fixture = await page.evaluate(async () => {
    const [libraryPayload, jobsPayload] = await Promise.all([
      fetch('/api/library').then((response) => response.json()),
      fetch('/api/jobs').then((response) => response.json()),
    ]);
    const library = libraryPayload.library || {};
    const jobs = new Map((jobsPayload.jobs || []).map((job) => [String(job.job_id), job]));
    const attributeIds = ['research_topic', 'venue', ...(library.properties || [])
      .filter((property) => property?.id && !property.system && ['select', 'multi-select'].includes(property.type))
      .map((property) => String(property.id))];
    const graph = window.MyScholarGraphModel.buildGraph(library, {
      jobs: jobsPayload.jobs || [],
      attributeIds,
    });
    const degrees = new Map();
    graph.edges.forEach((edge) => {
      degrees.set(edge.data.source, (degrees.get(edge.data.source) || 0) + 1);
      degrees.set(edge.data.target, (degrees.get(edge.data.target) || 0) + 1);
    });
    const papers = graph.nodes.filter((node) => node.data?.type === 'paper').map((node) => {
      const id = String(node.data.jobId);
      const item = library.items?.[id] || {};
      return {
        id,
        title: String(node.data.title || node.data.label || '未命名文献'),
        searchText: String(node.data.searchText || '').normalize('NFKC').toLocaleLowerCase(),
        completed: jobs.get(id)?.status === 'completed',
        importance: Number(item?.values?.importance || 0),
        connectionCount: degrees.get(node.data.id) || 0,
      };
    });
    return {
      library,
      papers,
      attributeCount: graph.stats.attributeCount,
      propertyEdgeCount: graph.stats.propertyEdgeCount,
      similarityEdgeCount: graph.stats.similarityEdgeCount,
      edgeCount: graph.edges.length,
    };
  });
  if (!fixture.papers.length) throw new Error('图谱 UI 回归至少需要一篇未删除文献');

  const exposeGraphController = async () => page.evaluate(() => {
    const graphView = window.MyScholarGraphView;
    window.MyScholarGraphView = Object.freeze({
      ...graphView,
      create: (...args) => {
        const controller = graphView.create(...args);
        if (args[0]?.container?.id === 'library-graph-canvas') window.__MY_SCHOLAR_GRAPH_CONTROLLER__ = controller;
        return controller;
      },
    });
  });
  await exposeGraphController();

  const graphEntry = page.locator('[data-library-mode="graph"]');
  if (await graphEntry.count() !== 1) throw new Error('关系图谱入口缺失或重复');
  await graphEntry.click();
  await page.locator('#library-graph-surface:not([hidden])').waitFor();
  await page.waitForFunction((paperCount) => document.querySelectorAll('#graph-accessible-list button[data-graph-node-id^="paper:"]').length === paperCount, fixture.papers.length);
  if (!(await graphEntry.evaluate((node) => node.classList.contains('active')))) throw new Error('关系图谱入口没有激活状态');
  if (await page.locator('#library-list-surface:not([hidden])').count()) throw new Error('进入图谱后文献列表仍然可见');
  if (await page.locator('#library-grouping-list').isVisible()) throw new Error('图谱模式仍显示无效的列表分类器');
  if (await page.locator('#graph-node-size, .graph-size-control').count()) throw new Error('旧的节点大小控件仍然存在');
  const similarityToggle = page.getByRole('switch', { name: '内容相似' });
  if (await similarityToggle.isChecked()) throw new Error('内容相似虚线没有默认关闭');
  if (await page.locator('.graph-similarity-switch .graph-switch-track').count() !== 1) throw new Error('内容相似开关缺少可见的开关轨道');
  const initialSimilarityState = await page.evaluate(() => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const cy = controller.getCytoscape();
    return {
      enabled: controller.getConfig().showSimilarity,
      similarityEdges: cy.edges('[type = "similarity"]').length,
    };
  });
  if (initialSimilarityState.enabled || initialSimilarityState.similarityEdges) throw new Error(`默认仍渲染内容相似虚线：${JSON.stringify(initialSimilarityState)}`);
  const defaultStats = (await page.locator('#graph-stats').textContent()).trim();
  if (!defaultStats.includes(`${fixture.propertyEdgeCount} 条连接`)) throw new Error(`默认连接统计没有排除内容相似虚线：${defaultStats}`);
  await similarityToggle.check();
  await page.waitForFunction(({ similarityEdgeCount, edgeCount }) => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const cy = controller?.getCytoscape?.();
    const preferences = JSON.parse(localStorage.getItem('my-scholar-graph-preferences-v2') || '{}');
    return controller?.getConfig?.().showSimilarity === true
      && cy?.edges?.('[type = "similarity"]').length === similarityEdgeCount
      && preferences.showSimilarity === true
      && document.querySelector('#graph-stats')?.textContent.includes(`${edgeCount} 条连接`);
  }, { similarityEdgeCount: fixture.similarityEdgeCount, edgeCount: fixture.edgeCount });
  const graphZoomSlider = page.getByRole('slider', { name: '图谱缩放' });
  if (await graphZoomSlider.getAttribute('min') !== '60' || await graphZoomSlider.getAttribute('max') !== '130' || await graphZoomSlider.getAttribute('step') !== '5') throw new Error('图谱缩放滑杆范围或步长异常');
  if (await graphZoomSlider.inputValue() !== '85' || (await page.locator('#graph-zoom-value').textContent()).trim() !== '85%' || await graphZoomSlider.getAttribute('aria-valuetext') !== '85%') throw new Error('图谱没有使用 85% 默认缩放');
  const graphFontState = await page.evaluate(() => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const cy = controller.getCytoscape();
    return {
      reader: getComputedStyle(document.documentElement).getPropertyValue('--reader-content-font-family'),
      config: controller.getConfig().fontFamily,
      nodes: [...new Set(cy.nodes(':visible').map((node) => node.style('font-family')))],
    };
  });
  const normalizedReaderFont = normalizeFontFamily(graphFontState.reader);
  if (!normalizedReaderFont || normalizeFontFamily(graphFontState.config) !== normalizedReaderFont || graphFontState.nodes.some((font) => normalizeFontFamily(font) !== normalizedReaderFont)) throw new Error(`图谱标签字体没有跟随阅读器：${JSON.stringify(graphFontState)}`);
  const graphFontUpdate = await page.evaluate((readerFont) => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const cy = controller.getCytoscape();
    let layoutStarts = 0;
    cy.on('layoutstart', () => { layoutStarts += 1; });
    const positionsBefore = Object.fromEntries(cy.nodes().map((node) => [node.id(), { ...node.position() }]));
    controller.setFontFamily('Georgia, "Times New Roman", Times, serif');
    const changedFonts = [...new Set(cy.nodes(':visible').map((node) => node.style('font-family')))];
    controller.setFontFamily(readerFont);
    return {
      changedFonts,
      restoredFonts: [...new Set(cy.nodes(':visible').map((node) => node.style('font-family'))) ],
      positionsBefore,
      positionsAfter: Object.fromEntries(cy.nodes().map((node) => [node.id(), { ...node.position() }])),
      layoutStarts,
    };
  }, graphFontState.reader);
  if (graphFontUpdate.changedFonts.some((font) => !normalizeFontFamily(font).startsWith('georgia,')) || graphFontUpdate.restoredFonts.some((font) => normalizeFontFamily(font) !== normalizedReaderFont)) throw new Error(`图谱字体热更新异常：${JSON.stringify(graphFontUpdate)}`);
  if (graphFontUpdate.layoutStarts || JSON.stringify(graphFontUpdate.positionsAfter) !== JSON.stringify(graphFontUpdate.positionsBefore)) throw new Error('切换阅读器字体时图谱被重新布局');
  const graphViewportBefore = await page.evaluate(() => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const cy = controller.getCytoscape();
    window.__MY_SCHOLAR_GRAPH_SCALE_LAYOUTS__ = 0;
    cy.on('layoutstart', () => { window.__MY_SCHOLAR_GRAPH_SCALE_LAYOUTS__ += 1; });
    const pan = { ...cy.pan() };
    const zoom = cy.zoom();
    const center = { x: cy.container().clientWidth / 2, y: cy.container().clientHeight / 2 };
    const fitViewport = cy.getFitViewport(cy.elements(':visible'), controller.getConfig().fitPadding);
    return {
      positions: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { ...node.position() }])),
      sizes: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { type: node.data('type'), width: node.width(), height: node.height() }])),
      renderedSizes: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { width: node.renderedWidth(), height: node.renderedHeight() }])),
      labels: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { label: node.data('label'), canvasLabel: node.data('canvasLabel') }])),
      centerModel: { x: (center.x - pan.x) / zoom, y: (center.y - pan.y) / zoom },
      fitZoom: fitViewport.zoom,
      pan,
      zoom,
      nodeCount: cy.nodes().length,
      edgeCount: cy.edges().length,
    };
  });
  if (Math.abs(graphViewportBefore.zoom / graphViewportBefore.fitZoom - 0.85) > 0.01) throw new Error(`默认图谱缩放没有相对适窗结果缩小到 85%：${JSON.stringify(graphViewportBefore)}`);
  await graphZoomSlider.focus();
  await graphZoomSlider.press('Home');
  await graphZoomSlider.press('ArrowRight');
  await graphZoomSlider.press('ArrowRight');
  await page.waitForFunction(() => window.__MY_SCHOLAR_GRAPH_CONTROLLER__?.getConfig?.().viewportScale === 0.7);
  if (await graphZoomSlider.inputValue() !== '70' || (await page.locator('#graph-zoom-value').textContent()).trim() !== '70%' || await graphZoomSlider.getAttribute('aria-valuetext') !== '70%') throw new Error('图谱缩放滑杆没有同步百分比');
  const graphViewportAfter = await page.evaluate(() => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const cy = controller.getCytoscape();
    const pan = { ...cy.pan() };
    const zoom = cy.zoom();
    const center = { x: cy.container().clientWidth / 2, y: cy.container().clientHeight / 2 };
    return {
      positions: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { ...node.position() }])),
      sizes: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { type: node.data('type'), width: node.width(), height: node.height() }])),
      renderedSizes: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { width: node.renderedWidth(), height: node.renderedHeight() }])),
      labels: Object.fromEntries(cy.nodes(':visible').map((node) => [node.id(), { label: node.data('label'), canvasLabel: node.data('canvasLabel') }])),
      centerModel: { x: (center.x - pan.x) / zoom, y: (center.y - pan.y) / zoom },
      pan,
      zoom,
      nodeCount: cy.nodes().length,
      edgeCount: cy.edges().length,
      layoutStarts: window.__MY_SCHOLAR_GRAPH_SCALE_LAYOUTS__,
    };
  });
  const expectedZoomRatio = 0.7 / 0.85;
  for (const [id, before] of Object.entries(graphViewportBefore.sizes)) {
    const after = graphViewportAfter.sizes[id];
    if (!after || Math.abs(after.width - before.width) > 0.1 || Math.abs(after.height - before.height) > 0.1) throw new Error(`图谱缩放改变了节点模型尺寸：${id}`);
    const beforeRendered = graphViewportBefore.renderedSizes[id];
    const afterRendered = graphViewportAfter.renderedSizes[id];
    if (Math.abs(afterRendered.width / beforeRendered.width - expectedZoomRatio) > 0.015 || Math.abs(afterRendered.height / beforeRendered.height - expectedZoomRatio) > 0.015) throw new Error(`节点没有随视口整体缩放：${id}`);
    const beforePosition = graphViewportBefore.positions[id];
    const afterPosition = graphViewportAfter.positions[id];
    if (Math.hypot(afterPosition.x - beforePosition.x, afterPosition.y - beforePosition.y) > 0.1) throw new Error(`图谱缩放改变了节点位置：${id}`);
  }
  if (Math.abs(graphViewportAfter.zoom / graphViewportBefore.zoom - expectedZoomRatio) > 0.01) throw new Error('图谱缩放没有改变整体视口倍率');
  if (Math.hypot(graphViewportAfter.centerModel.x - graphViewportBefore.centerModel.x, graphViewportAfter.centerModel.y - graphViewportBefore.centerModel.y) > 0.1) throw new Error('图谱缩放没有围绕画布中心进行');
  if (graphViewportAfter.layoutStarts || graphViewportAfter.nodeCount !== graphViewportBefore.nodeCount || graphViewportAfter.edgeCount !== graphViewportBefore.edgeCount) throw new Error('图谱缩放重跑了布局或改变了图结构');
  if (JSON.stringify(graphViewportAfter.labels) !== JSON.stringify(graphViewportBefore.labels)) throw new Error('图谱缩放改变了节点标题');
  const storedViewportPreferences = await page.evaluate(() => JSON.parse(localStorage.getItem('my-scholar-graph-preferences-v2') || '{}'));
  if (storedViewportPreferences.viewportScale !== 0.7 || Object.prototype.hasOwnProperty.call(storedViewportPreferences, 'nodeScale')) throw new Error(`图谱缩放偏好写入异常：${JSON.stringify(storedViewportPreferences)}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#recent-list .library-row').first().waitFor();
  await exposeGraphController();
  await graphEntry.click();
  await page.locator('#library-graph-surface:not([hidden])').waitFor();
  await page.waitForFunction((paperCount) => document.querySelectorAll('#graph-accessible-list button[data-graph-node-id^="paper:"]').length === paperCount, fixture.papers.length);
  if (!(await similarityToggle.isChecked())) throw new Error('重新加载后没有恢复用户开启的内容相似虚线');
  await page.waitForFunction((similarityEdgeCount) => window.__MY_SCHOLAR_GRAPH_CONTROLLER__?.getCytoscape?.().edges('[type = "similarity"]').length === similarityEdgeCount, fixture.similarityEdgeCount);
  if (await graphZoomSlider.inputValue() !== '70' || (await page.locator('#graph-zoom-value').textContent()).trim() !== '70%') throw new Error('重新加载后没有恢复图谱缩放');
  if (await page.evaluate(() => window.__MY_SCHOLAR_GRAPH_CONTROLLER__?.getConfig?.().viewportScale) !== 0.7) throw new Error('重新加载后图谱没有应用视口缩放');
  const reloadedZoom = await page.evaluate(() => window.__MY_SCHOLAR_GRAPH_CONTROLLER__.getCytoscape().zoom());
  await graphZoomSlider.focus();
  await graphZoomSlider.press('Home');
  for (let index = 0; index < 5; index += 1) await graphZoomSlider.press('ArrowRight');
  await page.waitForFunction(() => window.__MY_SCHOLAR_GRAPH_CONTROLLER__?.getConfig?.().viewportScale === 0.85);
  const restoredZoom = await page.evaluate(() => window.__MY_SCHOLAR_GRAPH_CONTROLLER__.getCytoscape().zoom());
  if (Math.abs(restoredZoom / reloadedZoom - 0.85 / 0.7) > 0.01) throw new Error('刷新后恢复的图谱缩放没有真实作用于视口');
  const wideGraphViewport = await page.evaluate(async () => {
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', left: '-3000px', top: '0', width: '800px', height: '400px', visibility: 'hidden' });
    document.body.append(host);
    const controller = window.MyScholarGraphView.create({
      container: host,
      graph: {
        nodes: [
          { data: { id: 'paper:wide-left', type: 'paper', label: '左侧文献' }, position: { x: 0, y: 200 } },
          { data: { id: 'paper:wide-right', type: 'paper', label: '右侧文献' }, position: { x: 8000, y: 200 } },
        ],
        edges: [{ data: { id: 'similarity:wide', source: 'paper:wide-left', target: 'paper:wide-right', type: 'similarity', score: 0.5 } }],
      },
      config: { layout: 'preset', autoFit: true, viewportScale: 0.85, theme: 'light' },
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cy = controller.getCytoscape();
    const baseZoom = cy.getFitViewport(cy.elements(':visible'), controller.getConfig().fitPadding).zoom;
    const initialZoom = cy.zoom();
    controller.setViewportScale(0.6);
    const reducedZoom = cy.zoom();
    const result = { baseZoom, initialZoom, reducedZoom, minZoom: cy.minZoom() };
    controller.destroy();
    host.remove();
    return result;
  });
  if (wideGraphViewport.baseZoom >= 0.18 || Math.abs(wideGraphViewport.initialZoom / wideGraphViewport.baseZoom - 0.85) > 0.01 || Math.abs(wideGraphViewport.reducedZoom / wideGraphViewport.initialZoom - 0.6 / 0.85) > 0.01) throw new Error(`大图缩放在旧最小倍率附近失效：${JSON.stringify(wideGraphViewport)}`);
  const stats = (await page.locator('#graph-stats').textContent()).trim();
  if (!stats.includes(`${fixture.papers.length} 篇`) || !stats.includes(`${fixture.edgeCount} 条连接`)) throw new Error(`图谱统计异常：${stats}`);
  if (await page.locator('#graph-similarity-threshold, #graph-similarity-threshold-value, .graph-threshold-control').count()) throw new Error('面向用户的相似度阈值控件仍然存在');
  if (await page.locator('#library-graph-canvas canvas').count() < 1) throw new Error('Cytoscape 画布没有创建');
  if ((await page.locator('.graph-drag-hint').textContent()).trim() !== '拖动节点整理关系 · 悬浮文献查看完整标题') throw new Error('图谱缺少节点拖动与标题悬浮提示');
  const graphPointerIsolation = await page.evaluate(() => {
    const canvas = document.querySelector('#library-graph-canvas');
    if (!canvas) return { marquee: false, selectedRows: 0 };
    const init = { bubbles: true, cancelable: true, pointerId: 91, pointerType: 'mouse', button: 0, clientX: 180, clientY: 180 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', init));
    document.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: 520, clientY: 420 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: 520, clientY: 420 }));
    return {
      marquee: Boolean(document.querySelector('.library-selection-marquee')),
      selectedRows: document.querySelectorAll('.library-row.is-selected').length,
    };
  });
  if (graphPointerIsolation.marquee || graphPointerIsolation.selectedRows) throw new Error(`图谱拖动事件泄漏到列表框选：${JSON.stringify(graphPointerIsolation)}`);
  const lightBackground = await page.locator('.graph-stage').evaluate((node) => getComputedStyle(node).backgroundImage);
  if (!lightBackground.includes('gradient')) throw new Error('浅色主题图谱背景没有应用');

  const magneticMotion = await page.evaluate(async () => {
    const host = document.createElement('div');
    Object.assign(host.style, {
      position: 'fixed', left: '-2000px', top: '0', width: '800px', height: '520px', visibility: 'hidden',
    });
    document.body.append(host);
    const controller = window.MyScholarGraphView.create({
      container: host,
      graph: {
        nodes: [
          { data: { id: 'attribute:topic', type: 'attribute', label: '大模型', propertyId: 'research_topic' }, position: { x: 320, y: 250 } },
          { data: { id: 'paper:direct-a', type: 'paper', label: '直接关联 A' }, position: { x: 190, y: 190 } },
          { data: { id: 'paper:direct-b', type: 'paper', label: '直接关联 B' }, position: { x: 200, y: 330 } },
          { data: { id: 'paper:two-hop', type: 'paper', label: '二跳相似节点' }, position: { x: 70, y: 190 } },
          { data: { id: 'paper:isolated', type: 'paper', label: '无关节点' }, position: { x: 650, y: 410 } },
        ],
        edges: [
          { data: { id: 'property:a', source: 'attribute:topic', target: 'paper:direct-a', type: 'property' } },
          { data: { id: 'property:b', source: 'attribute:topic', target: 'paper:direct-b', type: 'property' } },
          { data: { id: 'similarity:two-hop', source: 'paper:direct-a', target: 'paper:two-hop', type: 'similarity', score: 0.8 } },
        ],
      },
      config: { layout: 'preset', autoFit: false, theme: 'light' },
    });
    const cy = controller.getCytoscape();
    cy.zoom(1);
    cy.pan({ x: 0, y: 0 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const nodeIds = ['attribute:topic', 'paper:direct-a', 'paper:direct-b', 'paper:two-hop', 'paper:isolated'];
    const snapshot = () => Object.fromEntries(nodeIds.map((id) => [id, { ...cy.getElementById(id).position() }]));
    const baseline = snapshot();
    const panBefore = { ...cy.pan() };
    const zoomBefore = cy.zoom();
    const anchor = cy.getElementById('attribute:topic');
    anchor.emit('grabon');
    anchor.position({ x: baseline['attribute:topic'].x + 120, y: baseline['attribute:topic'].y + 70 });
    anchor.emit('drag');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const during = snapshot();
    const activeClasses = {
      anchor: anchor.hasClass('graph-anchor-dragging'),
      followers: cy.nodes('.graph-anchor-follower').length,
      edges: cy.edges('.graph-anchor-edge').length,
    };
    const activeStyles = {
      anchorBorderWidth: Number.parseFloat(anchor.style('border-width')),
      followerOverlayOpacities: [...new Set(cy.nodes('.graph-anchor-follower').map((node) => Number.parseFloat(node.style('overlay-opacity'))))],
      edges: cy.edges('.graph-anchor-edge').map((edge) => ({
        id: edge.id(),
        baseWidth: Number(edge.data('renderWidth')),
        expectedDragWidth: Number(edge.data('dragRenderWidth')),
        dragWidth: Number.parseFloat(edge.style('width')),
      })),
    };
    anchor.emit('freeon');
    const releaseAnchor = { ...anchor.position() };
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 2500;
      const check = () => {
        if (!cy.nodes('.graph-anchor-follower').length) { resolve(); return; }
        if (performance.now() >= deadline) { reject(new Error('局部吸附动画没有按时结束')); return; }
        requestAnimationFrame(check);
      };
      check();
    });
    const final = snapshot();
    const result = {
      baseline,
      during,
      final,
      releaseAnchor,
      activeClasses,
      activeStyles,
      panBefore,
      panAfter: { ...cy.pan() },
      zoomBefore,
      zoomAfter: cy.zoom(),
      remainingMotionClasses: cy.elements('.graph-anchor-dragging, .graph-anchor-follower, .graph-anchor-edge').length,
    };
    controller.destroy();
    host.remove();
    return result;
  });
  const displacement = (positions, baseline, id) => ({
    x: positions[id].x - baseline[id].x,
    y: positions[id].y - baseline[id].y,
  });
  const anchorDuring = displacement(magneticMotion.during, magneticMotion.baseline, 'attribute:topic');
  if (Math.abs(anchorDuring.x - 120) > 0.5 || Math.abs(anchorDuring.y - 70) > 0.5) throw new Error(`属性锚点没有停在拖动位置：${JSON.stringify(anchorDuring)}`);
  for (const id of ['paper:direct-a', 'paper:direct-b']) {
    const during = displacement(magneticMotion.during, magneticMotion.baseline, id);
    const final = displacement(magneticMotion.final, magneticMotion.baseline, id);
    if (during.x < 50 || during.y < 28 || during.x >= anchorDuring.x || during.y >= anchorDuring.y) throw new Error(`直接关联文献没有柔性跟随：${id} ${JSON.stringify(during)}`);
    if (final.x <= during.x || final.y <= during.y || final.x >= anchorDuring.x || final.y >= anchorDuring.y) throw new Error(`直接关联文献没有在松手后继续收敛：${id} ${JSON.stringify({ during, final })}`);
  }
  for (const id of ['paper:two-hop', 'paper:isolated']) {
    const during = displacement(magneticMotion.during, magneticMotion.baseline, id);
    const final = displacement(magneticMotion.final, magneticMotion.baseline, id);
    if (Math.hypot(during.x, during.y) > 0.5 || Math.hypot(final.x, final.y) > 0.5) throw new Error(`非直接关联节点被误移动：${id} ${JSON.stringify({ during, final })}`);
  }
  if (!magneticMotion.activeClasses.anchor || magneticMotion.activeClasses.followers !== 2 || magneticMotion.activeClasses.edges !== 2) throw new Error(`拖动反馈状态异常：${JSON.stringify(magneticMotion.activeClasses)}`);
  if (Math.abs(magneticMotion.activeStyles.anchorBorderWidth - 2) > 0.01) throw new Error(`拖动节点边框不够精细：${JSON.stringify(magneticMotion.activeStyles)}`);
  if (magneticMotion.activeStyles.followerOverlayOpacities.length !== 1 || magneticMotion.activeStyles.followerOverlayOpacities[0] !== 0) throw new Error(`跟随节点仍显示覆盖方框：${JSON.stringify(magneticMotion.activeStyles)}`);
  for (const edge of magneticMotion.activeStyles.edges) {
    if (Math.abs(edge.dragWidth - edge.expectedDragWidth) > 0.01
      || edge.dragWidth + 0.01 < edge.baseWidth
      || edge.dragWidth - edge.baseWidth > 0.41
      || (edge.baseWidth < 1.9 && edge.dragWidth > 1.91)) throw new Error(`拖动关系线宽度异常：${JSON.stringify(edge)}`);
    if (Math.abs(edge.baseWidth - 1.35) < 0.01 && Math.abs(edge.dragWidth - 1.75) > 0.01) throw new Error(`属性关系线拖动强调不是精确增加 0.4px：${JSON.stringify(edge)}`);
  }
  if (magneticMotion.releaseAnchor.x !== magneticMotion.final['attribute:topic'].x || magneticMotion.releaseAnchor.y !== magneticMotion.final['attribute:topic'].y) throw new Error('松手后属性锚点发生了二次位移');
  if (magneticMotion.panBefore.x !== magneticMotion.panAfter.x || magneticMotion.panBefore.y !== magneticMotion.panAfter.y || magneticMotion.zoomBefore !== magneticMotion.zoomAfter) throw new Error('局部吸附意外改变了画布平移或缩放');
  if (magneticMotion.remainingMotionClasses) throw new Error('局部吸附完成后仍残留交互样式');

  const paperMotionSetup = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'graph-paper-motion-fixture';
    Object.assign(host.style, {
      position: 'fixed', left: '20px', top: '20px', width: '800px', height: '520px', zIndex: '10000',
      border: '1px solid #d7dce2', background: '#ffffff', overflow: 'hidden',
    });
    document.body.append(host);
    const longTitle = 'A Complete Paper Title for Hover Verification with Unique Tail HOVER-TAIL-9A7C';
    const controller = window.MyScholarGraphView.create({
      container: host,
      graph: {
        nodes: [
          { data: { id: 'paper:drag-anchor', type: 'paper', label: longTitle, title: longTitle, importance: 0 }, position: { x: 300, y: 260 } },
          { data: { id: 'paper:similar-high', type: 'paper', label: '高相似文献', importance: 5 }, position: { x: 150, y: 200 } },
          { data: { id: 'paper:similar-low', type: 'paper', label: '低相似文献', importance: 0 }, position: { x: 160, y: 340 } },
          { data: { id: 'paper:two-hop', type: 'paper', label: '二跳相似文献', importance: 0 }, position: { x: 60, y: 200 } },
          { data: { id: 'attribute:property-only', type: 'attribute', label: '属性邻居' }, position: { x: 300, y: 80 } },
          { data: { id: 'paper:blocker', type: 'paper', label: '排斥测试节点', importance: 0 }, position: { x: 445, y: 330 } },
          { data: { id: 'paper:isolated', type: 'paper', label: '远处孤立节点', importance: 0 }, position: { x: 700, y: 430 } },
        ],
        edges: [
          { data: { id: 'similarity:high', source: 'paper:drag-anchor', target: 'paper:similar-high', type: 'similarity', score: 0.8 } },
          { data: { id: 'similarity:low', source: 'paper:drag-anchor', target: 'paper:similar-low', type: 'similarity', score: 0.1 } },
          { data: { id: 'similarity:two-hop', source: 'paper:similar-high', target: 'paper:two-hop', type: 'similarity', score: 0.6 } },
          { data: { id: 'property:paper', source: 'paper:drag-anchor', target: 'attribute:property-only', type: 'property' } },
        ],
      },
      config: { layout: 'preset', autoFit: false, theme: 'light' },
    });
    const cy = controller.getCytoscape();
    cy.zoom(1);
    cy.pan({ x: 0, y: 0 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const ids = ['paper:drag-anchor', 'paper:similar-high', 'paper:similar-low', 'paper:two-hop', 'attribute:property-only', 'paper:blocker', 'paper:isolated'];
    const snapshot = () => Object.fromEntries(ids.map((id) => [id, { ...cy.getElementById(id).position() }]));
    const anchor = cy.getElementById('paper:drag-anchor');
    const rect = host.getBoundingClientRect();
    const rendered = anchor.renderedPosition();
    window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__ = { host, controller, ids, snapshot };
    return {
      longTitle,
      compactLabel: anchor.data('canvasLabel'),
      point: { x: rect.left + rendered.x, y: rect.top + rendered.y },
      emptyPoint: { x: rect.left + 780, y: rect.top + 20 },
      baseline: snapshot(),
      pan: { ...cy.pan() },
      zoom: cy.zoom(),
      sizes: {
        lowPaper: anchor.width(),
        highPaper: cy.getElementById('paper:similar-high').width(),
        attributeWidth: cy.getElementById('attribute:property-only').width(),
        attributeHeight: cy.getElementById('attribute:property-only').height(),
      },
    };
  });
  if (paperMotionSetup.compactLabel.includes('HOVER-TAIL-9A7C')) throw new Error('画布短标题没有正确省略尾部标记');
  if (paperMotionSetup.sizes.lowPaper < 31 || paperMotionSetup.sizes.highPaper > 36 || paperMotionSetup.sizes.highPaper <= paperMotionSetup.sizes.lowPaper) throw new Error(`文献节点模型尺寸异常：${JSON.stringify(paperMotionSetup.sizes)}`);
  if (paperMotionSetup.sizes.attributeWidth > 40 || paperMotionSetup.sizes.attributeHeight > 20) throw new Error(`属性节点模型尺寸异常：${JSON.stringify(paperMotionSetup.sizes)}`);

  const selectedEdgeStyle = await page.evaluate(async () => {
    const fixture = window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
    const cy = fixture.controller.getCytoscape();
    const propertyEdge = cy.getElementById('property:paper');
    const highSimilarityEdge = cy.getElementById('similarity:high');
    const propertyBaseWidth = Number.parseFloat(propertyEdge.style('width'));
    const untouchedBefore = Number.parseFloat(highSimilarityEdge.style('width'));
    propertyEdge.emit('tap');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const result = {
      propertyBaseWidth,
      propertySelectedWidth: Number.parseFloat(propertyEdge.style('width')),
      propertyExpectedWidth: Number(propertyEdge.data('selectedRenderWidth')),
      untouchedBefore,
      untouchedAfter: Number.parseFloat(highSimilarityEdge.style('width')),
      dimmedOpacity: Number.parseFloat(cy.getElementById('paper:isolated').style('opacity')),
      selected: propertyEdge.selected(),
      focused: propertyEdge.hasClass('graph-focused'),
    };
    fixture.controller.clearSelection({ notify: false });
    result.highSimilarityBaseWidth = Number.parseFloat(highSimilarityEdge.style('width'));
    highSimilarityEdge.emit('tap');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    result.highSimilaritySelectedWidth = Number.parseFloat(highSimilarityEdge.style('width'));
    fixture.controller.clearSelection({ notify: false });
    return result;
  });
  if (!selectedEdgeStyle.selected || !selectedEdgeStyle.focused) throw new Error(`点击连线后没有进入选中强调状态：${JSON.stringify(selectedEdgeStyle)}`);
  if (Math.abs(selectedEdgeStyle.propertyBaseWidth - 1.35) > 0.01
    || Math.abs(selectedEdgeStyle.propertySelectedWidth - selectedEdgeStyle.propertyExpectedWidth) > 0.01
    || selectedEdgeStyle.propertySelectedWidth <= selectedEdgeStyle.propertyBaseWidth
    || selectedEdgeStyle.propertySelectedWidth > 2.2) throw new Error(`选中连线的加粗幅度不够精细：${JSON.stringify(selectedEdgeStyle)}`);
  if (Math.abs(selectedEdgeStyle.untouchedAfter - selectedEdgeStyle.untouchedBefore) > 0.01) throw new Error(`选中连线意外改变了其他连线宽度：${JSON.stringify(selectedEdgeStyle)}`);
  if (Math.abs(selectedEdgeStyle.dimmedOpacity - 0.18) > 0.01) throw new Error(`背景弱化透明度异常：${JSON.stringify(selectedEdgeStyle)}`);
  if (selectedEdgeStyle.highSimilaritySelectedWidth + 0.01 < selectedEdgeStyle.highSimilarityBaseWidth) throw new Error(`高权重相似连线在选中后反而变细：${JSON.stringify(selectedEdgeStyle)}`);

  await page.mouse.move(paperMotionSetup.point.x, paperMotionSetup.point.y);
  const paperTooltip = page.locator('[data-graph-node-tooltip][data-graph-node-id="paper:drag-anchor"]');
  await paperTooltip.waitFor({ state: 'visible' });
  if ((await paperTooltip.textContent()).trim() !== paperMotionSetup.longTitle) throw new Error('悬浮浮层没有显示完整文章标题');
  const tooltipFont = await paperTooltip.evaluate((node) => getComputedStyle(node).fontFamily);
  const tooltipReaderFont = await page.locator('html').evaluate((node) => getComputedStyle(node).getPropertyValue('--reader-content-font-family'));
  if (normalizeFontFamily(tooltipFont) !== normalizeFontFamily(tooltipReaderFont)) throw new Error('悬浮完整标题没有跟随阅读器字体');
  await page.mouse.move(paperMotionSetup.emptyPoint.x, paperMotionSetup.emptyPoint.y);
  await paperTooltip.waitFor({ state: 'hidden' });

  await page.mouse.move(paperMotionSetup.point.x, paperMotionSetup.point.y);
  await page.mouse.down();
  await page.mouse.move(paperMotionSetup.point.x + 120, paperMotionSetup.point.y + 70, { steps: 8 });
  const paperMotionDuring = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const fixture = window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
    const cy = fixture.controller.getCytoscape();
    return {
      positions: fixture.snapshot(),
      classes: {
        anchor: cy.getElementById('paper:drag-anchor').hasClass('graph-anchor-dragging'),
        followers: cy.nodes('.graph-anchor-follower').length,
        edges: cy.edges('.graph-anchor-edge').length,
      },
      styles: {
        anchorBorderWidth: Number.parseFloat(cy.getElementById('paper:drag-anchor').style('border-width')),
        followerOverlayOpacities: [...new Set(cy.nodes('.graph-anchor-follower').map((node) => Number.parseFloat(node.style('overlay-opacity'))))],
        edges: cy.edges('.graph-anchor-edge').map((edge) => ({
          id: edge.id(),
          baseWidth: Number(edge.data('renderWidth')),
          expectedDragWidth: Number(edge.data('dragRenderWidth')),
          dragWidth: Number.parseFloat(edge.style('width')),
        })),
      },
    };
  });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const fixture = window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
    const cy = fixture?.controller?.getCytoscape?.();
    return cy && !cy.elements('.graph-anchor-dragging, .graph-anchor-follower, .graph-anchor-edge, .graph-local-motion').length;
  });
  const paperMotionFinal = await page.evaluate(() => {
    const fixture = window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
    const cy = fixture.controller.getCytoscape();
    return {
      positions: fixture.snapshot(),
      pan: { ...cy.pan() },
      zoom: cy.zoom(),
      edgeWidths: Object.fromEntries(cy.edges().map((edge) => [edge.id(), {
        baseWidth: Number(edge.data('renderWidth')),
        width: Number.parseFloat(edge.style('width')),
      }])),
    };
  });
  const paperAnchorDelta = displacement(paperMotionDuring.positions, paperMotionSetup.baseline, 'paper:drag-anchor');
  const highSimilarityDelta = displacement(paperMotionFinal.positions, paperMotionSetup.baseline, 'paper:similar-high');
  const lowSimilarityDelta = displacement(paperMotionFinal.positions, paperMotionSetup.baseline, 'paper:similar-low');
  if (Math.abs(paperAnchorDelta.x - 120) > 2 || Math.abs(paperAnchorDelta.y - 70) > 2) throw new Error(`真实鼠标没有拖动文献锚点：${JSON.stringify(paperAnchorDelta)}`);
  if (highSimilarityDelta.x <= lowSimilarityDelta.x || highSimilarityDelta.y <= lowSimilarityDelta.y || lowSimilarityDelta.x <= 0 || lowSimilarityDelta.y <= 0) throw new Error(`相似度没有正确控制文献牵引：${JSON.stringify({ highSimilarityDelta, lowSimilarityDelta })}`);
  for (const id of ['paper:two-hop', 'attribute:property-only', 'paper:isolated']) {
    const delta = displacement(paperMotionFinal.positions, paperMotionSetup.baseline, id);
    if (Math.hypot(delta.x, delta.y) > 1) throw new Error(`非直接相似邻居被误牵引：${id} ${JSON.stringify(delta)}`);
  }
  const blockerBefore = paperMotionSetup.baseline['paper:blocker'];
  const blockerAfter = paperMotionFinal.positions['paper:blocker'];
  const anchorAfter = paperMotionFinal.positions['paper:drag-anchor'];
  if (Math.hypot(blockerAfter.x - blockerBefore.x, blockerAfter.y - blockerBefore.y) < 5) throw new Error('文献节点靠近时没有触发局部排斥');
  if (Math.hypot(blockerAfter.x - anchorAfter.x, blockerAfter.y - anchorAfter.y) <= Math.hypot(blockerBefore.x - anchorAfter.x, blockerBefore.y - anchorAfter.y)) throw new Error('局部排斥没有增加节点间距');
  if (!paperMotionDuring.classes.anchor || paperMotionDuring.classes.followers !== 2 || paperMotionDuring.classes.edges !== 2) throw new Error(`文献拖动反馈状态异常：${JSON.stringify(paperMotionDuring.classes)}`);
  if (Math.abs(paperMotionDuring.styles.anchorBorderWidth - 2) > 0.01) throw new Error(`文献拖动节点边框宽度异常：${JSON.stringify(paperMotionDuring.styles)}`);
  if (paperMotionDuring.styles.followerOverlayOpacities.length !== 1 || paperMotionDuring.styles.followerOverlayOpacities[0] !== 0) throw new Error(`文献跟随节点仍显示覆盖方框：${JSON.stringify(paperMotionDuring.styles)}`);
  for (const edge of paperMotionDuring.styles.edges) {
    if (Math.abs(edge.dragWidth - edge.expectedDragWidth) > 0.01
      || edge.dragWidth + 0.01 < edge.baseWidth
      || edge.dragWidth - edge.baseWidth > 0.41
      || (edge.baseWidth < 1.9 && edge.dragWidth > 1.91)) throw new Error(`文献拖动关系线宽度异常：${JSON.stringify(edge)}`);
  }
  const highDragEdge = paperMotionDuring.styles.edges.find((edge) => edge.id === 'similarity:high');
  if (!highDragEdge || highDragEdge.baseWidth <= 1.9 || highDragEdge.dragWidth + 0.01 < highDragEdge.baseWidth) throw new Error(`高权重连线拖动时被意外变细：${JSON.stringify(highDragEdge)}`);
  const lowDragEdge = paperMotionDuring.styles.edges.find((edge) => edge.id === 'similarity:low');
  if (!lowDragEdge || Math.abs(lowDragEdge.dragWidth - lowDragEdge.baseWidth - 0.4) > 0.01) throw new Error(`低权重连线拖动强调不是精确增加 0.4px：${JSON.stringify(lowDragEdge)}`);
  for (const [id, edge] of Object.entries(paperMotionFinal.edgeWidths)) {
    if (Math.abs(edge.width - edge.baseWidth) > 0.01) throw new Error(`松开后连线没有恢复原宽度：${id} ${JSON.stringify(edge)}`);
  }
  if (paperMotionFinal.pan.x !== paperMotionSetup.pan.x || paperMotionFinal.pan.y !== paperMotionSetup.pan.y || paperMotionFinal.zoom !== paperMotionSetup.zoom) throw new Error('文献局部力场意外改变了画布视口');
  await page.mouse.move(paperMotionSetup.emptyPoint.x, paperMotionSetup.emptyPoint.y);
  const topHoverPoint = await page.evaluate(() => {
    const fixture = window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
    const cy = fixture.controller.getCytoscape();
    const anchor = cy.getElementById('paper:drag-anchor');
    anchor.position({ x: 400, y: 20 });
    const rendered = anchor.renderedPosition();
    const rect = fixture.host.getBoundingClientRect();
    return { x: rect.left + rendered.x, y: rect.top + rendered.y };
  });
  await page.mouse.move(topHoverPoint.x, topHoverPoint.y);
  await paperTooltip.waitFor({ state: 'visible' });
  const topTooltipPlacement = await page.evaluate(() => {
    const fixture = window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
    const tooltip = fixture.host.querySelector('[data-graph-node-tooltip]');
    const hostRect = fixture.host.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    return {
      below: tooltip.classList.contains('graph-node-tooltip-below'),
      clippedTop: tooltipRect.top < hostRect.top - 0.5,
      clippedBottom: tooltipRect.bottom > hostRect.bottom + 0.5,
    };
  });
  if (!topTooltipPlacement.below || topTooltipPlacement.clippedTop || topTooltipPlacement.clippedBottom) throw new Error(`顶部标题浮层没有自动翻转：${JSON.stringify(topTooltipPlacement)}`);
  await page.mouse.move(paperMotionSetup.emptyPoint.x, paperMotionSetup.emptyPoint.y);
  await paperTooltip.waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    const fixture = window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
    fixture.controller.destroy();
    fixture.host.remove();
    delete window.__MY_SCHOLAR_PAPER_MOTION_FIXTURE__;
  });

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const reducedMotionDrift = await page.evaluate(async () => {
    const host = document.createElement('div');
    Object.assign(host.style, {
      position: 'fixed', left: '-2000px', top: '0', width: '500px', height: '360px', visibility: 'hidden',
    });
    document.body.append(host);
    const controller = window.MyScholarGraphView.create({
      container: host,
      graph: {
        nodes: [
          { data: { id: 'attribute:reduced', type: 'attribute', label: '研究主题', propertyId: 'research_topic' }, position: { x: 260, y: 180 } },
          { data: { id: 'paper:reduced', type: 'paper', label: '关联文献' }, position: { x: 140, y: 180 } },
        ],
        edges: [
          { data: { id: 'property:reduced', source: 'attribute:reduced', target: 'paper:reduced', type: 'property' } },
        ],
      },
      config: { layout: 'preset', autoFit: false, theme: 'light' },
    });
    const cy = controller.getCytoscape();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const anchor = cy.getElementById('attribute:reduced');
    const follower = cy.getElementById('paper:reduced');
    const before = { ...follower.position() };
    anchor.emit('grabon');
    anchor.position({ x: anchor.position('x') + 100, y: anchor.position('y') + 50 });
    anchor.emit('drag');
    anchor.emit('freeon');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = { ...follower.position() };
    const motionClasses = cy.elements('.graph-anchor-dragging, .graph-anchor-follower, .graph-anchor-edge').length;
    controller.destroy();
    host.remove();
    return { x: after.x - before.x, y: after.y - before.y, motionClasses };
  });
  if (Math.hypot(reducedMotionDrift.x, reducedMotionDrift.y) > 0.5 || reducedMotionDrift.motionClasses) throw new Error(`减少动态效果下仍触发磁性跟随：${JSON.stringify(reducedMotionDrift)}`);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  await page.locator('.graph-accessible-results > summary').click();
  const allNodes = page.locator('#graph-accessible-list button');
  const paperNodes = allNodes.filter({ hasText: '文献：' });
  const attributeNodes = allNodes.filter({ hasText: '属性：' });
  if (await paperNodes.count() !== fixture.papers.length) throw new Error(`论文节点数量异常：${await paperNodes.count()}`);
  if (await attributeNodes.count() !== fixture.attributeCount) throw new Error(`默认属性节点数量异常：${await attributeNodes.count()}，预期 ${fixture.attributeCount}`);

  const matchingPapers = (paper) => fixture.papers.filter((candidate) => candidate.searchText.includes(paper.title.normalize('NFKC').toLocaleLowerCase())).length;
  const target = fixture.papers.find((paper) => paper.completed && paper.connectionCount > 0 && matchingPapers(paper) === 1)
    || fixture.papers.find((paper) => paper.completed && paper.connectionCount > 0)
    || fixture.papers.find((paper) => paper.completed && matchingPapers(paper) === 1)
    || fixture.papers.find((paper) => paper.completed)
    || fixture.papers.find((paper) => paper.connectionCount > 0)
    || fixture.papers[0];
  const targetNode = page.locator(`#graph-accessible-list button[data-graph-node-id=${JSON.stringify(`paper:${target.id}`)}]`);
  const normalizedQuery = target.title.normalize('NFKC').toLocaleLowerCase();
  const expectedSearchIds = fixture.papers.filter((paper) => paper.searchText.includes(normalizedQuery)).map((paper) => `paper:${paper.id}`).sort();
  await page.locator('#graph-search').fill(target.title);
  await page.waitForFunction((expectedIds) => {
    const visibleIds = [...document.querySelectorAll('#graph-accessible-list button[data-graph-node-id^="paper:"]')].map((node) => node.dataset.graphNodeId).sort();
    return JSON.stringify(visibleIds) === JSON.stringify(expectedIds);
  }, expectedSearchIds);
  if (!(await targetNode.count())) throw new Error(`图谱搜索没有保留目标文献：${target.title}`);
  await page.locator('#graph-search').fill('__图谱回归_无匹配_9d7f__');
  await page.waitForFunction(() => document.querySelectorAll('#graph-accessible-list button[data-graph-node-id^="paper:"]').length === 0);
  await page.locator('#graph-search').fill('');
  await page.waitForFunction((paperCount) => document.querySelectorAll('#graph-accessible-list button[data-graph-node-id^="paper:"]').length === paperCount, fixture.papers.length);

  await page.locator('#graph-toggle-attributes').uncheck();
  await page.waitForFunction(() => [...document.querySelectorAll('#graph-accessible-list button')].every((node) => !node.textContent.startsWith('属性：')));
  await page.locator('#graph-toggle-attributes').check();
  await page.waitForFunction((attributeCount) => [...document.querySelectorAll('#graph-accessible-list button')].filter((node) => node.textContent.startsWith('属性：')).length === attributeCount, fixture.attributeCount);
  await similarityToggle.uncheck();
  await page.waitForFunction(() => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const preferences = JSON.parse(localStorage.getItem('my-scholar-graph-preferences-v2') || '{}');
    return controller?.getConfig?.().showSimilarity === false
      && preferences.showSimilarity === false;
  });
  const disabledSimilarityState = await page.evaluate(() => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    return {
      similarityEdges: controller.getCytoscape().edges('[type = "similarity"]').length,
      stats: document.querySelector('#graph-stats')?.textContent || '',
    };
  });
  if (disabledSimilarityState.similarityEdges !== 0 || !disabledSimilarityState.stats.includes(`${fixture.propertyEdgeCount} 条连接`)) throw new Error(`关闭内容相似后图谱没有同步：${JSON.stringify(disabledSimilarityState)}`);
  await similarityToggle.check();
  await page.waitForFunction(({ similarityEdgeCount, edgeCount }) => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    const preferences = JSON.parse(localStorage.getItem('my-scholar-graph-preferences-v2') || '{}');
    return controller?.getConfig?.().showSimilarity === true
      && controller?.getCytoscape?.().edges('[type = "similarity"]').length === similarityEdgeCount
      && preferences.showSimilarity === true
      && document.querySelector('#graph-stats')?.textContent.includes(`${edgeCount} 条连接`);
  }, { similarityEdgeCount: fixture.similarityEdgeCount, edgeCount: fixture.edgeCount });
  const storedGraphPreferences = await page.evaluate(() => JSON.parse(localStorage.getItem('my-scholar-graph-preferences-v2') || '{}'));
  if (Object.prototype.hasOwnProperty.call(storedGraphPreferences, 'similarityThreshold')) throw new Error('旧版相似度阈值仍被持久化');
  if (storedGraphPreferences.showSimilarity !== true || storedGraphPreferences.viewportScale !== 0.85 || Object.prototype.hasOwnProperty.call(storedGraphPreferences, 'nodeScale')) throw new Error('图谱偏好没有与其他设置一起保存');

  await targetNode.click();
  const detailsTitle = page.locator('#library-details h2');
  await detailsTitle.filter({ hasText: target.title }).waitFor();
  if ((await detailsTitle.textContent()).trim() !== target.title) throw new Error('右侧详情没有保留完整标题');
  const targetAccessibilityLabel = await targetNode.getAttribute('aria-label');
  if (!targetAccessibilityLabel?.includes(target.title)) throw new Error('无障碍节点没有保留完整标题');
  if (target.connectionCount > 0 && await page.locator('#library-details .graph-connection-card').count() < 1) throw new Error('文献详情没有解释图谱连接');

  const nextImportance = target.importance === 5 ? 4 : 5;
  const patchedLibrary = JSON.parse(JSON.stringify(fixture.library));
  patchedLibrary.items[target.id].values ||= {};
  patchedLibrary.items[target.id].values.importance = nextImportance;
  const itemRoute = `**/api/library/items/${target.id}`;
  await page.route(itemRoute, async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ library: patchedLibrary }) });
  });
  await page.locator(`#library-details [data-details-importance="${nextImportance}"]`).click();
  await page.locator(`#library-details [data-details-importance="${nextImportance}"][aria-checked="true"]`).waitFor();
  await page.locator('#library-details h2').filter({ hasText: target.title }).waitFor();
  await page.unroute(itemRoute);

  let readerOpen = false;
  if (target.completed) {
    await targetNode.dblclick();
    await page.locator('#reader-view.active-view').waitFor();
    await page.locator('[data-view="library-view"]').click();
    await page.locator('#library-graph-surface:not([hidden])').waitFor();
    readerOpen = true;
  }

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await page.waitForTimeout(100);
  const darkBackground = await page.locator('.graph-stage').evaluate((node) => getComputedStyle(node).backgroundImage);
  if (!darkBackground.includes('gradient')) throw new Error('深色主题图谱背景没有应用');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  const mobileLayout = await page.evaluate(() => {
    const toolbar = document.querySelector('.graph-toolbar')?.getBoundingClientRect();
    const zoomControl = document.querySelector('.graph-zoom-control')?.getBoundingClientRect();
    const zoomSlider = document.querySelector('#graph-zoom')?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      stageWidth: document.querySelector('.graph-stage')?.getBoundingClientRect().width || 0,
      zoomControlInsideToolbar: Boolean(toolbar && zoomControl && zoomControl.left >= toolbar.left - 0.5 && zoomControl.right <= toolbar.right + 0.5),
      zoomSliderTouchHeight: zoomSlider?.height || 0,
    };
  });
  if (mobileLayout.scrollWidth > mobileLayout.innerWidth + 1 || mobileLayout.stageWidth > mobileLayout.innerWidth || !mobileLayout.zoomControlInsideToolbar || mobileLayout.zoomSliderTouchHeight < 44) throw new Error(`窄窗口图谱控件布局异常：${JSON.stringify(mobileLayout)}`);

  const legacyPage = await browserSession.browser.newPage({ viewport: { width: 1200, height: 800 } });
  await legacyPage.addInitScript(() => {
    localStorage.removeItem('my-scholar-graph-preferences-v2');
    localStorage.setItem('my-scholar-graph-preferences-v1', JSON.stringify({
      showSimilarity: true,
      showAttributes: true,
      attributeIds: null,
      nodeScale: 0.75,
    }));
    window.__MY_SCHOLAR_TEST__ = true;
  });
  await legacyPage.goto(baseURL, { waitUntil: 'networkidle' });
  await legacyPage.locator('#recent-list .library-row').first().waitFor();
  await legacyPage.evaluate(() => {
    const graphView = window.MyScholarGraphView;
    window.MyScholarGraphView = Object.freeze({
      ...graphView,
      create: (...args) => {
        const controller = graphView.create(...args);
        if (args[0]?.container?.id === 'library-graph-canvas') window.__MY_SCHOLAR_GRAPH_CONTROLLER__ = controller;
        return controller;
      },
    });
  });
  await legacyPage.locator('[data-library-mode="graph"]').click();
  await legacyPage.locator('#library-graph-surface:not([hidden])').waitFor();
  await legacyPage.waitForFunction(() => {
    const controller = window.__MY_SCHOLAR_GRAPH_CONTROLLER__;
    return controller?.getConfig?.().viewportScale === 0.75
      && controller.getConfig().showSimilarity === false
      && controller.getCytoscape().edges('[type = "similarity"]').length === 0;
  });
  const legacySimilarityToggle = legacyPage.getByRole('switch', { name: '内容相似' });
  if (await legacySimilarityToggle.isChecked()) throw new Error('旧版开启状态被错误迁移，内容相似虚线没有采用新的默认关闭值');
  const legacyZoomSlider = legacyPage.getByRole('slider', { name: '图谱缩放' });
  if (await legacyZoomSlider.inputValue() !== '75') throw new Error('上一版节点比例没有迁移为图谱缩放');
  await legacyZoomSlider.press('ArrowRight');
  await legacyPage.waitForFunction(() => window.__MY_SCHOLAR_GRAPH_CONTROLLER__?.getConfig?.().viewportScale === 0.8);
  const migratedPreferences = await legacyPage.evaluate(() => ({
    current: JSON.parse(localStorage.getItem('my-scholar-graph-preferences-v2') || '{}'),
    legacy: JSON.parse(localStorage.getItem('my-scholar-graph-preferences-v1') || '{}'),
  }));
  if (migratedPreferences.current.viewportScale !== 0.8
    || migratedPreferences.current.showSimilarity !== false
    || Object.prototype.hasOwnProperty.call(migratedPreferences.current, 'nodeScale')) throw new Error(`旧图谱偏好没有完成字段迁移：${JSON.stringify(migratedPreferences)}`);
  if (migratedPreferences.legacy.nodeScale !== 0.75 || migratedPreferences.legacy.showSimilarity !== true) throw new Error(`迁移过程覆盖了可回滚的旧偏好：${JSON.stringify(migratedPreferences)}`);
  await legacyPage.close();

  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ graphEntry: true, stats, papers: fixture.papers.length, attributeNodes: true, similarityDefaultOff: true, similarityPreference: true, refinedEdgeSelection: true, magneticMotion: true, paperMotion: true, localRepulsion: true, hoverTitle: true, search: target.title, details: true, detailRefresh: true, readerOpen, lightTheme: true, darkTheme: true, mobileLayout, legacyPreferenceMigration: true }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await browserSession?.close();
  } catch (error) {
    console.error(`Failed to close graph smoke browser: ${error.message}`);
    process.exitCode = 1;
  }
});
