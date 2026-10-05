// Writes guides for trails with Gemma 4 E2B in real Chrome (WebGPU) and saves eval/results-<mode>.json.
// usage: node eval/run.mjs <tools|free> [id ...]   (dev server must be running)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { launch, BASE, gotoStable } from '../tools/chrome.mjs';

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
  const rows = res.out.map(({ id, guide, lengthM, waymarks }) => ({ id, lengthM, waymarks, stats: guide.stats, briefing: guide.briefing, briefingIssues: guide.briefingIssues, cues: guide.cues, raw: guide.debug, guide: { ...guide, debug: undefined } }));
  if (process.env.SHOWRAW) for (const r of rows) console.log(r.id, JSON.stringify(r.raw).slice(0, 3000));
  const sum = (k) => rows.reduce((a, r) => a + r.stats[k], 0);
  const issues = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.stats.issues)) issues[k] = (issues[k] ?? 0) + v;
  const summary = {
    mode, gpu: res.gpu, modelLoadMs: res.loadMs, trails: rows.length,
    modelCues: sum('modelCues'), cleanCues: sum('cleanCues'), repairedCues: sum('repairedCues'), replacedCues: sum('replacedCues'),
    addedCues: sum('addedCues'), required: sum('required'), requiredCovered: sum('requiredCovered'), invalidOutput: sum('invalidOutput'), issues,
    avgMs: Math.round(sum('ms') / rows.length), avgPromptTokens: Math.round(sum('promptTokens') / rows.length), avgOutputTokens: Math.round(sum('outputTokens') / rows.length),
    avgDecodeTps: +(rows.reduce((a, r) => a + r.stats.decodeTps, 0) / rows.length).toFixed(1), avgPrefillTps: Math.round(rows.reduce((a, r) => a + r.stats.prefillTps, 0) / rows.length),
  };
  console.log(JSON.stringify(summary, null, 1));
  writeFileSync(`eval/results-${mode}${process.env.TAG ? '-' + process.env.TAG : ''}.json`, JSON.stringify({ summary, rows }, null, 1));
} finally {
  await ctx.close();
}
