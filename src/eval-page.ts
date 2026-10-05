// Developer entry used by eval/run.mjs: writes guides for pre-built trails with the real model.
import { getEngine, gpuStatus } from './ai/gemma';
import { writeGuide, userMessage, type Guide } from './ai/guide';
import { loadStatic } from './trail';

declare global {
  interface Window { wmEval: (ids: string[], mode: 'tools' | 'free') => Promise<unknown>; wmPrompt: (id: string) => Promise<string> }
}

window.wmEval = async (ids, mode) => {
  const t0 = performance.now();
  const gpu = await gpuStatus();
  const engine = await getEngine((p) => console.log(p.text));
  const loadMs = Math.round(performance.now() - t0);
  const out: { id: string; guide: Guide; lengthM: number; waymarks: number }[] = [];
  for (const id of ids) {
    const b = await loadStatic(import.meta.env.BASE_URL, id);
    const guide = await writeGuide(engine, id, b.facts, { mode, debug: true });
    console.log(`${id}: ${guide.stats.modelCues} cues in ${guide.stats.ms} ms`);
    out.push({ id, guide, lengthM: b.facts.lengthM, waymarks: b.facts.waymarks.length });
  }
  return { gpu, loadMs, out };
};

window.wmPrompt = async (id) => {
  const b = await loadStatic(import.meta.env.BASE_URL, id);
  return userMessage(b.facts);
};
