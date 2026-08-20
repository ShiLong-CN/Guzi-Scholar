((root, factory) => {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MyScholarGraphView = api;
})(typeof window !== 'undefined' ? window : globalThis, (root) => {
  const DEFAULT_CONFIG = Object.freeze({
    includeSimilarity: true,
    similarityThreshold: 0,
    topK: 2,
    searchMode: 'hide',
    fitPadding: 72,
    viewportScale: 0.85,
    fontFamily: '"Times New Roman", Times, "Songti SC", STSong, "Noto Serif CJK SC", serif',
  });

  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const text = (value) => String(value ?? '').trim();
  const normalizedSearchText = (value) => text(value).normalize('NFKC').toLocaleLowerCase();

  function normalizeViewportScale(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_CONFIG.viewportScale;
    return Math.min(1.3, Math.max(0.6, numeric));
  }

  function normalizeFontFamily(value) {
    return text(value) || DEFAULT_CONFIG.fontFamily;
  }

  function magneticFollowerStrength(data, phase = 'drag') {
    const propertyId = text(data?.propertyId || data?.attributeKind || data?.kind);
    const researchTopic = propertyId === 'research_topic';
    if (phase === 'release') return researchTopic ? 0.72 : 0.46;
    return researchTopic ? 0.58 : 0.34;
  }

  function magneticFollowerPosition(start, delta, strength) {
    return {
      x: Number(start?.x || 0) + Number(delta?.x || 0) * strength,
      y: Number(start?.y || 0) + Number(delta?.y || 0) * strength,
    };
  }

  function similarityFollowerStrength(score, phase = 'drag') {
    const value = clamp(score, 0, 1);
    if (phase === 'release') return clamp(0.28 + value, 0.28, 0.48);
    return clamp(0.18 + value * 0.9, 0.18, 0.36);
  }

  function localRepulsionTargets(nodes, {
    anchorId,
    activeIds = [],
    influenceRadius = 145,
    gap = 10,
    maxDisplacement = 18,
    iterations = 3,
    maxNodes = 48,
  } = {}) {
    const normalized = (Array.isArray(nodes) ? nodes : []).filter((node) => (
      node?.id && Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.radius)
    )).map((node) => ({ ...node, radius: Math.max(1, node.radius) }));
    const active = new Set([anchorId, ...activeIds].filter(Boolean));
    const anchor = normalized.find((node) => node.id === anchorId);
    const sources = [anchor, ...normalized.filter((node) => active.has(node.id) && node.id !== anchorId)].filter(Boolean);
    if (!sources.length) return {};
    const passiveLimit = Math.max(0, Math.floor(maxNodes));
    const passiveCandidates = [];
    if (passiveLimit && influenceRadius > 0) {
      const cellSize = Math.max(1, influenceRadius);
      const bucketKey = (x, y) => `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
      const buckets = new Map();
      normalized.forEach((node) => {
        if (active.has(node.id)) return;
        const key = bucketKey(node.x, node.y);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(node);
      });
      const candidateDistances = new Map();
      const candidateBufferLimit = passiveLimit;
      for (const source of sources) {
        const cellX = Math.floor(source.x / cellSize);
        const cellY = Math.floor(source.y / cellSize);
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const bucket = buckets.get(`${cellX + offsetX}:${cellY + offsetY}`) || [];
            for (const node of bucket) {
              const distance = Math.hypot(node.x - source.x, node.y - source.y);
              if (distance > influenceRadius) continue;
              const previous = candidateDistances.get(node.id);
              if (previous) {
                if (distance < previous.distance) candidateDistances.set(node.id, { node, distance });
                continue;
              }
              if (candidateDistances.size >= candidateBufferLimit) {
                const farthest = [...candidateDistances.entries()].reduce((current, entry) => {
                  if (!current || entry[1].distance > current[1].distance) return entry;
                  if (entry[1].distance === current[1].distance && entry[0].localeCompare(current[0]) > 0) return entry;
                  return current;
                }, null);
                if (!farthest || distance > farthest[1].distance || (distance === farthest[1].distance && node.id.localeCompare(farthest[0]) >= 0)) continue;
                candidateDistances.delete(farthest[0]);
              }
              candidateDistances.set(node.id, { node, distance });
            }
          }
        }
      }
      passiveCandidates.push(...[...candidateDistances.values()]
        .sort((left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id))
        .slice(0, passiveLimit)
        .map(({ node }) => node));
    }
    const ranked = [...sources, ...passiveCandidates];
    const positions = new Map(ranked.map((node) => [node.id, { x: node.x, y: node.y }]));
    const origins = new Map(ranked.map((node) => [node.id, { x: node.x, y: node.y }]));
    const mobility = (node) => {
      if (node.locked || node.id === anchorId) return 0;
      return active.has(node.id) ? 0.42 : 1;
    };
    for (let pass = 0; pass < iterations; pass += 1) {
      const shifts = new Map(ranked.map((node) => [node.id, { x: 0, y: 0 }]));
      const largestRadius = ranked.reduce((largest, node) => Math.max(largest, node.radius), 1);
      const collisionCellSize = Math.max(1, largestRadius * 2 + gap);
      const collisionBuckets = new Map();
      ranked.forEach((node, index) => {
        const position = positions.get(node.id);
        const key = `${Math.floor(position.x / collisionCellSize)}:${Math.floor(position.y / collisionCellSize)}`;
        if (!collisionBuckets.has(key)) collisionBuckets.set(key, []);
        collisionBuckets.get(key).push(index);
      });
      for (let leftIndex = 0; leftIndex < ranked.length; leftIndex += 1) {
        const left = ranked[leftIndex];
        const leftPosition = positions.get(left.id);
        const cellX = Math.floor(leftPosition.x / collisionCellSize);
        const cellY = Math.floor(leftPosition.y / collisionCellSize);
        const overlaps = [];
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const nearby = collisionBuckets.get(`${cellX + offsetX}:${cellY + offsetY}`) || [];
            for (const rightIndex of nearby) {
              if (rightIndex <= leftIndex) continue;
              const right = ranked[rightIndex];
              const rightPosition = positions.get(right.id);
              const dx = rightPosition.x - leftPosition.x;
              const dy = rightPosition.y - leftPosition.y;
              const distance = Math.hypot(dx, dy);
              const minimum = left.radius + right.radius + gap;
              if (distance < minimum) overlaps.push({ rightIndex, dx, dy, distance, minimum });
            }
          }
        }
        overlaps.sort((leftPair, rightPair) => leftPair.distance - rightPair.distance || leftPair.rightIndex - rightPair.rightIndex)
          .slice(0, 24)
          .forEach(({ rightIndex, dx: rawDx, dy: rawDy, distance: rawDistance, minimum }) => {
              const right = ranked[rightIndex];
              let dx = rawDx;
              let dy = rawDy;
              let distance = rawDistance;
              if (distance < 0.001) {
                dx = left.id.localeCompare(right.id) <= 0 ? 1 : -1;
                dy = 0;
                distance = 1;
              }
              const leftMobility = mobility(left);
              const rightMobility = mobility(right);
              const totalMobility = leftMobility + rightMobility;
              if (!totalMobility) return;
              const force = Math.min(12, (minimum - distance) * 0.72);
              const unitX = dx / distance;
              const unitY = dy / distance;
              const leftShare = force * leftMobility / totalMobility;
              const rightShare = force * rightMobility / totalMobility;
              shifts.get(left.id).x -= unitX * leftShare;
              shifts.get(left.id).y -= unitY * leftShare;
              shifts.get(right.id).x += unitX * rightShare;
              shifts.get(right.id).y += unitY * rightShare;
          });
      }
      ranked.forEach((node) => {
        if (!mobility(node)) return;
        const current = positions.get(node.id);
        const origin = origins.get(node.id);
        const shift = shifts.get(node.id);
        let x = current.x + shift.x;
        let y = current.y + shift.y;
        const moved = Math.hypot(x - origin.x, y - origin.y);
        if (moved > maxDisplacement) {
          const scale = maxDisplacement / moved;
          x = origin.x + (x - origin.x) * scale;
          y = origin.y + (y - origin.y) * scale;
        }
        positions.set(node.id, { x, y });
      });
    }
    return Object.fromEntries(positions);
  }

  function glyphUnits(character) {
    if (/^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/u.test(character)) return 2;
    if (character === ' ') return 0.55;
    return /^[MW@#%&]$/u.test(character) ? 1.25 : 1;
  }

  function fittingCharacterCount(characters, budget) {
    let used = 0;
    let count = 0;
    while (count < characters.length) {
      const width = glyphUnits(characters[count]);
      if (used + width > budget) break;
      used += width;
      count += 1;
    }
    return count;
  }

  function compactCanvasLabel(value, { lineUnits = 18, maxLines = 2 } = {}) {
    const content = text(value).replace(/\s+/gu, ' ');
    if (!content) return '';
    const remaining = [...content];
    const lines = [];
    while (remaining.length && lines.length < maxLines) {
      if (fittingCharacterCount(remaining, lineUnits) === remaining.length) {
        lines.push(remaining.join('').trim());
        break;
      }
      const finalLine = lines.length === maxLines - 1;
      const fitted = Math.max(1, fittingCharacterCount(remaining, lineUnits - (finalLine ? 1 : 0)));
      let splitAt = fitted;
      for (let index = fitted - 1; index > 0; index -= 1) {
        if (remaining[index] === ' ') { splitAt = index; break; }
      }
      const line = remaining.splice(0, Math.max(1, splitAt)).join('').trim();
      while (remaining[0] === ' ') remaining.shift();
      lines.push(finalLine ? `${line}…` : line);
      if (finalLine) break;
    }
    return lines.join('\n');
  }

  function resolveElement(value, documentRef) {
    if (!value) return null;
    if (typeof value === 'string') return documentRef?.querySelector(value) || null;
    return value;
  }

  function paperColor(status) {
    const value = normalizedSearchText(status);
    if (value.includes('完成') || value.includes('complete')) return '#3c956f';
    if (value.includes('阅读') || value.includes('reading')) return '#d18d29';
    return '#7b8796';
  }

  function normalizeNode(node, index) {
    const source = node?.data || node || {};
    const id = text(source.id) || `graph-node-${index + 1}`;
    const inferredType = source.type || (source.kind === 'attribute' ? 'attribute' : 'paper');
    const type = inferredType === 'attribute' ? 'attribute' : 'paper';
    const label = text(source.label || source.title || source.value) || (type === 'paper' ? '未命名文献' : '未设置');
    const importance = clamp(source.importance, 0, 5);
    const defaultSize = type === 'paper' ? 31 + importance : 38;
    const requestedSize = Number(source.size);
    const size = type === 'paper'
      ? clamp(Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : defaultSize, 31, 36)
      : clamp(Number.isFinite(requestedSize) && requestedSize > 0 ? requestedSize : defaultSize, 36, 40);
    const data = {
      ...source,
      id,
      type,
      label,
      canvasLabel: compactCanvasLabel(label, type === 'paper' ? { lineUnits: 16, maxLines: 2 } : { lineUnits: 12, maxLines: 1 }),
      importance,
      size,
      color: text(source.color) || (type === 'paper' ? paperColor(source.readingStatus) : '#fff3dc'),
      searchText: normalizedSearchText(source.searchText || [label, source.title, source.authors, source.venue, source.year, source.propertyLabel, source.value].flat().join(' ')),
    };
    const result = { data };
    if (node?.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)) result.position = { ...node.position };
    if (node?.classes) result.classes = node.classes;
    return result;
  }

  function normalizeEdge(edge, index, nodeIds) {
    const source = edge?.data || edge || {};
    const from = text(source.source);
    const to = text(source.target);
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) return null;
    const type = source.type === 'property' || source.kind === 'property' ? 'property' : 'similarity';
    const score = clamp(source.score ?? source.weight, 0, 1);
    const reasons = Array.isArray(source.reasons) ? source.reasons.map(text).filter(Boolean) : [];
    const renderWidth = type === 'similarity' ? 0.9 + score * 2.6 : 1.35;
    return {
      data: {
        ...source,
        id: text(source.id) || `graph-edge-${index + 1}`,
        source: from,
        target: to,
        type,
        score,
        reasons,
        label: text(source.label || source.propertyLabel) || (type === 'similarity' ? '内容相似' : '属性关系'),
        renderWidth,
        dragRenderWidth: Math.max(renderWidth, Math.min(1.9, renderWidth + 0.4)),
        selectedRenderWidth: Math.max(renderWidth, Math.min(2.6, renderWidth + 0.8)),
      },
    };
  }

  function normalizeGraph(graph) {
    const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).map(normalizeNode);
    const nodeIds = new Set(nodes.map((node) => node.data.id));
    const edges = (Array.isArray(graph?.edges) ? graph.edges : [])
      .map((edge, index) => normalizeEdge(edge, index, nodeIds))
      .filter(Boolean);
    const paperCount = nodes.filter((node) => node.data.type === 'paper').length;
    const attributeCount = nodes.length - paperCount;
    return {
      nodes,
      edges,
      stats: { paperCount, attributeCount, edgeCount: edges.length, ...(graph?.stats || {}) },
      config: { ...(graph?.config || {}) },
    };
  }

  function create(options = {}) {
    const documentRef = options.document || root?.document;
    const container = resolveElement(options.container, documentRef);
    if (!container || !documentRef) throw new TypeError('MyScholarGraphView.create 需要有效的 container。');

    const listElement = resolveElement(options.listElement || options.accessibilityList, documentRef);
    const summaryElement = resolveElement(options.summaryElement || options.accessibilitySummary, documentRef);
    const canvasElement = documentRef.createElement('div');
    canvasElement.className = 'library-graph-canvas';
    canvasElement.setAttribute('aria-hidden', 'true');
    canvasElement.style.width = '100%';
    canvasElement.style.height = '100%';

    const statusElement = documentRef.createElement('div');
    statusElement.className = 'library-graph-status';
    statusElement.setAttribute('role', 'status');
    const statusTitle = documentRef.createElement('strong');
    statusTitle.className = 'library-graph-status-title';
    const statusMessage = documentRef.createElement('span');
    statusMessage.className = 'library-graph-status-message';
    statusElement.append(statusTitle, statusMessage);
    statusElement.hidden = true;
    const tooltipElement = documentRef.createElement('div');
    tooltipElement.className = 'graph-node-tooltip';
    tooltipElement.dataset.graphNodeTooltip = '';
    tooltipElement.setAttribute('role', 'tooltip');
    tooltipElement.setAttribute('aria-hidden', 'true');
    tooltipElement.hidden = true;
    container.append(canvasElement, statusElement, tooltipElement);

    const state = {
      config: {
        ...DEFAULT_CONFIG,
        ...(options.config || {}),
        viewportScale: normalizeViewportScale(options.config?.viewportScale),
        fontFamily: normalizeFontFamily(options.config?.fontFamily),
      },
      library: options.library ?? null,
      sourceGraph: options.graph ?? null,
      graph: normalizeGraph({}),
      cy: null,
      layout: null,
      destroyed: false,
      selectedNodeId: null,
      selectedEdgeId: null,
      hoveredNodeId: null,
      searchQuery: '',
      nodeFilter: null,
      matchingPaperIds: [],
      lastNodeTap: { id: null, time: 0 },
      magneticDrag: null,
      magneticDragFrame: null,
      tooltipFrame: null,
      motionVersion: 0,
    };

    function reportError(error) {
      if (typeof options.onError !== 'function') return;
      try { options.onError(error); } catch (_) { /* Application callbacks must not break graph cleanup. */ }
    }

    function invoke(callback, value) {
      if (typeof callback !== 'function') return;
      try { callback(value); } catch (error) { reportError(error); }
    }

    function showStatus(title, message) {
      hideNodeTooltip();
      statusTitle.textContent = title;
      statusMessage.textContent = message;
      statusElement.hidden = false;
      canvasElement.hidden = true;
    }

    function hideStatus() {
      statusElement.hidden = true;
      canvasElement.hidden = false;
    }

    function isDarkTheme() {
      if (state.config.theme === 'dark') return true;
      if (state.config.theme === 'light') return false;
      return Boolean(root?.matchMedia?.('(prefers-color-scheme: dark)').matches);
    }

    function prefersReducedMotion() {
      return Boolean(root?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    }

    function graphStyles() {
      const dark = isDarkTheme();
      const textColor = dark ? '#e9edf2' : '#30363d';
      const mutedText = dark ? '#c8ced7' : '#5f6873';
      const attributeFill = dark ? '#40341f' : '#fff3dc';
      const attributeBorder = dark ? '#e2a94e' : '#b9791f';
      const propertyEdge = dark ? '#b8965d' : '#a98349';
      const similarityEdge = dark ? '#788392' : '#88919d';
      return [
        {
          selector: 'node',
          style: {
            label: 'data(canvasLabel)',
            'font-family': normalizeFontFamily(state.config.fontFamily),
            'font-size': 9,
            'font-weight': 500,
            color: textColor,
            'text-wrap': 'wrap',
            'text-max-width': 90,
            'text-valign': 'bottom',
            'text-margin-y': 5,
            'min-zoomed-font-size': 6,
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'node[type = "paper"]',
          style: {
            width: 'data(size)',
            height: 'data(size)',
            shape: 'ellipse',
            'background-color': 'data(color)',
            'border-width': 1.2,
            'border-color': dark ? '#f1b24f' : '#b66d12',
            'border-opacity': 0.94,
          },
        },
        {
          selector: 'node[type = "attribute"]',
          style: {
            width: 'data(size)',
            height: 20,
            shape: 'round-rectangle',
            'background-color': attributeFill,
            'border-width': 1.5,
            'border-color': attributeBorder,
            color: mutedText,
            'font-size': 8.5,
            'text-max-width': 48,
            'text-valign': 'center',
            'text-margin-y': 0,
            padding: 3,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 'data(renderWidth)',
            'curve-style': 'bezier',
            'line-cap': 'round',
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'edge[type = "property"]',
          style: { 'line-color': propertyEdge, 'line-style': 'solid', opacity: 0.72 },
        },
        {
          selector: 'edge[type = "similarity"]',
          style: { 'line-color': similarityEdge, 'line-style': 'dashed', opacity: 0.62 },
        },
        {
          selector: 'node:selected',
          style: { 'border-color': dark ? '#fff1d3' : '#7b4b0e', 'border-width': 3, opacity: 1 },
        },
        {
          selector: 'edge:selected',
          style: { 'line-color': attributeBorder, width: 'data(selectedRenderWidth)', opacity: 1 },
        },
        {
          selector: '.graph-dimmed',
          style: { opacity: 0.18, 'text-opacity': 0.18 },
        },
        {
          selector: '.graph-neighbor',
          style: { opacity: 0.92, 'text-opacity': 1 },
        },
        {
          selector: '.graph-focused',
          style: { opacity: 1, 'text-opacity': 1, 'z-index': 20 },
        },
        {
          selector: '.graph-search-match',
          style: { 'border-color': dark ? '#ffe2a5' : '#7b4b0e', 'border-width': 3, opacity: 1 },
        },
        {
          selector: '.graph-search-dim',
          style: { opacity: 0.17, 'text-opacity': 0.17 },
        },
        {
          selector: 'node.graph-anchor-dragging',
          style: {
            'border-color': dark ? '#fff1c9' : '#8f570f',
            'border-width': 2,
            'z-index': 30,
          },
        },
        {
          selector: 'node.graph-anchor-follower',
          style: {
            'overlay-opacity': 0,
            'z-index': 24,
          },
        },
        {
          selector: 'edge.graph-anchor-edge',
          style: {
            'line-color': dark ? '#f0b65b' : '#b56e15',
            width: 'data(dragRenderWidth)',
            opacity: 0.94,
            'z-index': 18,
          },
        },
        {
          selector: 'node.graph-local-motion',
          style: { 'z-index': 22 },
        },
      ];
    }

    function publicData(element) {
      const data = { ...element.data() };
      if (Array.isArray(data.reasons)) data.reasons = [...data.reasons];
      return data;
    }

    function clearElementClasses() {
      state.cy?.elements().removeClass('graph-dimmed graph-neighbor graph-focused');
    }

    function highlightNode(node) {
      const cy = state.cy;
      if (!cy || !node?.length || !node.visible()) { clearElementClasses(); return; }
      cy.elements().addClass('graph-dimmed');
      const neighborhood = node.closedNeighborhood();
      neighborhood.removeClass('graph-dimmed').addClass('graph-neighbor');
      node.removeClass('graph-neighbor').addClass('graph-focused');
    }

    function highlightEdge(edge) {
      const cy = state.cy;
      if (!cy || !edge?.length || !edge.visible()) { clearElementClasses(); return; }
      cy.elements().addClass('graph-dimmed');
      edge.removeClass('graph-dimmed').addClass('graph-focused');
      edge.connectedNodes().removeClass('graph-dimmed').addClass('graph-neighbor');
    }

    function restoreHighlight() {
      clearElementClasses();
      if (!state.cy) return;
      if (state.hoveredNodeId) {
        highlightNode(state.cy.getElementById(state.hoveredNodeId));
      } else if (state.selectedNodeId) {
        highlightNode(state.cy.getElementById(state.selectedNodeId));
      } else if (state.selectedEdgeId) {
        highlightEdge(state.cy.getElementById(state.selectedEdgeId));
      }
    }

    function clearSelection({ notify = true } = {}) {
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      state.hoveredNodeId = null;
      hideNodeTooltip();
      state.cy?.elements().unselect();
      restoreHighlight();
      if (notify) {
        invoke(options.onNodeSelect, null);
        invoke(options.onSelectEdge, null);
      }
    }

    function selectNode(node, { notify = true } = {}) {
      state.cy.elements().unselect();
      state.selectedEdgeId = null;
      state.selectedNodeId = node.id();
      node.select();
      restoreHighlight();
      if (notify) {
        invoke(options.onSelectEdge, null);
        invoke(options.onNodeSelect, publicData(node));
      }
    }

    function selectEdge(edge, { notify = true } = {}) {
      state.cy.elements().unselect();
      state.selectedNodeId = null;
      state.selectedEdgeId = edge.id();
      edge.select();
      restoreHighlight();
      if (notify) {
        invoke(options.onNodeSelect, null);
        invoke(options.onSelectEdge, publicData(edge));
      }
    }

    function hideNodeTooltip() {
      if (state.tooltipFrame != null) {
        root?.cancelAnimationFrame?.(state.tooltipFrame);
        state.tooltipFrame = null;
      }
      tooltipElement.hidden = true;
      tooltipElement.textContent = '';
      tooltipElement.classList.remove('graph-node-tooltip-below');
      tooltipElement.removeAttribute('data-graph-node-id');
      tooltipElement.setAttribute('aria-hidden', 'true');
    }

    function positionNodeTooltip() {
      state.tooltipFrame = null;
      const node = state.hoveredNodeId && state.cy?.getElementById(state.hoveredNodeId);
      if (!node?.length || !node.visible() || node.data('type') !== 'paper' || tooltipElement.hidden) return;
      const position = node.renderedPosition();
      const width = Math.max(1, container.clientWidth || canvasElement.clientWidth);
      const height = Math.max(1, container.clientHeight || canvasElement.clientHeight);
      const tooltipWidth = Math.min(width - 24, Math.max(1, tooltipElement.offsetWidth));
      const tooltipHeight = Math.max(1, tooltipElement.offsetHeight);
      const halfWidth = tooltipWidth / 2;
      const nodeHalfHeight = node.renderedOuterHeight() / 2;
      const aboveTop = position.y - nodeHalfHeight - 9;
      const placeBelow = aboveTop - tooltipHeight < 12;
      tooltipElement.classList.toggle('graph-node-tooltip-below', placeBelow);
      tooltipElement.style.left = `${clamp(position.x, halfWidth + 12, width - halfWidth - 12)}px`;
      tooltipElement.style.top = placeBelow
        ? `${clamp(position.y + nodeHalfHeight + 9, 12, Math.max(12, height - tooltipHeight - 12))}px`
        : `${aboveTop}px`;
    }

    function scheduleTooltipPosition() {
      if (state.tooltipFrame != null) return;
      if (typeof root?.requestAnimationFrame !== 'function') {
        positionNodeTooltip();
        return;
      }
      state.tooltipFrame = root.requestAnimationFrame(positionNodeTooltip);
    }

    function showNodeTooltip(node) {
      if (!node?.length || node.data('type') !== 'paper') { hideNodeTooltip(); return; }
      tooltipElement.textContent = text(node.data('label')) || '未命名文献';
      tooltipElement.dataset.graphNodeId = node.id();
      tooltipElement.hidden = false;
      tooltipElement.setAttribute('aria-hidden', 'false');
      scheduleTooltipPosition();
    }

    function cancelGraphMotion() {
      state.motionVersion += 1;
      if (state.magneticDragFrame != null) {
        root?.cancelAnimationFrame?.(state.magneticDragFrame);
        state.magneticDragFrame = null;
      }
      state.cy?.nodes('.graph-anchor-follower, .graph-local-motion').stop(true, false);
      state.cy?.elements().removeClass('graph-anchor-dragging graph-anchor-follower graph-anchor-edge graph-local-motion');
      state.magneticDrag = null;
    }

    function connectedFollowers(anchor) {
      const paperAnchor = anchor.data('type') === 'paper';
      const edgeType = paperAnchor ? 'similarity' : 'property';
      const edges = anchor.connectedEdges(`[type = "${edgeType}"]`).filter((edge) => edge.visible());
      const byId = new Map();
      edges.forEach((edge) => {
        const follower = edge.source().id() === anchor.id() ? edge.target() : edge.source();
        if (follower.data('type') !== 'paper' || !follower.visible() || follower.locked()) return;
        const score = paperAnchor ? clamp(edge.data('score'), 0, 1) : 0;
        const previous = byId.get(follower.id());
        if (!previous || score > previous.score) byId.set(follower.id(), { node: follower, score });
      });
      return { edges, followers: [...byId.values()] };
    }

    function magneticTargets(session, phase = 'drag') {
      const cy = state.cy;
      const anchor = cy?.getElementById(session.anchorId);
      if (!anchor?.length) return {};
      const current = anchor.position();
      const delta = {
        x: current.x - session.anchorStart.x,
        y: current.y - session.anchorStart.y,
      };
      const followers = new Map(session.followers.map((follower) => [follower.id, follower]));
      const targets = session.nodes.map((node) => {
        const follower = followers.get(node.id);
        if (node.id === session.anchorId) return { ...node, x: current.x, y: current.y };
        if (!follower) return { ...node, x: node.start.x, y: node.start.y };
        const strength = session.anchorData.type === 'paper'
          ? similarityFollowerStrength(follower.score, phase)
          : magneticFollowerStrength(session.anchorData, phase);
        const position = magneticFollowerPosition(node.start, delta, strength);
        return { ...node, x: position.x, y: position.y };
      });
      return localRepulsionTargets(targets, {
        anchorId: session.anchorId,
        activeIds: session.followers.map((follower) => follower.id),
      });
    }

    function applyMagneticMotion(phase = 'drag') {
      const session = state.magneticDrag;
      const cy = state.cy;
      if (!session || !cy) return {};
      const targets = magneticTargets(session, phase);
      cy.batch(() => {
        Object.entries(targets).forEach(([id, position]) => {
          if (id === session.anchorId) return;
          const node = cy.getElementById(id);
          if (node.length && node.visible() && !node.locked()) node.position(position);
        });
      });
      scheduleTooltipPosition();
      return targets;
    }

    function scheduleMagneticMotion() {
      if (!state.magneticDrag || state.magneticDragFrame != null) return;
      if (typeof root?.requestAnimationFrame !== 'function') {
        applyMagneticMotion();
        return;
      }
      state.magneticDragFrame = root.requestAnimationFrame(() => {
        state.magneticDragFrame = null;
        applyMagneticMotion();
      });
    }

    function beginMagneticDrag(anchor) {
      cancelGraphMotion();
      stopLayout();
      if (prefersReducedMotion()) return;
      const { edges, followers } = connectedFollowers(anchor);
      followers.forEach(({ node }) => node.stop(true, false).addClass('graph-anchor-follower'));
      edges.addClass('graph-anchor-edge');
      anchor.addClass('graph-anchor-dragging');
      state.magneticDrag = {
        anchorId: anchor.id(),
        anchorData: { ...anchor.data() },
        anchorStart: { ...anchor.position() },
        followers: followers.map(({ node, score }) => ({ id: node.id(), score })),
        nodes: state.cy.nodes(':visible').toArray().map((node) => ({
          id: node.id(),
          start: { ...node.position() },
          x: node.position('x'),
          y: node.position('y'),
          radius: Math.max(node.outerWidth(), node.outerHeight()) / 2,
          locked: node.locked(),
        })),
      };
    }

    function finishMagneticDrag(anchor) {
      const session = state.magneticDrag;
      if (!session || session.anchorId !== anchor.id()) return;
      if (state.magneticDragFrame != null) {
        root?.cancelAnimationFrame?.(state.magneticDragFrame);
        state.magneticDragFrame = null;
      }
      const targets = magneticTargets(session, 'release');
      const version = ++state.motionVersion;
      const reducedMotion = prefersReducedMotion();
      const followerIds = new Set(session.followers.map((follower) => follower.id));
      state.magneticDrag = null;
      anchor.removeClass('graph-anchor-dragging');
      state.cy?.edges('.graph-anchor-edge').removeClass('graph-anchor-edge');
      Object.entries(targets).forEach(([id, position]) => {
        if (id === session.anchorId) return;
        const node = state.cy?.getElementById(id);
        if (!node?.length) return;
        if (!node.visible() || node.locked()) {
          node.removeClass('graph-anchor-follower graph-local-motion');
          return;
        }
        const current = node.position();
        const moved = Math.hypot(position.x - current.x, position.y - current.y);
        if (moved < 0.05) {
          node.removeClass('graph-anchor-follower graph-local-motion');
          return;
        }
        node.addClass('graph-local-motion');
        if (reducedMotion || typeof node.animate !== 'function') {
          node.position(position).removeClass('graph-anchor-follower graph-local-motion');
          return;
        }
        node.stop(true, false).animate({ position }, {
          duration: 195,
          easing: 'ease-out',
          queue: false,
          complete: () => {
            if (state.motionVersion === version) node.removeClass('graph-anchor-follower graph-local-motion');
          },
        });
      });
      followerIds.forEach((id) => {
        if (!targets[id]) state.cy?.getElementById(id).removeClass('graph-anchor-follower');
      });
      scheduleTooltipPosition();
    }

    function bindGraphEvents() {
      const cy = state.cy;
      cy.on('grabon', 'node', (event) => beginMagneticDrag(event.target));
      cy.on('drag', 'node', scheduleMagneticMotion);
      cy.on('freeon', 'node', (event) => finishMagneticDrag(event.target));
      cy.on('tap', 'node', (event) => {
        const node = event.target;
        selectNode(node);
        const now = Date.now();
        if (node.data('type') === 'paper' && state.lastNodeTap.id === node.id() && now - state.lastNodeTap.time <= 360) {
          invoke(options.onPaperOpen, publicData(node));
          invoke(options.onNodeDoubleClick, publicData(node));
          state.lastNodeTap = { id: null, time: 0 };
        } else {
          state.lastNodeTap = { id: node.id(), time: now };
        }
      });
      cy.on('tap', 'edge', (event) => selectEdge(event.target));
      cy.on('tap', (event) => {
        if (event.target !== cy) return;
        clearSelection();
        invoke(options.onBackgroundClick, null);
      });
      cy.on('mouseover', 'node', (event) => {
        state.hoveredNodeId = event.target.id();
        showNodeTooltip(event.target);
        restoreHighlight();
      });
      cy.on('mouseout', 'node', (event) => {
        if (state.hoveredNodeId === event.target.id()) {
          state.hoveredNodeId = null;
          hideNodeTooltip();
        }
        restoreHighlight();
      });
      cy.on('pan zoom resize', scheduleTooltipPosition);
      cy.on('position', 'node', (event) => {
        if (state.hoveredNodeId === event.target.id()) scheduleTooltipPosition();
      });
    }

    function ensureCytoscape() {
      if (state.cy) return true;
      const cytoscapeFactory = options.cytoscape || root?.cytoscape;
      if (typeof cytoscapeFactory !== 'function') {
        showStatus('关系图谱组件尚未加载', '请重新加载页面，或检查本地 Cytoscape.js 资源是否可用。');
        return false;
      }
      try {
        state.cy = cytoscapeFactory({
          container: canvasElement,
          elements: [],
          style: graphStyles(),
          layout: { name: 'preset' },
          minZoom: 0.04,
          maxZoom: 3.5,
          boxSelectionEnabled: false,
          autoungrabify: false,
          autounselectify: false,
        });
        bindGraphEvents();
        return true;
      } catch (error) {
        showStatus('关系图谱无法启动', '图形渲染器初始化失败，请重新加载后再试。');
        reportError(error);
        return false;
      }
    }

    function stopLayout() {
      if (!state.layout) return;
      try { state.layout.stop(); } catch (_) { /* A completed Cytoscape layout may already be detached. */ }
      state.layout = null;
    }

    function layoutOptions() {
      const requested = state.config.layout;
      if (requested && typeof requested === 'object') return { ...requested };
      const testMode = options.testMode === true || state.config.testMode === true || root?.__MY_SCHOLAR_TEST__ === true;
      const hasPresetPositions = state.graph.nodes.length > 0 && state.graph.nodes.every((node) => node.position);
      if (requested === 'preset' || (testMode && hasPresetPositions)) return { name: 'preset', fit: false };
      if (requested === 'grid' || testMode) return { name: 'grid', fit: false, padding: state.config.fitPadding };
      return {
        name: requested === 'cose' || !requested ? 'cose' : requested,
        animate: !prefersReducedMotion(),
        fit: false,
        padding: state.config.fitPadding,
        nodeRepulsion: () => 4200,
        idealEdgeLength: (edge) => edge.data('type') === 'property' ? 58 : 78,
        edgeElasticity: () => 112,
        nestingFactor: 0.8,
        gravity: 0.46,
        numIter: 700,
        initialTemp: 120,
        coolingFactor: 0.95,
        minTemp: 1,
      };
    }

    function fit({ padding = state.config.fitPadding, animate = false } = {}) {
      if (!state.cy || state.destroyed || !state.cy.nodes(':visible').length) return false;
      state.cy.resize();
      const visibleElements = state.cy.elements(':visible');
      const baseViewport = state.cy.getFitViewport(visibleElements, padding);
      if (!baseViewport) return false;
      const baseZoom = Number(baseViewport.zoom);
      const targetZoom = clamp(baseZoom * normalizeViewportScale(state.config.viewportScale), state.cy.minZoom(), state.cy.maxZoom());
      const center = { x: canvasElement.clientWidth / 2, y: canvasElement.clientHeight / 2 };
      const ratio = baseZoom > 0 ? targetZoom / baseZoom : 1;
      const targetPan = {
        x: center.x - (center.x - baseViewport.pan.x) * ratio,
        y: center.y - (center.y - baseViewport.pan.y) * ratio,
      };
      state.cy.stop();
      if (animate && !prefersReducedMotion() && typeof state.cy.animate === 'function') {
        state.cy.animate({ zoom: targetZoom, pan: targetPan }, { duration: 220 });
      } else {
        state.cy.viewport({ zoom: targetZoom, pan: targetPan });
      }
      scheduleTooltipPosition();
      return true;
    }

    function runLayout() {
      stopLayout();
      if (!state.cy?.nodes().length) return;
      const layout = state.cy.layout(layoutOptions());
      state.layout = layout;
      layout.one('layoutstop', () => {
        if (state.layout !== layout) return;
        state.layout = null;
        if (state.config.autoFit !== false) fit();
      });
      layout.run();
    }

    function accessibilityLabel(data, degree) {
      if (data.type === 'paper') {
        const status = text(data.readingStatus);
        return `文献：${data.label}${status ? `，${status}` : ''}，${degree} 条连接`;
      }
      return `属性：${data.propertyLabel ? `${data.propertyLabel}，` : ''}${data.label}，${degree} 篇关联文献`;
    }

    function renderAccessibility() {
      if (!state.cy) {
        if (summaryElement) summaryElement.textContent = '关系图谱暂不可用';
        listElement?.replaceChildren();
        return;
      }
      const visibleNodes = state.cy.nodes(':visible').toArray().sort((left, right) => {
        if (left.data('type') !== right.data('type')) return left.data('type') === 'paper' ? -1 : 1;
        return text(left.data('label')).localeCompare(text(right.data('label')), 'zh-CN');
      });
      const visibleEdges = state.cy.edges(':visible').length;
      const paperCount = visibleNodes.filter((node) => node.data('type') === 'paper').length;
      const attributeCount = visibleNodes.length - paperCount;
      const summary = `${paperCount} 篇文献 · ${attributeCount} 个属性 · ${visibleEdges} 条连接`;
      if (summaryElement) summaryElement.textContent = summary;
      if (listElement) {
        const fragment = documentRef.createDocumentFragment();
        visibleNodes.forEach((node) => {
          const button = documentRef.createElement('button');
          button.type = 'button';
          button.className = 'graph-accessibility-node';
          button.dataset.graphNodeId = node.id();
          const label = accessibilityLabel(node.data(), node.connectedEdges(':visible').length);
          button.textContent = label;
          button.setAttribute('aria-label', label);
          button.addEventListener('click', () => focusNode(node.id(), { select: true, notify: true }));
          button.addEventListener('dblclick', () => {
            if (node.data('type') === 'paper') invoke(options.onPaperOpen, publicData(node));
          });
          fragment.append(button);
        });
        listElement.replaceChildren(fragment);
      }
      invoke(options.onAccessibilityUpdate, { summary, paperCount, attributeCount, edgeCount: visibleEdges });
    }

    function applyVisibility() {
      const cy = state.cy;
      if (!cy) return [];
      const query = normalizedSearchText(state.searchQuery);
      const allowed = new Set();
      cy.nodes().forEach((node) => {
        if (!state.nodeFilter || state.nodeFilter(publicData(node)) !== false) allowed.add(node.id());
      });

      const directMatches = new Set();
      if (query) {
        cy.nodes().forEach((node) => {
          if (allowed.has(node.id()) && normalizedSearchText(node.data('searchText') || node.data('label')).includes(query)) directMatches.add(node.id());
        });
      }

      const contextualMatches = new Set(directMatches);
      if (query) {
        directMatches.forEach((id) => {
          const node = cy.getElementById(id);
          node.connectedEdges('[type = "property"]').connectedNodes().forEach((neighbor) => {
            if (allowed.has(neighbor.id())) contextualMatches.add(neighbor.id());
          });
        });
      }

      const visible = query && state.config.searchMode === 'hide' ? contextualMatches : allowed;
      cy.nodes().forEach((node) => {
        const shouldShow = visible.has(node.id());
        if (shouldShow) node.show(); else node.hide();
        node.toggleClass('graph-search-match', query && directMatches.has(node.id()));
        node.toggleClass('graph-search-dim', Boolean(query) && state.config.searchMode !== 'hide' && !directMatches.has(node.id()));
      });
      cy.edges().forEach((edge) => {
        const shouldShow = visible.has(edge.source().id()) && visible.has(edge.target().id());
        if (shouldShow) edge.show(); else edge.hide();
      });

      const resultPapers = new Set();
      (query ? contextualMatches : visible).forEach((id) => {
        const node = cy.getElementById(id);
        if (node.data('type') === 'paper') resultPapers.add(text(node.data('jobId') || node.id()));
      });
      state.matchingPaperIds = [...resultPapers];

      const selectedNode = state.selectedNodeId && cy.getElementById(state.selectedNodeId);
      const selectedEdge = state.selectedEdgeId && cy.getElementById(state.selectedEdgeId);
      const hoveredNode = state.hoveredNodeId && cy.getElementById(state.hoveredNodeId);
      if (hoveredNode?.length && !hoveredNode.visible()) {
        state.hoveredNodeId = null;
        hideNodeTooltip();
      }
      if ((selectedNode?.length && !selectedNode.visible()) || (selectedEdge?.length && !selectedEdge.visible())) clearSelection();
      else restoreHighlight();
      renderAccessibility();
      return [...state.matchingPaperIds];
    }

    function buildGraphFromLibrary() {
      const builder = options.graphBuilder || root?.MyScholarGraphModel?.buildGraph;
      if (typeof builder !== 'function') {
        showStatus('关系数据模型尚未加载', '请重新加载页面，或检查本地 graph-model.js 资源。');
        return null;
      }
      try {
        return builder(state.library, state.config);
      } catch (error) {
        showStatus('关系图谱生成失败', '文献数据暂时无法转换为关系图谱。');
        reportError(error);
        return null;
      }
    }

    function render(input) {
      if (state.destroyed) return null;
      if (input && Array.isArray(input.nodes) && Array.isArray(input.edges)) {
        state.sourceGraph = input;
      } else if (input !== undefined) {
        state.library = input;
        state.sourceGraph = null;
      }

      const source = state.sourceGraph || (state.library != null ? buildGraphFromLibrary() : { nodes: [], edges: [] });
      if (!source) {
        renderAccessibility();
        return null;
      }
      state.graph = normalizeGraph(source);
      if (!state.graph.nodes.length) {
        cancelGraphMotion();
        hideNodeTooltip();
        stopLayout();
        state.cy?.elements().remove();
        showStatus('暂无可展示的关系', '可以为文献补充研究主题、来源或内容信息后再试。');
        renderAccessibility();
        return state.graph;
      }
      if (!ensureCytoscape()) {
        renderAccessibility();
        return state.graph;
      }

      hideStatus();
      cancelGraphMotion();
      hideNodeTooltip();
      stopLayout();
      state.cy.style(graphStyles());
      state.cy.batch(() => {
        state.cy.elements().remove();
        state.cy.add([...state.graph.nodes, ...state.graph.edges]);
      });
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      state.hoveredNodeId = null;
      applyVisibility();
      runLayout();
      return state.graph;
    }

    function setLibrary(library) {
      state.library = library;
      state.sourceGraph = null;
      return render();
    }

    function updateConfig(patch = {}) {
      state.config = { ...state.config, ...patch };
      state.config.viewportScale = normalizeViewportScale(state.config.viewportScale);
      state.config.fontFamily = normalizeFontFamily(state.config.fontFamily);
      return render();
    }

    function setViewportScale(value) {
      const previousScale = normalizeViewportScale(state.config.viewportScale);
      const viewportScale = normalizeViewportScale(value);
      if (previousScale === viewportScale) return viewportScale;
      state.config = { ...state.config, viewportScale };
      cancelGraphMotion();
      if (state.cy && !state.destroyed) {
        const center = { x: canvasElement.clientWidth / 2, y: canvasElement.clientHeight / 2 };
        const targetZoom = clamp(state.cy.zoom() * viewportScale / previousScale, state.cy.minZoom(), state.cy.maxZoom());
        state.cy.zoom({ level: targetZoom, renderedPosition: center });
        scheduleTooltipPosition();
      }
      return viewportScale;
    }

    function setFontFamily(value) {
      const fontFamily = normalizeFontFamily(value);
      if (state.config.fontFamily === fontFamily) return fontFamily;
      state.config = { ...state.config, fontFamily };
      if (state.cy && !state.destroyed) state.cy.style(graphStyles());
      scheduleTooltipPosition();
      return fontFamily;
    }

    function setSearch(query) {
      state.searchQuery = text(query);
      return applyVisibility();
    }

    function setNodeFilter(predicate) {
      if (predicate != null && typeof predicate !== 'function') throw new TypeError('setNodeFilter 需要函数或 null。');
      state.nodeFilter = predicate || null;
      return applyVisibility();
    }

    function focusNode(id, { animate = true, select = true, notify = true, zoom = 1.15 } = {}) {
      if (!state.cy || state.destroyed) return false;
      const requested = text(id);
      let node = state.cy.getElementById(requested);
      if (!node.length || !node.isNode()) {
        node = state.cy.nodes().filter((candidate) => text(candidate.data('jobId')) === requested).first();
      }
      if (!node?.length || !node.visible()) return false;
      if (select) selectNode(node, { notify });
      const targetZoom = Math.max(state.cy.zoom(), clamp(zoom, state.cy.minZoom(), state.cy.maxZoom()));
      if (animate && !prefersReducedMotion() && typeof state.cy.animate === 'function') {
        state.cy.animate({ center: { eles: node }, zoom: targetZoom }, { duration: 220 });
      } else {
        state.cy.center(node);
        state.cy.zoom({ level: targetZoom, renderedPosition: { x: canvasElement.clientWidth / 2, y: canvasElement.clientHeight / 2 } });
      }
      return true;
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      cancelGraphMotion();
      hideNodeTooltip();
      stopLayout();
      if (state.cy) {
        state.cy.removeAllListeners();
        state.cy.destroy();
        state.cy = null;
      }
      canvasElement.remove();
      statusElement.remove();
      tooltipElement.remove();
      if (options.clearAccessibilityOnDestroy !== false) {
        listElement?.replaceChildren();
        if (summaryElement) summaryElement.textContent = '';
      }
    }

    const controller = Object.freeze({
      setLibrary,
      render,
      updateConfig,
      setViewportScale,
      setFontFamily,
      destroy,
      fit,
      focusNode,
      search: setSearch,
      setSearch,
      setNodeFilter,
      clearSelection,
      getGraph: () => state.graph,
      getConfig: () => ({ ...state.config }),
      getMatchingPaperIds: () => [...state.matchingPaperIds],
      getCytoscape: () => state.cy,
    });

    if (options.graph || options.library) render();
    else showStatus('关系图谱等待数据', '加载文献库后，这里会展示属性和内容相似关系。');
    return controller;
  }

  return Object.freeze({
    create,
    normalizeGraph,
    compactCanvasLabel,
    magneticFollowerStrength,
    magneticFollowerPosition,
    similarityFollowerStrength,
    localRepulsionTargets,
    normalizeViewportScale,
  });
});
