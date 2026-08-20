#!/usr/bin/env node
// Device-viewport verification for the mobile/PWA build.
// Usage: node verify-mobile.cjs [baseURL]
// Exits non-zero on the first failed assertion.
const playwright = require(require('path').join(__dirname, '..', 'macos', 'tests', 'playwright.cjs'));

const baseURL = process.argv[2] || 'http://127.0.0.1:18080';
const DEVICES = [
  { name: 'iPhone 15', viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'iPhone SE', viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'iPad Air', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'Pixel 8', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
];

const failures = [];
function check(device, label, condition, detail = '') {
  if (condition) return;
  failures.push(`[${device}] ${label}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  const managed = await playwright.launchManagedChromium();
  try {
    for (const device of DEVICES) {
      const context = await managed.browser.newContext({
        viewport: device.viewport,
        deviceScaleFactor: device.deviceScaleFactor,
        isMobile: device.isMobile,
        hasTouch: device.hasTouch,
        userAgent: device.name.startsWith('iP')
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          : 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      });
      const page = await context.newPage();
      await page.goto(`${baseURL}/library`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);

      // 1. No horizontal overflow anywhere in the shell.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      check(device.name, 'no horizontal scroll', overflow.scrollWidth <= overflow.clientWidth + 1, JSON.stringify(overflow));

      const narrow = device.viewport.width <= 860;

      // 2. The PWA manifest and icons resolve.
      const manifest = await page.evaluate(async () => {
        const link = document.querySelector('link[rel="manifest"]');
        if (!link) return { ok: false };
        const response = await fetch(link.href);
        if (!response.ok) return { ok: false, status: response.status };
        const body = await response.json();
        return { ok: true, display: body.display, icons: (body.icons || []).length, start: body.start_url };
      });
      check(device.name, 'manifest served', manifest.ok, JSON.stringify(manifest));
      check(device.name, 'manifest standalone', manifest.display === 'standalone');
      check(device.name, 'manifest icons', manifest.icons >= 2);
      const maskable = await page.evaluate(async () => {
        const link = document.querySelector('link[rel="manifest"]');
        const body = await (await fetch(link.href)).json();
        const icon = (body.icons || []).find((entry) => String(entry.purpose || '').includes('maskable'));
        return icon ? (await fetch(icon.src)).ok : false;
      });
      check(device.name, 'maskable icon served', maskable);
      const appleIcon = await page.evaluate(async () => {
        const link = document.querySelector('link[rel="apple-touch-icon"]');
        return link ? (await fetch(link.href)).ok : false;
      });
      check(device.name, 'apple-touch-icon', appleIcon);

      // 3. The off-canvas sidebar opens, filters, and dismisses.
      if (narrow) {
        const toggleVisible = await page.locator('#mobile-sidebar-toggle').isVisible();
        check(device.name, 'sidebar toggle visible', toggleVisible);
        if (toggleVisible) {
          await page.locator('#mobile-sidebar-toggle').tap();
          await page.waitForTimeout(320);
          check(device.name, 'sidebar opens', await page.evaluate(() => document.body.classList.contains('sidebar-open')));
          const onScreen = await page.evaluate(() => document.querySelector('.library-sidebar').getBoundingClientRect().left >= -1);
          check(device.name, 'sidebar on screen', onScreen);
          // Tap the exposed strip of the scrim: its centre sits under the drawer.
          const scrimPoint = await page.evaluate(() => {
            const sidebar = document.querySelector('.library-sidebar').getBoundingClientRect();
            return { x: Math.round((sidebar.right + innerWidth) / 2), y: Math.round(innerHeight / 2) };
          });
          await page.touchscreen.tap(scrimPoint.x, scrimPoint.y);
          await page.waitForTimeout(320);
          check(device.name, 'scrim dismisses sidebar', await page.evaluate(() => !document.body.classList.contains('sidebar-open')));
        }
      }

      // 4. Selecting a paper raises the details sheet (mobile) or panel (tablet).
      const rows = await page.locator('.library-row').count();
      check(device.name, 'library rows render', rows > 0, `rows=${rows}`);
      if (rows > 0) {
        await page.locator('.library-row').first().tap();
        await page.waitForTimeout(400);
        const details = await page.evaluate(() => {
          const panel = document.querySelector('#library-details');
          const rect = panel.getBoundingClientRect();
          return {
            hasTitle: Boolean(panel.querySelector('h2')),
            open: document.body.classList.contains('details-open'),
            visible: rect.width > 0 && rect.top < innerHeight,
            withinViewport: rect.left >= -1 && rect.right <= innerWidth + 1,
          };
        });
        check(device.name, 'details render', details.hasTitle);
        check(device.name, 'details visible', details.visible, JSON.stringify(details));
        check(device.name, 'details within viewport', details.withinViewport, JSON.stringify(details));
        if (narrow) check(device.name, 'details sheet raised', details.open);

        // 5. The reader opens and the document renders.
        const openButton = page.locator('#library-details button', { hasText: '打开阅读' });
        if (await openButton.count()) {
          await openButton.first().tap();
          await page.waitForTimeout(7000);
          const reader = await page.evaluate(() => {
            const frame = document.querySelector('#html-preview');
            const doc = frame?.contentDocument;
            return {
              active: document.getElementById('reader-view')?.classList.contains('active-view'),
              paragraphs: doc?.querySelectorAll('p[data-block-id]').length ?? 0,
              math: doc?.querySelectorAll('math').length ?? 0,
              frameWidth: frame?.getBoundingClientRect().width ?? 0,
            };
          });
          check(device.name, 'reader opens', reader.active);
          check(device.name, 'document renders', reader.paragraphs > 10, `paragraphs=${reader.paragraphs}`);
          check(device.name, 'formulas render', reader.math > 0, `math=${reader.math}`);
          check(device.name, 'reader fits viewport', reader.frameWidth <= device.viewport.width + 1, `frame=${reader.frameWidth}`);
          const readerOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          check(device.name, 'reader has no horizontal scroll', readerOverflow <= 1, `overflow=${readerOverflow}`);
        }
      }

      // 6. The worker must control the start URL, or Chromium refuses to
      //    install the app. Registration itself needs a secure origin, so on
      //    plain HTTP we only assert scope reachability.
      const worker = await page.evaluate(async () => {
        const response = await fetch('/sw.js');
        const scopeHeader = response.headers.get('Service-Worker-Allowed');
        const registered = 'serviceWorker' in navigator
          ? await navigator.serviceWorker.getRegistration('/library').then((r) => Boolean(r)).catch(() => false)
          : false;
        return { served: response.ok, type: response.headers.get('Content-Type'), scopeHeader, registered, secure: window.isSecureContext };
      });
      check(device.name, 'worker served from root', worker.served && /javascript/.test(worker.type || ''), JSON.stringify(worker));
      if (worker.secure) check(device.name, 'worker controls /library', worker.registered, JSON.stringify(worker));

      // 7. Inputs are 16px or larger so iOS does not zoom on focus.
      const smallInputs = await page.evaluate(() => [...document.querySelectorAll('input, textarea, select')]
        .filter((node) => node.offsetParent && parseFloat(getComputedStyle(node).fontSize) < 16)
        .map((node) => `${node.id || node.tagName}:${getComputedStyle(node).fontSize}`));
      check(device.name, 'inputs avoid iOS zoom', smallInputs.length === 0, smallInputs.join(', '));

      await context.close();
      console.log(`  checked ${device.name} (${device.viewport.width}x${device.viewport.height})`);
    }
  } finally {
    await managed.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} mobile check(s) failed:`);
    failures.forEach((line) => console.error(`  - ${line}`));
    process.exit(1);
  }
  console.log('\nAll mobile checks passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
