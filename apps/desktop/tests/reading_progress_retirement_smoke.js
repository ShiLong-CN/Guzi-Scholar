const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';

(async () => {
  let browserSession;
  let page;
  let jobId;
  let originalStatus;
  const itemPatchBodies = [];
  try {
    browserSession = await launchManagedChromium();
    page = await browserSession.browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    page.on('request', (request) => {
      if (request.method() !== 'PATCH' || !/\/api\/library\/items\//u.test(request.url())) return;
      try { itemPatchBodies.push(JSON.parse(request.postData() || '{}')); } catch (_) { itemPatchBodies.push({ malformed: true }); }
    });

    await page.goto(baseURL, { waitUntil: 'networkidle' });
    const candidate = page.locator('#recent-list .library-row[data-status="completed"]').first();
    await candidate.waitFor();
    jobId = await candidate.getAttribute('data-job-id');
    const initial = await page.evaluate(async (id) => (await (await fetch('/api/library')).json()).library.items[id], jobId);
    originalStatus = initial.values?.reading_status || '未开始';
    const progressBefore = JSON.parse(JSON.stringify(initial.progress || {}));

    await page.evaluate(async (id) => {
      await fetch(`/api/library/items/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { reading_status: '未开始' } }),
      });
    }, jobId);
    await page.reload({ waitUntil: 'networkidle' });
    itemPatchBodies.length = 0;

    const row = page.locator(`#recent-list .library-row[data-job-id="${jobId}"]`);
    await row.waitFor();
    await row.locator('.library-row-name').click();
    const rowMeta = await row.locator('.library-row-name small').textContent();
    if (String(rowMeta || '').includes('%')) throw new Error(`文献行仍展示阅读进度：${rowMeta}`);
    if ((await page.locator('#library-details').textContent()).includes('阅读进度')) throw new Error('文献详情仍展示阅读进度字段');

    await row.locator('.library-row-name').dblclick();
    await page.locator('#reader-view.active-view').waitFor();
    await page.waitForFunction(async (id) => {
      const payload = await (await fetch('/api/library')).json();
      return payload.library.items[id].values?.reading_status === '阅读中';
    }, jobId);
    const frameBody = page.frameLocator('#html-preview').locator('body');
    await frameBody.waitFor();
    await frameBody.evaluate(() => window.scrollTo(0, 260));
    await page.waitForTimeout(700);
    await page.locator('[data-view="library-view"]').click();
    await page.locator('#library-view.active-view').waitFor();
    await page.waitForTimeout(600);

    const progressAfter = await page.evaluate(async (id) => (await (await fetch('/api/library')).json()).library.items[id].progress || {}, jobId);
    if (JSON.stringify(progressAfter) !== JSON.stringify(progressBefore)) throw new Error(`阅读器修改了已退役的进度数据：${JSON.stringify({ progressBefore, progressAfter })}`);
    const progressPatches = itemPatchBodies.filter((body) => Object.prototype.hasOwnProperty.call(body, 'progress'));
    if (progressPatches.length) throw new Error(`阅读器仍发送 progress PATCH：${JSON.stringify(progressPatches)}`);
    console.log(JSON.stringify({ readingStatusAdvanced: true, progressUIRemoved: true, progressDataPreserved: true, progressPatchCount: 0 }));
  } finally {
    if (page && jobId && originalStatus) {
      await page.evaluate(async ({ id, status }) => {
        await fetch(`/api/library/items/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: { reading_status: status } }),
        });
      }, { id: jobId, status: originalStatus }).catch(() => {});
    }
    await browserSession?.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
