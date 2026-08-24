const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];

  if (!url) {
    console.error('Please provide a URL.');
    process.exit(1);
  }

  const browser = await chromium.launch();

  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }
  });

  await page.goto(url, {
    waitUntil: 'networkidle'
  });
const buttons = await page.locator('button, [role="button"]').allTextContents();

console.log('Buttons found:', buttons);
  await page.screenshot({
    path: 'capture.png',
    fullPage: true
  });

  await browser.close();

  console.log('Screenshot created successfully.');
})();