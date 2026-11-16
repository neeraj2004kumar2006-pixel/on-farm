const { chromium } = require('playwright');

(async () => {
  console.log('Browser launch kar raha hai...');
  try {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    await page.goto('https://www.google.com');
    console.log('Browser khul gaya! Title:', await page.title());
    await page.waitForTimeout(5000);
    await browser.close();
    console.log('Done.');
  } catch (err) {
    console.error('ERROR:', err.message);
  }
})();
