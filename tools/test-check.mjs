// Runs the fact-checker unit cases in Chrome.
import { launch, BASE, gotoStable } from './chrome.mjs';
const { ctx, page } = await launch({ profile: '.cache/chrome-test' });
try {
  await gotoStable(page, BASE + 'check-test.html', () => 'wmCheckTest' in window);
  const cases = await page.evaluate(() => window.wmCheckTest());
  for (const c of cases) console.log(c.ok ? 'PASS' : 'FAIL', c.name, '=>', JSON.stringify(c.got));
  console.log(`${cases.filter((c) => c.ok).length}/${cases.length} passed`);
  process.exitCode = cases.every((c) => c.ok) ? 0 : 1;
} finally { await ctx.close(); }
