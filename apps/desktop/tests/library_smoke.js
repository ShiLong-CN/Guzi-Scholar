const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
let browser;
let browserSession;

(async () => {
  browserSession = await launchManagedChromium();
  browser = browserSession.browser;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  const libraryItemPatchBodies = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('request', (request) => {
    if (request.method() !== 'PATCH' || !/\/api\/library\/items\//u.test(request.url())) return;
    try { libraryItemPatchBodies.push(JSON.parse(request.postData() || '{}')); } catch (_) { libraryItemPatchBodies.push({ malformed: true }); }
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator('.library-layout').waitFor();
  await page.locator('#recent-list .library-card').first().waitFor();
  if (await page.locator('.health-pill').count()) throw new Error('Library still exposes the removed service-health pill');
  if (await page.locator('#screenshot-translate-button').count()) throw new Error('Screenshot translation control still exists');
  if (await page.locator('#markdown-download').count()) throw new Error('Markdown download control still exists');

  const jobId = await page.locator('#recent-list .library-card').first().getAttribute('data-job-id');
  const folderResponse = await page.evaluate(async () => (await fetch('/api/library/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Smoke Folder ${Date.now()}` }) })).json());
  const folder = folderResponse.folder;
  if (!folder?.id) throw new Error('Folder API did not return a folder');
  const itemResponse = await page.evaluate(async ({ id, folderId }) => (await fetch(`/api/library/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_ids: [folderId], values: { reading_status: '阅读中' } }) })).json(), { id: jobId, folderId: folder.id });
  if (!itemResponse.library?.items?.[jobId]?.folder_ids?.includes(folder.id)) throw new Error('Document was not assigned to the custom folder');
  const viewResponse = await page.evaluate(async () => (await fetch('/api/library/views', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Smoke View ${Date.now()}`, filters: [{ field: 'reading_status', operator: 'equals', value: '阅读中' }] }) })).json());
  const view = viewResponse.view;
  if (!view?.id) throw new Error('Saved view API did not return a view');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`[data-library-folder="${folder.id}"]`).click();
  await page.locator(`#recent-list .library-card[data-job-id="${jobId}"]`).waitFor();
  const status = (await page.locator(`#recent-list .library-card[data-job-id="${jobId}"] .row-status`).textContent()).trim();
  if (status !== '阅读中') throw new Error(`Reading status was not rendered (${status})`);
  await page.locator('#manage-views-button').click();
  await page.locator(`#saved-views-list [data-view-id="${view.id}"]`).waitFor();
  await page.locator(`#saved-views-list [data-view-id="${view.id}"]`).click();
  await page.locator('#views-view.active-view').waitFor();
  if (!(await page.locator(`#saved-views-list [data-view-id="${view.id}"]`).evaluate((node) => node.classList.contains('active')))) throw new Error('Selecting a saved view did not preserve its active state');
  if ((await page.locator('#view-editor-title').textContent()).trim() !== view.name) throw new Error('Selecting a saved view did not render its editor');
  if (await page.locator('.nav-button.active').count()) throw new Error('View management painted an unrelated primary-navigation underline');
  await page.locator('#view-results .library-card').first().waitFor();
  const progressBefore = await page.evaluate(async (id) => (await (await fetch('/api/library')).json()).library.items[id].progress, jobId);
  libraryItemPatchBodies.length = 0;
  await page.locator('#view-results .library-card').first().locator('.library-row-name').dblclick();
  await page.locator('#reader-view.active-view').waitFor();
  await page.locator('#reader-sidebar.is-open').waitFor();
  if (await page.locator('.nav-button.active').count()) throw new Error('Reader mode painted a primary-navigation underline alongside the active document tab');
  if (await page.locator('.nav-button.active').count()) throw new Error('Reader mode painted a second active underline in the primary navigation');
  if (await page.locator('.document-tab.active').evaluate((node) => getComputedStyle(node, '::after').height) === '0px') throw new Error('The active document tab has no visible underline');
  const readerGridColumns = await page.locator('.reader-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  if (!/^.+px\s+.+px$/u.test(readerGridColumns)) throw new Error(`Reader and assistant are not rendered as two columns (${readerGridColumns})`);
  if (await page.locator('#screenshot-translate-button').count()) throw new Error('Screenshot translation control leaked into reader');
  if (await page.locator('#typography-button').count() !== 1) throw new Error('Typography control is missing');
  const frame = page.frameLocator('#html-preview');
  await frame.locator('.pdf-page').first().waitFor();
  await frame.locator('body').evaluate(() => window.scrollTo(0, 220));
  await page.waitForTimeout(900);
  await page.locator('[data-view="library-view"]').click();
  await page.locator('#library-view.active-view').waitFor();
  await page.waitForTimeout(600);
  const progressAfter = await page.evaluate(async (id) => (await (await fetch('/api/library')).json()).library.items[id].progress, jobId);
  if (JSON.stringify(progressAfter) !== JSON.stringify(progressBefore)) throw new Error(`Opening, scrolling or closing the reader changed retired progress data (${JSON.stringify({ progressBefore, progressAfter })})`);
  if (libraryItemPatchBodies.some((body) => Object.prototype.hasOwnProperty.call(body, 'progress'))) throw new Error(`Opening, scrolling or closing the reader still sent a progress PATCH (${JSON.stringify(libraryItemPatchBodies)})`);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(80);
  if ((await page.locator('#library-heading').textContent()).trim() !== '全部文献') throw new Error('Returning to 文献库 incorrectly kept the saved-view filter');
  if (await page.locator('.document-tab.active').count()) throw new Error('A document tab remained active while the library surface was selected');
  if (await page.locator('.document-tab[aria-selected="true"]').count()) throw new Error('A hidden reader tab remained aria-selected in the library');
  if (!(await page.locator('[data-view="library-view"]').evaluate((node) => node.classList.contains('active')))) throw new Error('The library navigation did not own the only active indicator');
  const row = page.locator('#recent-list .library-row').first();
  await row.locator('[data-row-menu-job-id]').click();
  const rowMenu = row.locator('.row-more-menu');
  await rowMenu.waitFor();
  await page.waitForTimeout(80);
  const menuBefore = await rowMenu.boundingBox();
  const rowBefore = await row.boundingBox();
  if (!menuBefore || !rowBefore || menuBefore.top < 0 || menuBefore.bottom > 900) throw new Error('Row menu was clipped or positioned outside the reading list viewport');
  await page.evaluate(() => window.scrollTo({ top: 120, behavior: 'instant' }));
  await page.waitForTimeout(120);
  const menuAfter = await rowMenu.boundingBox();
  const rowAfter = await row.boundingBox();
  if (!menuAfter || !rowAfter || Math.abs((menuAfter.y - rowAfter.y) - (menuBefore.y - rowBefore.y)) > 3) throw new Error('Row menu did not follow its document row while scrolling');
  await page.evaluate(() => window.scrollTo(0, 0));
  await row.locator('[data-row-menu-job-id]').click();

  await page.evaluate(async ({ id, folderId, viewId }) => {
    await fetch(`/api/library/items/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder_ids: [] }) });
    await fetch(`/api/library/folders/${folderId}`, { method: 'DELETE' });
    await fetch(`/api/library/views/${viewId}`, { method: 'DELETE' });
  }, { id: jobId, folderId: folder.id, viewId: view.id });
  console.log(JSON.stringify({ libraryLayout: true, folderCrud: true, multiFolderAssignment: true, savedViews: true, viewNavigationStable: true, readerNavExclusive: true, rowMenuBound: true, readingStatus: status, readerProgressRetired: true, readerTabs: true, rightAssistant: true, errors }));
  if (errors.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await browserSession?.close();
  } catch (closeError) {
    console.error(`Failed to close browser: ${closeError.message}`);
    process.exitCode = 1;
  }
});
