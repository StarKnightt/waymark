// Re-applies the current fact checker to the model replies saved in an eval results file (no model needed).
// usage: node eval/recheck.mjs eval/results-tools-final.json   (dev server must be running)
import { readFileSync, writeFileSync } from 'node:fs';
import { launch, BASE, gotoStable } from '../tools/chrome.mjs';
import { summarize, toRows } from './summary.mjs';

const file = process.argv[2] ?? 'eval/results-tools-final.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
const { ctx, page } = await launch({ profile: '.cache/chrome-recheck' });
try {
  await gotoStable(page, `${BASE}eval.html`, () => 'wmRecheck' in window);
  const guides = await page.evaluate((rows) => window.wmRecheck(rows), data.rows.map((r) => ({ id: r.id, raw: r.raw, stats: r.stats })));
  const rows = toRows(guides.map((guide, i) => ({ id: data.rows[i].id, guide, lengthM: data.rows[i].lengthM, waymarks: data.rows[i].waymarks, raw: data.rows[i].raw })));
  const { mode, trails, ...rest } = data.summary;
  void trails;
  const summary = { ...summarize(rows, { gpu: rest.gpu, modelLoadMs: rest.modelLoadMs }), mode, rechecked: new Date().toISOString() };
  console.log(JSON.stringify(summary, null, 1));
  writeFileSync(file, JSON.stringify({ summary, rows }, null, 1));
} finally {
  await ctx.close();
}
