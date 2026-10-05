// Writes guides for trails with Gemma 4 E2B in real Chrome (WebGPU) and saves eval/results-<mode>.json.
// usage: node eval/run.mjs <tools|free> [id ...]   (dev server must be running; BASE selects it)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch, BASE, gotoStable } from '../tools/chrome.mjs';
import { summarize, toRows } from './summary.mjs';

const [mode = 'tools', ...want] = process.argv.slice(2);
const specs = JSON.parse(readFileSync('tools/trails.json', 'utf8'));
const ids = want.length ? want : specs.map((s) => s.id);
const model = process.env.MODEL ?? '/.cache/models/gemma-4-E2B-it-web.litertlm';
mkdirSync('eval', { recursive: true });
const { ctx, page } = await launch({ profile: '.cache/chrome-eval' });
try {
  page.on('console', (m) => { const t = m.text(); if (!/^(I|W)\d{4}|INFO:|WARNING:|^\s|=== Source/.test(t)) console.log('[page]', t.slice(0, 200)); });
  await gotoStable(page, `${BASE}eval.html?model=${encodeURIComponent(model)}`, () => 'wmEval' in window);
  const res = await page.evaluate(([i, m]) => window.wmEval(i, m), [ids, mode]);
  const rows = toRows(res.out);
  const summary = summarize(rows, { gpu: res.gpu, modelLoadMs: res.loadMs });
  console.log(JSON.stringify(summary, null, 1));
  writeFileSync(`eval/results-${mode}${process.env.TAG ? '-' + process.env.TAG : ''}.json`, JSON.stringify({ summary, rows }, null, 1));
} finally {
  await ctx.close();
}
