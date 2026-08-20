// Assert the details panel is always reachable across desktop widths,
// including the Electron minimum (1040px) that used to fall in a dead zone.
const playwright = require(require('path').join(__dirname, 'playwright.cjs'));

const base = process.argv[2] || 'http://127.0.0.1:8000';
const WIDTHS = [1480, 1200, 1119, 1040, 900, 861, 860, 700];
const failures = [];

(async () => {
  const managed = await playwright.launchManagedChromium();
  try {
    for (const width of WIDTHS) {
      const context = await managed.browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      await page.goto(`${base}/library`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      await page.locator('.library-row').first().click();
      await page.waitForTimeout(450);
      const result = await page.evaluate(() => {
        const panel = document.querySelector('#library-details');
        const rect = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        return {
          display: style.display,
          visible: style.display !== 'none' && rect.width > 0 && rect.height > 0,
          onScreen: rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0,
          hasTitle: Boolean(panel.querySelector('h2')),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      if (!result.visible || !result.onScreen || !result.hasTitle) {
        failures.push(`${width}px: details unreachable ${JSON.stringify(result)}`);
      }
      if (result.overflow > 1) failures.push(`${width}px: horizontal overflow ${result.overflow}`);
      console.log(`  ${width}px -> details ${result.visible && result.onScreen ? 'reachable' : 'MISSING'}, overflow ${result.overflow}`);
      await context.close();
    }
  } finally {
    await managed.close();
  }
  if (failures.length) {
    failures.forEach((line) => console.error(`  - ${line}`));
    process.exit(1);
  }
  console.log('All widths keep the details panel reachable.');
})().catch((error) => { console.error(error); process.exit(1); });
