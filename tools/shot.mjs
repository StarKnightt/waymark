// Screenshots app views. usage: node tools/shot.mjs <name> <hash> [width height] [--mobile] [--wait=ms] [--eval=js]
import { mkdirSync } from 'node:fs';
import { launch, BASE } from './chrome.mjs';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const [name = 'shot', target = '', w = '1440', h = '900'] = args.filter((a) => !a.startsWith('--'));
// a bare id means a demo trail; Git Bash rewrites arguments that contain slashes
const hash = target.startsWith('#') ? target : target === 'make' ? '#/make' : target ? `#/t/${target}` : '#/';
mkdirSync('.cache/shots', { recursive: true });
const { ctx, page } = await launch({ profile: '.cache/chrome-shot', width: Number(w), height: Number(h), mobile: !!flags.mobile });
try {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const q = flags.q ? `?${flags.q}` : '';
  await page.goto(`${BASE}${q}${hash}`);
  await page.waitForFunction(() => document.querySelector('.cues li, .make, .pocket h1'), null, { timeout: 60000 });
  await page.waitForTimeout(Number(flags.wait ?? 2500));
  if (flags.eval) { await page.evaluate(flags.eval); await page.waitForTimeout(Number(flags.after ?? 1500)); }
  await page.screenshot({ path: `.cache/shots/${name}.png` });
  const stats = await page.evaluate(() => window.__wm?.world()?.stats?.());
  console.log(name, JSON.stringify(stats), errors.length ? `errors: ${errors.join(' | ')}` : 'no console errors');
} finally {
  await ctx.close();
}
