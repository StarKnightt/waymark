import type { Engine, Message, Tool } from '@litert-lm/core';
import { checkBriefing, checkCue, templateCue, type Issue, type IssueType } from './check';
import type { TrailFacts, Waymark } from '../geo/facts';
import { MODEL } from './gemma';

export const KINDS = ['start', 'turn', 'fork', 'continue', 'climb', 'descent', 'summit', 'water', 'lake', 'stream', 'view', 'rest', 'bridge', 'steps', 'woods', 'open', 'finish', 'note'] as const;

export interface Cue {
  id: string;
  at: number;
  lat: number;
  lon: number;
  kind: string;
  title: string;
  text: string;
  source: 'gemma' | 'template';
  issues: Issue[];
  original?: string;
}

export interface GuideStats {
  mode: 'tools' | 'free';
  waymarks: number;
  required: number;
  modelCues: number;
  cleanCues: number;
  repairedCues: number;
  replacedCues: number;
  addedCues: number;
  requiredCovered: number;
  invalidOutput: number;
  issues: Record<IssueType, number>;
  ms: number;
  promptTokens: number;
  outputTokens: number;
  decodeTps: number;
  prefillTps: number;
}

export interface Guide {
  trailId: string;
  trailName: string;
  model: string;
  createdAt: string;
  briefing: string;
  briefingOriginal?: string;
  briefingIssues: Issue[];
  cues: Cue[];
  stats: GuideStats;
  debug?: unknown;
}

export const SYSTEM = [
  'You write a spoken guide for a walking trail. The walker keeps the phone in a pocket and hears each cue once, when they reach that waymark.',
  '',
  'Rules:',
  '- Use only the facts listed for that waymark. Never add a name, number, distance, direction or feature that is not in its facts.',
  '- Give directions exactly as the facts say them, for example "turn left", "keep right" or "continue straight".',
  '- One or two short sentences per cue, at most 30 words. Speak to the walker as "you". Plain, calm and practical. No greetings and no exclamation marks.',
  '- Say what to do at this spot first, then what the next stretch is like. Leave out a stretch that is only "mostly level".',
  '- For a climb, descent or flight of steps, say how long it is and how much it climbs or drops, using the numbers given.',
  '- Mention toilets, benches, cafes or information boards only when nothing more useful happens at that waymark.',
  '- Do not begin two cues in a row with the same words.',
  '- When a waymark lists two junctions, give them in the order listed.',
  '- Only call a place a summit, lake, waterfall or viewpoint if its facts call it that. A place marked "not on the route" is only something you can see.',
  '- Every waymark marked REQUIRED must get a cue. Skip other waymarks that would add nothing useful.',
].join('\n');

const TOOL_HINT = 'Call write_guide once with a cue for every REQUIRED waymark and for each other waymark worth hearing, in walking order, and a briefing of 3 or 4 sentences for someone deciding whether to go: the length, the climbing, the hardest part and the highlights.';

const FREE_HINT = 'Reply with JSON only, no other text: {"cues": [{"waymark": "w1", "text": "..."}, ...], "briefing": "..."}. The briefing is 3 or 4 sentences for someone deciding whether to go: the length, the climbing, the hardest part and the highlights.';

export function userMessage(f: TrailFacts, mode: 'tools' | 'free' = 'tools'): string {
  const lines = f.waymarks.map((w) => `${w.id}${w.required ? ' (REQUIRED)' : ''}: ${w.facts.join('; ')}`);
  return [
    `Trail: ${f.name}`,
    `Overview: ${f.summary.join('; ')}`,
    '',
    'Waymarks in walking order:',
    ...lines,
    '',
    mode === 'tools' ? TOOL_HINT : FREE_HINT,
  ].join('\n');
}

export function guideTool(f: TrailFacts): Tool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'write_guide',
        description: 'Write the whole spoken guide: one cue per chosen waymark, in walking order, plus the briefing.',
        parameters: {
          type: 'object',
          properties: {
            cues: {
              type: 'array',
              description: 'one entry per waymark that gets a cue, in walking order; every REQUIRED waymark must be included',
              items: {
                type: 'object',
                properties: {
                  waymark: { type: 'string', enum: f.waymarks.map((w) => w.id), description: 'the waymark id' },
                  text: { type: 'string', description: 'the spoken cue: one or two short sentences, at most 30 words' },
                },
                required: ['waymark', 'text'],
              },
            },
            briefing: { type: 'string', description: '3 or 4 sentences for someone deciding whether to go' },
          },
          required: ['cues', 'briefing'],
        },
      },
    },
  ];
}

export function tools(f: TrailFacts): Tool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'add_cue',
        description: 'Add the spoken cue for one waymark.',
        parameters: {
          type: 'object',
          properties: {
            waymark: { type: 'string', enum: f.waymarks.map((w) => w.id), description: 'the waymark id, for example w3' },
            kind: { type: 'string', enum: [...KINDS], description: 'what the cue is mainly about' },
            text: { type: 'string', description: 'the spoken cue: one or two short sentences, at most 30 words' },
          },
          required: ['waymark', 'kind', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_briefing',
        description: 'Set the short spoken briefing played before the walk.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: '3 or 4 sentences' } }, required: ['text'] },
      },
    },
  ];
}

const kindOf = (w: Waymark): string => {
  if (w.kinds.includes('finish')) return 'finish';
  if (w.kinds.includes('start')) return 'start';
  if (w.turn && w.turn !== 'straight') return w.turn.startsWith('keep') ? 'fork' : 'turn';
  const k = w.kinds.find((x) => x !== 'junction') ?? 'continue';
  return k === 'forest' ? 'woods' : k === 'poi' ? 'note' : k;
};

export function emptyStats(mode: 'tools' | 'free', f: TrailFacts): GuideStats {
  return {
    mode, waymarks: f.waymarks.length, required: f.waymarks.filter((w) => w.required).length, modelCues: 0, cleanCues: 0, repairedCues: 0,
    replacedCues: 0, addedCues: 0, requiredCovered: 0, invalidOutput: 0, issues: { number: 0, name: 0, direction: 0, side: 0, length: 0, empty: 0 },
    ms: 0, promptTokens: 0, outputTokens: 0, decodeTps: 0, prefillTps: 0,
  };
}

/** Turns raw (waymark, text) pairs from the model into a checked, complete guide. */
export function assemble(trailId: string, f: TrailFacts, raw: { waymark: string; kind?: string; text: string }[], briefingRaw: string | null, stats: GuideStats): Guide {
  const byId = new Map(f.waymarks.map((w) => [w.id, w]));
  const cues: Cue[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const w = byId.get(r.waymark);
    if (!w || seen.has(w.id) || typeof r.text !== 'string') { stats.invalidOutput++; continue; }
    seen.add(w.id);
    stats.modelCues++;
    const c = checkCue(r.text, w, f);
    for (const i of c.issues) stats.issues[i.type]++;
    if (c.replaced) stats.replacedCues++;
    else if (c.issues.length) stats.repairedCues++;
    else stats.cleanCues++;
    if (w.required) stats.requiredCovered++;
    cues.push({ id: w.id, at: w.at, lat: w.lat, lon: w.lon, kind: (KINDS as readonly string[]).includes(r.kind ?? '') ? r.kind! : kindOf(w), title: w.title, text: c.text, source: c.replaced ? 'template' : 'gemma', issues: c.issues, original: c.issues.length ? r.text : undefined });
  }
  for (const w of f.waymarks) {
    if (!w.required || seen.has(w.id)) continue;
    stats.addedCues++;
    cues.push({ id: w.id, at: w.at, lat: w.lat, lon: w.lon, kind: kindOf(w), title: w.title, text: templateCue(w, f), source: 'template', issues: [] });
  }
  cues.sort((a, b) => a.at - b.at);
  const b = briefingRaw ? checkBriefing(briefingRaw, f) : { text: `${f.name}: ${f.summary.slice(0, 4).join('; ')}.`, issues: [] };
  return {
    trailId, trailName: f.name, model: MODEL.name, createdAt: new Date().toISOString(), briefing: b.text,
    briefingOriginal: b.issues.length ? briefingRaw ?? undefined : undefined, briefingIssues: b.issues, cues, stats,
  };
}

/** Pulls (waymark, text) pairs and the briefing out of the model's reply. */
export function parseReply(msg: Message, mode: 'tools' | 'free', stats: GuideStats): { raw: { waymark: string; kind?: string; text: string }[]; briefing: string | null } {
  const raw: { waymark: string; kind?: string; text: string }[] = [];
  let briefing: string | null = null;
  if (mode === 'tools') {
    for (const call of msg.tool_calls ?? []) {
      const a = call.function.arguments as Record<string, unknown>;
      if (call.function.name === 'write_guide') {
        for (const c of Array.isArray(a.cues) ? a.cues : []) {
          const o = (c ?? {}) as Record<string, unknown>;
          raw.push({ waymark: String(o.waymark ?? ''), text: String(o.text ?? '') });
        }
        if (typeof a.briefing === 'string') briefing = a.briefing;
      } else if (call.function.name === 'add_cue') raw.push({ waymark: String(a.waymark ?? ''), kind: String(a.kind ?? ''), text: String(a.text ?? '') });
      else if (call.function.name === 'set_briefing' && typeof a.text === 'string') briefing = a.text;
      else stats.invalidOutput++;
    }
    if (!msg.tool_calls?.length) stats.invalidOutput++;
  } else {
    const text = typeof msg.content === 'string' ? msg.content : (msg.content ?? []).map((p) => ('text' in p ? p.text : '')).join('');
    try {
      const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      for (const c of j.cues ?? []) raw.push({ waymark: String(c.waymark ?? ''), text: String(c.text ?? '') });
      if (typeof j.briefing === 'string') briefing = j.briefing;
    } catch {
      stats.invalidOutput++;
    }
  }
  return { raw, briefing };
}

/** Re-applies the current checker to a saved model reply (used to re-score stored eval runs). */
export function recheck(trailId: string, f: TrailFacts, msg: Message, old: GuideStats): Guide {
  const stats = { ...emptyStats(old.mode, f), ms: old.ms, promptTokens: old.promptTokens, outputTokens: old.outputTokens, decodeTps: old.decodeTps, prefillTps: old.prefillTps };
  const { raw, briefing } = parseReply(msg, old.mode, stats);
  return assemble(trailId, f, raw, briefing, stats);
}

export interface WriteOptions { mode?: 'tools' | 'free'; signal?: AbortSignal; debug?: boolean }

export async function writeGuide(engine: Engine, trailId: string, f: TrailFacts, opts: WriteOptions = {}): Promise<Guide> {
  const mode = opts.mode ?? 'tools';
  const stats = emptyStats(mode, f);
  const t0 = performance.now();
  const conv = await engine.createConversation({
    preface: { messages: [{ role: 'system', content: SYSTEM }], ...(mode === 'tools' ? { tools: guideTool(f) } : {}) },
    enableConstrainedDecoding: mode === 'tools',
    sessionConfig: { samplerParams: { temperature: 0, k: 1 }, maxOutputTokens: 2400 },
  });
  try {
    const abort = () => conv.cancel();
    opts.signal?.addEventListener('abort', abort);
    let msg: Message;
    try {
      msg = await conv.sendMessage(userMessage(f, mode));
    } finally {
      opts.signal?.removeEventListener('abort', abort);
    }
    const bench = await conv.getBenchmarkInfo();
    stats.ms = Math.round(performance.now() - t0);
    stats.promptTokens = bench.lastPrefillTokenCount;
    stats.outputTokens = bench.lastDecodeTokenCount;
    stats.decodeTps = +bench.lastDecodeTokensPerSecond.toFixed(1);
    stats.prefillTps = Math.round(bench.lastPrefillTokensPerSecond);
    const { raw, briefing } = parseReply(msg, mode, stats);
    const guide = assemble(trailId, f, raw, briefing, stats);
    if (opts.debug) guide.debug = msg;
    return guide;
  } finally {
    await conv.delete();
  }
}
