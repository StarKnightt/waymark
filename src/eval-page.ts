// Developer entry used by eval/run.mjs: writes guides for pre-built trails with the real model.
import { getEngine, gpuStatus } from './ai/gemma';
import type { Message } from '@litert-lm/core';
import { recheck, writeGuide, userMessage, type Guide, type GuideStats } from './ai/guide';
import { loadStatic } from './trail';

declare global {
  interface Window {
    wmEval: (ids: string[], mode: 'tools' | 'free') => Promise<unknown>;
    wmPrompt: (id: string) => Promise<string>;
    wmRecheck: (rows: { id: string; raw: unknown; stats: GuideStats }[]) => Promise<Guide[]>;
  }
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

window.wmRecheck = async (rows) => {
  const out: Guide[] = [];
  for (const r of rows) {
    const b = await loadStatic(import.meta.env.BASE_URL, r.id);
    out.push(recheck(r.id, b.facts, r.raw as Message, r.stats));
  }
  return out;
};

window.wmPrompt = async (id) => {
  const b = await loadStatic(import.meta.env.BASE_URL, id);
  return userMessage(b.facts);
};
