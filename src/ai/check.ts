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
const ELEV_B = new RegExp(String.raw`\b(up to|at|reach(?:es|ing)?|tops? out at|topping out at|elevation(?: of)?|altitude(?: of)?|height(?: of)?)\s*` + Q + '$');
const GAIN_B = new RegExp(String.raw`\b(gain(?:s|ing)?|climb(?:s|ing)?|ascend(?:s|ing)?|ris(?:e|es|ing)|up)\s*(?:of\s*)?` + Q + '$');
const LOSS_B = new RegExp(String.raw`\b(drop(?:s|ping)?|los(?:e|es|ing)|descend(?:s|ing)?|down|fall(?:s|ing)?)\s*(?:of\s*)?` + Q + '$');
const LEN_B = new RegExp(String.raw`\b(for|over|in|after|within|another|next|last|of)\s*` + Q + '$');

/** What a number is being used as, from the words around it. null means the sentence does not say. */
function roleOf(before: string, after: string, kind: Num['kind']): Role[] | null {
  if (kind === '%') return ['grade'];
  if (kind === 'min') return ['time'];
  if (kind !== 'dist') return null;
  const b = before.toLowerCase(), a = after.toLowerCase();
  if (ELEV_B.test(b) || /^\s*(high|above sea level|elevation|altitude)\b/.test(a)) return ['elev'];
  if (GAIN_B.test(b) || /^\s*(of (climbing|ascent)|up\b|higher|of height)/.test(a)) return ['gain'];
  if (LOSS_B.test(b) || /^\s*(of descent|down\b|lower)/.test(a)) return ['loss'];
  if (/^\s*(away|off the (path|trail|route)|from the (path|trail))/.test(a)) return ['off'];
  if (/^\s*(long|of (steps|path|trail|walking))\b/.test(a) || LEN_B.test(b)) return ['length', 'total', 'off'];
  if (/^\s*(in total|total|round trip|one way|loop|out and back)/.test(a)) return ['total', 'gain', 'loss'];
  return null;
}

function numbers(s: string): Num[] {
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
    out.push({ ...n, roles: roleOf(s.slice(Math.max(0, i - 32), i), s.slice(i + m[0].length, i + m[0].length + 28), n.kind) });
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
    if (n.kind === 'min' && (a.unit === 'min' || a.unit === 'h')) return Math.abs(n.value - a.value) <= Math.max(a.tol, 0.15 * a.value);
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
  words.forEach((w, i) => {
    const bare = w.replace(/^[(]+|[),.;:!?]+$/g, '');
    const cap = /^\p{Lu}/u.test(bare);
    const joiner = cur.length && /^(of|the|and|de|la|du|da|del|y|&)$/i.test(bare);
    if (cap) {
      if (!cur.length) startsAtZero = i === 0;
      cur.push(bare);
      if (/[,.;:!?]$/.test(w)) { if (!(startsAtZero && cur.length === 1)) flush(); else cur = []; }
    } else if (joiner) cur.push(bare);
    else { if (startsAtZero && cur.length === 1) cur = []; flush(); }
  });
  if (startsAtZero && cur.length === 1) cur = [];
  flush();
  return out.map((p) => p.replace(/\s+(of|the|and|de|la|du|da|del|y|&)$/i, '')).filter((p) => p.length > 1);
}

function nameKnown(phrase: string, names: string[]): boolean {
  const p = norm(phrase);
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

function expected(turn: Waymark['turn']): 'left' | 'right' | 'straight' | null {
  if (!turn) return null;
  if (turn.includes('left')) return 'left';
  if (turn.includes('right')) return 'right';
  return 'straight';
}

const swapLR = (s: string) => s.replace(/\b(left|right)\b/gi, (w) => (w.toLowerCase() === 'left' ? (w[0] === 'L' ? 'Right' : 'right') : w[0] === 'R' ? 'Left' : 'left'));

export function splitSentences(t: string): string[] {
  return t.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).filter(Boolean);
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

/** Checks one spoken cue against its waymark's facts and repairs what it safely can. */
export function checkCue(text: string, w: Waymark, f: TrailFacts): Checked {
  const issues: Issue[] = [];
  const allowed = [...w.numbers, ...f.numbers];
  const names = f.names;
  const want = expected(w.turn);
  const sidesInFacts = new Set(w.facts.flatMap((x) => [...x.matchAll(/on your (left|right)/g)].map((m) => m[1])));
  const branches = branchSides(w);
  const kept: string[] = [];
  for (let s of splitSentences(text)) {
    let drop: Issue | null = null;
    for (const b of s.matchAll(BRANCH)) {
      if (!branches.has(b[2].split(' ').pop()!)) { drop = { type: 'direction', detail: `mentioned a ${b[1]} ${b[2]} that the facts do not list`, fixed: 'removed' }; break; }
    }
    if (!drop && (want === 'left' || want === 'right') && STRAIGHT.test(s) && !/\b(left|right)\b/i.test(s)) drop = { type: 'direction', detail: `said straight on, the junction goes ${want}`, fixed: 'removed' };
    for (const n of numbers(s)) {
      if (names.some((nm) => norm(nm).includes(norm(n.raw)))) continue;
      if (!supported(n, allowed)) { drop = { type: 'number', detail: `"${n.raw.trim()}" is not in the facts`, fixed: 'removed' }; break; }
    }
    if (!drop) for (const p of properNouns(s)) {
      if (!nameKnown(p, names)) { drop = { type: 'name', detail: `"${p}" is not on this route`, fixed: 'removed' }; break; }
    }
    if (!drop) {
      const dirs = [...s.matchAll(DIR)].map((m) => m[2].toLowerCase());
      if (dirs.length) {
        if (want === 'left' || want === 'right') {
          if (dirs.every((d) => d !== want)) { s = s.replace(DIR, (m) => swapLR(m)); issues.push({ type: 'direction', detail: `said ${dirs[0]}, the junction goes ${want}`, fixed: 'swapped' }); }
        } else {
          drop = { type: 'direction', detail: want === 'straight' ? `said ${dirs[0]}, the route goes straight on` : `gave a ${dirs[0]} turn where there is no junction`, fixed: 'removed' };
        }
      }
    }
    if (!drop) {
      const sides = [...s.matchAll(SIDE)].map((m) => m[3].toLowerCase());
      for (const sd of sides) {
        if (sidesInFacts.has(sd)) continue;
        const other = sd === 'left' ? 'right' : 'left';
        if (sidesInFacts.has(other) && sidesInFacts.size === 1) { s = s.replace(SIDE, (m) => swapLR(m)); issues.push({ type: 'side', detail: `said on the ${sd}, the facts say ${other}`, fixed: 'swapped' }); }
        else if (!w.turn) { drop = { type: 'side', detail: `said on the ${sd}, which the facts do not say`, fixed: 'removed' }; }
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
  if (out.split(/\s+/).filter(Boolean).length < 3) {
    if (text.trim()) issues.push({ type: 'empty', detail: 'nothing safe was left', fixed: 'replaced' });
    return { text: templateCue(w, f), issues, replaced: true };
  }
  return { text: out, issues, replaced: false };
}

/** Same rules for the briefing, against trail-level facts. Unsafe sentences are dropped. */
export function checkBriefing(text: string, f: TrailFacts): { text: string; issues: Issue[] } {
  const allowed: Allowed[] = [...f.numbers, ...f.waymarks.flatMap((w) => w.numbers), { value: f.walkMinutes, unit: 'min', tol: 15 }];
  const issues: Issue[] = [];
  const kept: string[] = [];
  for (const s of splitSentences(text)) {
    const bad = numbers(s).find((n) => !f.names.some((nm) => norm(nm).includes(norm(n.raw))) && !supported(n, allowed));
    if (bad) { issues.push({ type: 'number', detail: `"${bad.raw.trim()}" is not in the facts`, fixed: 'removed' }); continue; }
    const unknown = properNouns(s).find((p) => !nameKnown(p, f.names));
    if (unknown) { issues.push({ type: 'name', detail: `"${unknown}" is not on this route`, fixed: 'removed' }); continue; }
    kept.push(s);
  }
  const out = kept.join(' ');
  return out.split(/\s+/).length >= 8 ? { text: out, issues } : { text: `${f.name}: ${f.summary.slice(0, 4).join('; ')}.`, issues: [...issues, { type: 'empty', detail: 'briefing replaced', fixed: 'replaced' }] };
}
