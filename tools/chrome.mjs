// Shared headless Chrome launcher with WebGPU enabled.
import { chromium } from 'playwright';

export async function launch({ profile = '.cache/chrome', width = 1280, height = 800, headed = !!process.env.HEADED, mobile = false } = {}) {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: !headed,
    viewport: { width, height },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  return { ctx, page };
}

export const BASE = process.env.BASE ?? 'http://localhost:5173/';

/** Navigates and waits out the dev server's one-time dependency reload. */
export async function gotoStable(page, url, readyFn) {
  await page.goto(url);
  await page.waitForTimeout(1500);
  await page.goto(url);
  await page.waitForFunction(readyFn, null, { timeout: 60000 });
}
