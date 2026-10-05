import type { Allowed, Role, TrailFacts, Waymark } from '../geo/facts';

export type IssueType = 'number' | 'name' | 'direction' | 'side' | 'length' | 'empty';
export interface Issue { type: IssueType; detail: string; fixed: 'swapped' | 'removed' | 'trimmed' | 'replaced' }
export interface Checked { text: string; issues: Issue[]; replaced: boolean }

const COMMON = new Set(('a an the this that these those here there you your it its at after before then from to on in into onto over under up down '
  + 'turn keep bear continue follow take start finish walk go head cross climb descend watch look stay stop rest enjoy look take care well '
  + 'now next soon ahead behind left right straight north south east west on off just only about around nearly almost '
  + 'congratulations welcome great nice good easy hard steep be mind').split(' '));

const UNIT = /(\d+(?:[.,]\d+)?)\s*(kilometres|kilometers|kilometre|kilometer|km|metres|meters|metre|meter|m(?![a-z])|%|percent|per cent|minutes|minute|mins|min|hours|hour|hrs|hr|h(?![a-z])|steps)?/gi;

interface Num { raw: string; value: number; kind: 'dist' | '%' | 'min' | 'steps' | null; roles: Role[] | null }

const Q = String.raw`(?:about|around|roughly|nearly|almost|over|just over|under|some)?\s*`;
const ELEV_B = new RegExp(String.raw`\b(up to|at|reach(?:es|ing)?|tops? out at|topping out at|elevation(?: of)?|altitude(?: of)?|height(?: of)?|(?:a |the )?(?:peak|summit|top|high point|highest point) of)\s*` + Q + '$');
const GAIN_B = new RegExp(String.raw`\b(gain(?:s|ing)?|climb(?:s|ing)?|ascen(?:d|ds|ding|t)|ris(?:e|es|ing)|up)\s*(?:of\s*)?` + Q + '$');
const LOSS_B = new RegExp(String.raw`\b(drop(?:s|ping)?|los(?:e|es|ing)|descen(?:d|ds|ding|t)|down|fall(?:s|ing)?)\s*(?:of\s*)?` + Q + '$');
const LEN_B = new RegExp(String.raw`\b(for|over|in|after|within|another|next|last|of)\s*` + Q + '$');

/** What a number is being used as, from the words around it. null means the sentence does not say. */
function roleOf(before: string, after: string, kind: Num['kind'], km = false): Role[] | null {
  if (kind === '%') return ['grade'];
  if (kind === 'min') return ['time'];
  if (kind !== 'dist') return null;
  // heights and climbs are given in metres; a figure in kilometres is a distance along the path
  if (km) return ['length', 'total', 'off'];
  const b = before.toLowerCase(), a = after.toLowerCase();
  // "a climb of 340 m gaining 60 m": a figure followed by its own gain or drop is the length
  if (/^\s*(long\s*)?,?\s*(gaining|gains|climbing|rising|dropping|losing|descending)\b/.test(a)) return ['length', 'total', 'off'];
  if (ELEV_B.test(b) || /^\s*(high|above sea level|elevation|altitude)\b/.test(a)) return ['elev'];
  if (GAIN_B.test(b) || /^\s*(of (climbing|ascent)|up\b|higher|of height)/.test(a)) return ['gain'];
  if (LOSS_B.test(b) || /^\s*(of descent|down\b|lower)/.test(a)) return ['loss'];
  if (/^\s*(away|off the (path|trail|route)|from the (path|trail))/.test(a)) return ['off'];
  if (/^\s*(long|of (steps|path|trail|walking))\b/.test(a) || LEN_B.test(b)) return ['length', 'total', 'off'];
  if (/^\s*(in total|total|round trip|one way|loop|out and back)/.test(a)) return ['total', 'gain', 'loss'];
  return null;
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMWORD = String.raw`(?:${Object.keys(SMALL).join('|')}|hundred|thousand)`;
const SEQ = new RegExp(String.raw`\b${NUMWORD}(?:[\s-]+(?:and[\s-]+)?${NUMWORD})*\b(?=\s*(?:kilometres?|kilometers?|km|metres?|meters?|hours?|minutes?|mins?|percent|%))`, 'gi');

function parseWords(seq: string): number | null {
  let total = 0, cur = 0;
  for (const w of seq.toLowerCase().split(/[\s-]+/)) {
    if (w === 'and') continue;
    if (w in SMALL) cur += SMALL[w];
    else if (w === 'hundred') cur = (cur || 1) * 100;
    else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; }
    else return null;
  }
  return total + cur;
}

/** Rewrites spelled-out amounts ("an hour and a half", "four hundred fifty metres") as digits so they are checked too. */
export function digitize(s: string): string {
  const one = (n: string) => SMALL[n.toLowerCase()];
  return s
    .replace(/\b(an?|one) hour and a half\b/gi, '1 h 30 min')
    .replace(/\bhalf an hour\b/gi, '30 min')
    .replace(/\b(an?|one) hour and (\w+(?:[\s-]\w+)?) minutes?\b/gi, (m, _a, n) => { const v = parseWords(n); return v === null ? m : `1 h ${v} min`; })
    .replace(/\b(\w+) hours? and a half\b/gi, (m, n) => (one(n) ? `${one(n)} h 30 min` : m))
    .replace(/\b(an|a) (hour|kilometre|kilometer)\b/gi, (_m, _a, u) => `1 ${u}`)
    .replace(/\bhalf a (kilometre|kilometer)\b/gi, '0.5 km')
    .replace(/\b(\w+) point (\w+)\b/gi, (m, a, b) => (a.toLowerCase() in SMALL && b.toLowerCase() in SMALL && SMALL[b.toLowerCase()] < 10 ? `${SMALL[a.toLowerCase()]}.${SMALL[b.toLowerCase()]}` : m))
    .replace(SEQ, (m) => { const v = parseWords(m); return v === null ? m : String(v); });
}

function numbers(s: string): Num[] {
  s = digitize(s);
  const out: Num[] = [];
  const DUR = /(\d+)\s*(?:h|hours?|hrs?)\s*(?:and\s*)?(\d+)\s*(?:min|mins|minutes?)\b/gi;
  for (const m of s.matchAll(DUR)) out.push({ raw: m[0], value: Number(m[1]) * 60 + Number(m[2]), kind: 'min', roles: ['time'] });
  s = s.replace(DUR, (m) => ' '.repeat(m.length));
  for (const m of s.matchAll(UNIT)) {
    const v = parseFloat(m[1].replace(',', '.'));
    const u = (m[2] ?? '').toLowerCase();
    let n: Omit<Num, 'roles'>;
    if (/^(km|kilo)/.test(u)) n = { raw: m[0], value: v * 1000, kind: 'dist' };
    else if (/^(m|metre|meter)/.test(u) && !/^min/.test(u)) n = { raw: m[0], value: v, kind: 'dist' };
    else if (u === '%' || u.startsWith('per')) n = { raw: m[0], value: v, kind: '%' };
    else if (u.startsWith('min')) n = { raw: m[0], value: v, kind: 'min' };
    else if (/^(h|hour|hr)/.test(u)) n = { raw: m[0], value: v * 60, kind: 'min' };
    else if (u === 'steps') n = { raw: m[0], value: v, kind: 'steps' };
    else n = { raw: m[0], value: v, kind: null };
    const i = m.index ?? 0;
    out.push({ ...n, roles: roleOf(s.slice(Math.max(0, i - 32), i), s.slice(i + m[0].length, i + m[0].length + 28), n.kind, /^(km|kilo)/.test(u)) });
  }
  return out;
}

function supported(n: Num, all: Allowed[]): boolean {
  const allowed = n.roles ? all.filter((a) => !a.role || n.roles!.includes(a.role)) : all;
  return allowed.some((a) => {
    if (n.kind === 'dist' && (a.unit === 'm' || a.unit === 'km')) {
      const v = a.unit === 'km' ? a.value * 1000 : a.value, tol = a.unit === 'km' ? a.tol * 1000 : a.tol;
      return Math.abs(n.value - v) <= Math.max(tol, 0.06 * v);
    }
    if (n.kind === '%' && a.unit === '%') return Math.abs(n.value - a.value) <= a.tol;
    if (n.kind === 'min' && (a.unit === 'min' || a.unit === 'h')) return Math.abs(n.value - a.value) <= a.tol;
    if (n.kind === 'steps' && a.unit === 'steps') return Math.abs(n.value - a.value) <= a.tol;
    if (n.kind === null) return Math.abs(n.value - a.value) < 0.5 || Math.abs(n.value - (a.unit === 'km' ? a.value : Math.round(a.value))) < 0.5;
    return false;
  });
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’`".,()&-]/g, ' ').replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim();

/** Proper-noun phrases in a sentence that the guide would be asserting exist. */
function properNouns(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/["“”]([^"“”]{2,60})["“”]/g)) out.push(m[1]);
  // names in scripts without capital letters (for example 紅葉橋) are checked as whole runs
  for (const m of s.matchAll(/[^\p{Script=Latin}\p{N}\s.,;:!?'’"“”()&/-]{2,}/gu)) out.push(m[0]);
  const words = s.replace(/["“”]/g, '').split(/\s+/);
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      const phrase = cur.join(' ').replace(/[,.;:!?]+$/, '');
      const single = cur.length === 1 && COMMON.has(cur[0].toLowerCase().replace(/[^a-z]/g, ''));
      if (!single) out.push(phrase);
    }
    cur = [];
  };
  let startsAtZero = false;
  // a lone capitalised word at the start of a sentence ("Toilets and a bench...") is ordinary grammar, not a name
  const lone = () => startsAtZero && cur.filter((x) => /^\p{Lu}/u.test(x)).length === 1;
  words.forEach((w, i) => {
    const bare = w.replace(/^[(]+|[),.;:!?]+$/g, '');
    const cap = /^\p{Lu}/u.test(bare);
    const joiner = cur.length && /^(of|the|and|de|la|du|da|del|y|&)$/i.test(bare);
    if (cap) {
      if (!cur.length) startsAtZero = i === 0;
      cur.push(bare);
      if (/[,.;:!?]$/.test(w)) { if (!lone()) flush(); else cur = []; }
    } else if (joiner) cur.push(bare);
    else { if (lone()) cur = []; flush(); }
  });
  if (lone()) cur = [];
  flush();
  return out.map((p) => p.replace(/\s+(of|the|and|de|la|du|da|del|y|&)$/i, '')).filter((p) => p.length > 1);
}

function nameKnown(phrase: string, names: string[]): boolean {
  // a sentence-initial verb ("Find the Sharma store") is not part of the name
  const words = phrase.split(/\s+/);
  while (words.length > 1 && (COMMON.has(words[0].toLowerCase()) || LEAD_VERBS.has(words[0].toLowerCase()))) words.shift();
  const p = norm(words.join(' '));
  if (!p || COMMON.has(p)) return true;
  return names.some((n) => {
    const k = norm(n);
    return k.includes(p) || p.includes(k) || p.split(' ').every((w) => k.split(' ').includes(w) || COMMON.has(w));
  });
}

const DIR = /\b(turn|keep|bear|fork|veer|go|head|stay|take(?: the)?(?: path| trail| track| fork)?)\s+(?:(?:sharp|slight|hard)(?:ly)?\s+)?(left|right)\b/gi;
const STRAIGHT = /\b(continue|go|keep going|carry on|walk|head)\s+straight\b/i;
const BRANCH = /\b(path|track|road|steps|trail|route)\s+(straight ahead|on the left|on the right|to the left|to the right)\b/gi;

/** Sides of the ways the facts say are not the route ("left", "right", "straight"). */
function branchSides(w: Waymark): Set<string> {
  const out = new Set<string>();
  for (const f of w.facts) {
    const m = f.match(/;\s*(.*)\s+(?:is|are) not your route/);
    if (!m) continue;
    for (const s of m[1].matchAll(/(straight ahead|on the left|on the right)/g)) out.add(s[1].split(' ').pop()!);
  }
  return out;
}
const SIDE = /\b(on|to) (your|the) (left|right)\b/gi;

/** Every direction the junction facts at this waymark give (a waymark can hold two nearby junctions). */
function turnsAllowed(w: Waymark): Set<'left' | 'right' | 'straight'> {
  const out = new Set<'left' | 'right' | 'straight'>();
  for (const f of w.facts) {
    const m = f.match(/junction: (continue straight|keep left|keep right|turn (?:sharp |slight )?(?:left|right))/);
    if (m) out.add(m[1].includes('left') ? 'left' : m[1].includes('right') ? 'right' : 'straight');
  }
  return out;
}

const LEAD_VERBS = new Set('find pass see reach enter leave expect spot notice visit approach'.split(' '));

const swapLR = (s: string) => s.replace(/\b(left|right)\b/gi, (w) => (w.toLowerCase() === 'left' ? (w[0] === 'L' ? 'Right' : 'right') : w[0] === 'R' ? 'Left' : 'left'));

export function splitSentences(t: string): string[] {
  return t.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).filter(Boolean);
}

/** "Turn left onto X." built from the first turning junction fact at a waymark. */
function turnSentence(w: Waymark): string {
  const j = w.facts.find((x) => /junction: (turn|keep) /.test(x)) ?? '';
  const m = j.match(/junction: ([^;]+)/);
  const s = (m?.[1] ?? `turn ${w.turn ?? ''}`).replace(/["“”]/g, '').replace(/\s*\((the (sharper|gentler) of two \w+ turns)\)/, ', $1,').replace(/,$/, '');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

export function templateCue(w: Waymark, f: TrailFacts): string {
  const fact = w.facts[0] ?? '';
  const clean = (s: string) => s.replace(/["“”]/g, '').replace(/\s*\(about [^)]*\)/, '');
  if (w.kinds.includes('finish')) return f.loop ? 'You are back at the start. The walk is complete.' : 'This is the end of the route.';
  if (w.kinds.includes('start')) return `This is the start of ${f.name}: ${f.summary[0]}, with ${f.summary[1]}.`;
  const j = w.facts.find((x) => x.startsWith('junction:'));
  if (j && w.turn && w.turn !== 'straight') {
    const m = j.match(/^junction: ([^;]+)/);
    const s = clean(m?.[1] ?? `turn ${w.turn}`);
    return s[0].toUpperCase() + s.slice(1) + '.';
  }
  const s = clean(fact.replace(/^junction: /, ''));
  return s[0].toUpperCase() + s.slice(1) + '.';
}

/** Removes formatting copied from the facts (quotation marks) and capitalises each sentence. Wording is unchanged. */
export function tidy(text: string): string {
  return text.replace(/["“”]/g, '').replace(/\s+([,.;:])/g, '$1').replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

/** Features a sentence may only claim when the facts it was written from mention them. */
const FEATURES: [RegExp, RegExp][] = [
  // "a peak of 2,377 m" describes the top of a climb, not a mountain
  [/\b(summit|peak)s?\b(?!\s+of\s+(about\s+)?\d)/i, /\bsummit\b/i],
  [/\b(waterfall|falls)\b/i, /\bwaterfall\b|\bfalls?\b/i],
  [/\bbridges?\b/i, /\bbridge\b/i],
];
function unsupportedFeature(s: string, facts: string[], names: string[]): string | null {
  // "Roys Peak Track" is a name, not a claim about a peak
  let bare = s;
  for (const n of names) if (n.length > 2) bare = bare.split(n).join(' ').replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  for (const [said, need] of FEATURES) if (said.test(bare) && !facts.some((x) => need.test(x))) return bare.match(said)![0];
  return null;
}

/** Checks one spoken cue against its waymark's facts and repairs what it safely can. */
export function checkCue(raw: string, w: Waymark, f: TrailFacts): Checked {
  const text = tidy(raw);
  // quoted names are read from the raw text, before tidy() removes the quotation marks
  const badQuoted = [...raw.matchAll(/["“”]([^"“”]{2,60})["“”]/g)].map((m) => m[1]).filter((n) => !nameKnown(n, f.names));
  const issues: Issue[] = [];
  const allowed = [...w.numbers, ...f.numbers];
  const names = f.names;
  const allowedTurns = turnsAllowed(w);
  const sidesInFacts = new Set(w.facts.flatMap((x) => [...x.matchAll(/on your (left|right)/g)].map((m) => m[1])));
  const branches = branchSides(w);
  const kept: string[] = [];
  for (let s of splitSentences(text)) {
    let drop: Issue | null = null;
    for (const b of s.matchAll(BRANCH)) {
      if (!branches.has(b[2].split(' ').pop()!)) { drop = { type: 'direction', detail: `mentioned a ${b[1]} ${b[2]} that the facts do not list`, fixed: 'removed' }; break; }
    }
    const negated = /\b(do not|don't|never|not)\s+(continue|go|keep going|carry on|walk|head)\s+straight/i.test(s);
    if (!drop && allowedTurns.size && !allowedTurns.has('straight') && STRAIGHT.test(s) && !negated && !new RegExp(DIR.source, 'i').test(s)) {
      drop = { type: 'direction', detail: `said straight on, the junction goes ${[...allowedTurns].join(' or ')}`, fixed: 'removed' };
    }
    for (const n of numbers(s)) {
      if (names.some((nm) => norm(nm).includes(norm(n.raw)))) continue;
      if (!supported(n, allowed)) { drop = { type: 'number', detail: `"${n.raw.trim()}" is not in the facts`, fixed: 'removed' }; break; }
    }
    const quoted = badQuoted.find((n) => s.includes(n));
    if (!drop && quoted) drop = { type: 'name', detail: `"${quoted}" is not on this route`, fixed: 'removed' };
    const feature = !drop && unsupportedFeature(s, w.facts, f.names);
    if (feature) drop = { type: 'name', detail: `mentioned a ${feature.toLowerCase()} that the facts here do not`, fixed: 'removed' };
    if (!drop) for (const p of properNouns(s)) {
      if (!nameKnown(p, names)) { drop = { type: 'name', detail: `"${p}" is not on this route`, fixed: 'removed' }; break; }
    }
    if (!drop) {
      const dirs = [...s.matchAll(DIR)].map((m) => m[2].toLowerCase() as 'left' | 'right');
      if (dirs.length) {
        const turns = [...allowedTurns].filter((t) => t !== 'straight');
        if (!allowedTurns.size) drop = { type: 'direction', detail: `gave a ${dirs[0]} turn where there is no junction`, fixed: 'removed' };
        else if (dirs.every((d) => allowedTurns.has(d))) { /* matches a junction here */ }
        else if (turns.length === 1 && dirs.every((d) => d !== turns[0])) { s = s.replace(DIR, (m) => swapLR(m)); issues.push({ type: 'direction', detail: `said ${dirs[0]}, the junction goes ${turns[0]}`, fixed: 'swapped' }); }
        else drop = { type: 'direction', detail: `said ${dirs.join(' and ')}, the junctions here go ${[...allowedTurns].join(' and ')}`, fixed: 'removed' };
      }
    }
    if (!drop) {
      for (const m of s.matchAll(SIDE)) {
        // "the path on the left" names a branch, which the branch check above already verified
        if (/(path|track|road|steps|trail|route|way|lane)s?\s*$/i.test(s.slice(0, m.index))) continue;
        const sd = m[3].toLowerCase();
        if (sidesInFacts.has(sd)) continue;
        const other = sd === 'left' ? 'right' : 'left';
        if (sidesInFacts.has(other) && sidesInFacts.size === 1) { s = s.slice(0, m.index) + swapLR(m[0]) + s.slice((m.index ?? 0) + m[0].length); issues.push({ type: 'side', detail: `said on the ${sd}, the facts say ${other}`, fixed: 'swapped' }); }
        else if (!allowedTurns.size) drop = { type: 'side', detail: `said on the ${sd}, which the facts do not say`, fixed: 'removed' };
        break;
      }
    }
    if (drop) issues.push(drop); else kept.push(s);
  }
  let out = kept.join(' ');
  if (out.split(/\s+/).length > 40) {
    out = splitSentences(out).slice(0, 2).join(' ');
    issues.push({ type: 'length', detail: 'longer than 40 words', fixed: 'trimmed' });
  }
  // a cue at a turn must always say the turn, even if the sentence that said it had to go
  const mustTurn = [...allowedTurns].some((t) => t !== 'straight');
  if (mustTurn && out && !new RegExp(DIR.source, 'i').test(out)) {
    out = `${turnSentence(w)} ${out}`;
    issues.push({ type: 'direction', detail: 'the turn instruction was missing', fixed: 'replaced' });
  }
  if (out.split(/\s+/).filter(Boolean).length < 3) {
    if (text.trim()) issues.push({ type: 'empty', detail: 'nothing safe was left', fixed: 'replaced' });
    return { text: templateCue(w, f), issues, replaced: true };
  }
  return { text: out, issues, replaced: false };
}

/** Same rules for the briefing, against trail-level facts. Unsafe sentences are dropped. */
export function checkBriefing(raw: string, f: TrailFacts): { text: string; issues: Issue[] } {
  const text = tidy(raw);
  const allowed: Allowed[] = [...f.numbers, ...f.waymarks.flatMap((w) => w.numbers), { value: f.walkMinutes, unit: 'min', tol: Math.max(8, f.walkMinutes * 0.1) }];
  const issues: Issue[] = [];
  const kept: string[] = [];
  for (const s of splitSentences(text)) {
    const bad = numbers(s).find((n) => !f.names.some((nm) => norm(nm).includes(norm(n.raw))) && !supported(n, allowed));
    if (bad) { issues.push({ type: 'number', detail: `"${bad.raw.trim()}" is not in the facts`, fixed: 'removed' }); continue; }
    const unknown = properNouns(s).find((p) => !nameKnown(p, f.names));
    if (unknown) { issues.push({ type: 'name', detail: `"${unknown}" is not on this route`, fixed: 'removed' }); continue; }
    // the briefing may only promise a summit the walk actually reaches
    const onRoute = [...f.summary, ...f.waymarks.flatMap((w) => w.facts.filter((x) => !/not on the route/.test(x)))];
    const feature = unsupportedFeature(s, onRoute, f.names);
    if (feature) { issues.push({ type: 'name', detail: `mentioned a ${feature.toLowerCase()} the route does not reach`, fixed: 'removed' }); continue; }
    kept.push(s);
  }
  const out = kept.join(' ');
  return out.split(/\s+/).length >= 8 ? { text: out, issues } : { text: `${f.name}: ${f.summary.slice(0, 4).join('; ')}.`, issues: [...issues, { type: 'empty', detail: 'briefing replaced', fixed: 'replaced' }] };
}
