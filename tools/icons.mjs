// Renders public/icon.svg to PNG icons.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const svg = readFileSync('public/icon.svg', 'utf8');
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: `public/icon-${size}.png`, omitBackground: true });
    await page.close();
  }
} finally { await browser.close(); }
console.log('icons written');
