// Shared scoring for eval/run.mjs and eval/recheck.mjs.
export function toRows(items) {
  return items.map(({ id, guide, lengthM, waymarks, raw }) => ({
    id, lengthM, waymarks, stats: guide.stats, briefing: guide.briefing, briefingIssues: guide.briefingIssues,
    cues: guide.cues, raw: raw ?? guide.debug, guide: { ...guide, debug: undefined },
  }));
}

export function summarize(rows, extra = {}) {
  const sum = (k) => rows.reduce((a, r) => a + r.stats[k], 0);
  const issues = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.stats.issues)) issues[k] = (issues[k] ?? 0) + v;
  const avg = (k, d = 0) => +(rows.reduce((a, r) => a + r.stats[k], 0) / rows.length).toFixed(d);
  return {
    mode: rows[0]?.stats.mode, ...extra, trails: rows.length,
    modelCues: sum('modelCues'), cleanCues: sum('cleanCues'), repairedCues: sum('repairedCues'), replacedCues: sum('replacedCues'),
    addedCues: sum('addedCues'), required: sum('required'), requiredCovered: sum('requiredCovered'), invalidOutput: sum('invalidOutput'), issues,
    briefingIssues: rows.reduce((a, r) => a + r.briefingIssues.length, 0),
    avgMs: avg('ms'), avgPromptTokens: avg('promptTokens'), avgOutputTokens: avg('outputTokens'), avgDecodeTps: avg('decodeTps', 1), avgPrefillTps: avg('prefillTps'),
  };
}
