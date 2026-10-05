// Shared headless Chrome launcher with WebGPU enabled.
import { chromium } from 'playwright';

export async function launch({ profile = '.cache/chrome', width = 1280, height = 800, headed = !!process.env.HEADED, mobile = false, scale = 0 } = {}) {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: !headed,
    viewport: { width, height },
    deviceScaleFactor: scale || (mobile ? 2 : 1),
    isMobile: mobile,
    hasTouch: mobile,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  });
  // a persistent profile can restore old tabs; always work in a fresh one
  const page = await ctx.newPage();
  for (const p of ctx.pages()) if (p !== page) await p.close();
  page.on('pageerror', (e) => console.log('[pageerror]', process.env.STACK ? e.stack : e.message));
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
