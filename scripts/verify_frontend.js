const { chromium } = require('playwright');
const app = require('../src/backend/server');
const path = require('path');
const fs = require('fs');

async function runVerification() {
  const server = app.listen(3002, async () => {
    console.log('Verification server running on port 3002');
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, // iPhone viewport
      deviceScaleFactor: 2
    });

    const page = await context.newPage();
    await page.goto('http://localhost:3002/frontend/index.html');

    // Wait for app load
    await page.waitForTimeout(1000);

    const screenshotDir = path.resolve(__dirname, '../data/screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

    const screenshotPath = path.join(screenshotDir, 'mobile_app_preview.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`Screenshot saved to: ${screenshotPath}`);

    await browser.close();
    server.close();
    process.exit(0);
  });
}

runVerification();
