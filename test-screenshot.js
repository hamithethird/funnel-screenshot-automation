const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }
  });

  await page.goto('https://example.com', {
    waitUntil: 'networkidle'
  });

  await page.screenshot({
    path: 'test-screenshot.png',
    fullPage: true
  });

  await browser.close();

  console.log('Screenshot created successfully.');
})();