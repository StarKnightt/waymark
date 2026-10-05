import { angleDiff, bearing, fmtKm, haversine, LocalFrame, pointAt, pointInRing, resample, segmentsCross, side, snapToLine, type LL, type XY } from './geo';
import type { Context, PathWay, PoiKind } from './context';
import { demAt, type Dem } from './elevation';

export type Turn = 'left' | 'right' | 'sharp left' | 'sharp right' | 'slight left' | 'slight right' | 'straight' | 'keep left' | 'keep right';
export type WaymarkKind = 'start' | 'finish' | 'junction' | 'climb' | 'descent' | 'summit' | 'water' | 'stream' | 'lake' | 'view' | 'rest' | 'bridge' | 'steps' | 'forest' | 'open' | 'poi';

/** A number a cue is allowed to say, with the tolerance the checker accepts. */
export type Role = 'gain' | 'loss' | 'length' | 'elev' | 'grade' | 'off' | 'total' | 'pos' | 'time';
export interface Allowed { value: number; unit: 'm' | 'km' | '%' | 'min' | 'h' | 'steps'; tol: number; role?: Role }

export interface Waymark {
  id: string;
  at: number;
  lat: number;
  lon: number;
  ele: number;
  kinds: WaymarkKind[];
  title: string;
  facts: string[];
  turn?: Turn;
  onto?: string;
  names: string[];
  numbers: Allowed[];
  required: boolean;
  priority: number;
}

export interface Profile { pts: LL[]; cum: number[]; ele: number[] }

export interface TrailFacts {
  name: string;
  lengthM: number;
  ascentM: number;
  descentM: number;
  highest: { ele: number; at: number; name?: string };
  lowest: { ele: number; at: number };
  loop: boolean;
  outAndBack: boolean;
  walkMinutes: number;
  steepest: { at: number; length: number; grade: number } | null;
  waymarks: Waymark[];
  profile: Profile;
  names: string[];
  numbers: Allowed[];
  summary: string[];
}

interface Event {
  at: number;
  kind: WaymarkKind;
  title: string;
  fact: string;
  priority: number;
  required?: boolean;
  turn?: Turn;
  onto?: string;
  names?: string[];
  numbers?: Allowed[];
}

const STEP = 10;
const km = (m: number, role?: Role): Allowed => ({ value: +(m / 1000).toFixed(1), unit: 'km', tol: 0.15, role });
const meters = (m: number, tol = 15, role?: Role): Allowed => ({ value: Math.round(m), unit: 'm', tol, role });
const dist = (m: number, role: Role): Allowed => (m >= 950 ? km(m, role) : meters(m, Math.max(20, m * 0.1), role));
const pct = (p: number): Allowed => ({ value: Math.round(p), unit: '%', tol: 2, role: 'grade' });
const q = (s: string) => `"${s}"`;

const POI_RADIUS: Record<PoiKind, number> = {
  peak: 250, saddle: 80, viewpoint: 120, spring: 80, drinking_water: 60, waterfall: 150, shelter: 60, hut: 120,
  picnic: 60, bench: 20, toilets: 60, parking: 80, cafe: 60, information: 40, cairn: 40, cave: 60, camp: 100,
};
const POI_WORD: Record<PoiKind, string> = {
  peak: 'summit', saddle: 'saddle', viewpoint: 'viewpoint', spring: 'spring', drinking_water: 'drinking water tap',
  waterfall: 'waterfall', shelter: 'shelter', hut: 'mountain hut', picnic: 'picnic area', bench: 'bench', toilets: 'toilets',
  parking: 'car park', cafe: 'cafe', information: 'information board', cairn: 'cairn', cave: 'cave entrance', camp: 'campsite',
};
const article = (k: PoiKind) => (k === 'toilets' ? 'toilets' : /^[aeiou]/.test(POI_WORD[k]) ? `an ${POI_WORD[k]}` : `a ${POI_WORD[k]}`);
const POI_PRIORITY: Partial<Record<PoiKind, number>> = { peak: 5, viewpoint: 3.5, waterfall: 4, spring: 4, drinking_water: 4, hut: 4, shelter: 3, cafe: 1.9, toilets: 1.5, saddle: 2, picnic: 1.5, cave: 2, camp: 1.2, information: 1, cairn: 1, bench: 0.5, parking: 1 };

function smooth(v: number[], r: number): number[] {
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(v.length - 1, i + r); j++) { s += v[j]; n++; }
    out[i] = s / n;
  }
  return out;
}

/** Total climb and descent, ignoring wiggles smaller than `hyst` metres. */
function climbTotals(e: number[], hyst = 4): { up: number; down: number } {
  let up = 0, down = 0, ref = e[0];
  for (const v of e) {
    if (v - ref > hyst) { up += v - ref; ref = v; }
    else if (ref - v > hyst) { down += ref - v; ref = v; }
  }
  return { up, down };
}

/** Tobler's hiking function on the smoothed profile, in minutes. */
function walkingMinutes(cum: number[], e: number[], from = 0, to = cum.length - 1): number {
  let h = 0;
  for (let i = from; i < to; i++) {
    const dx = cum[i + 1] - cum[i];
    if (dx <= 0) continue;
    const s = (e[i + 1] - e[i]) / dx;
    const v = 6 * Math.exp(-3.5 * Math.abs(s + 0.05));
    h += dx / 1000 / v;
  }
  return h * 60;
}

export function buildFacts(name: string, points: LL[], dem: Dem, ctx: Context): TrailFacts {
  const { pts, cum } = resample(points, STEP);
  const raw = pts.map(([la, lo]) => demAt(dem, la, lo));
  const ele = smooth(raw, 4);
  const total = cum[cum.length - 1];
  const frame = new LocalFrame(pts[Math.floor(pts.length / 2)]);
  const line: XY[] = pts.map((p) => frame.toXY(p));
  const at = (d: number) => pointAt(pts, cum, d);
  const eleAt = (d: number) => ele[Math.min(ele.length - 1, Math.max(0, Math.round(d / STEP)))];
  const loop = haversine(pts[0], pts[pts.length - 1]) < 150;
  const halfway = Math.floor(pts.length / 2);
  const outAndBack = !loop ? false : (() => {
    let near = 0;
    for (let i = 0; i < halfway; i += 5) {
      const mirror = pts.length - 1 - i;
      if (haversine(pts[i], pts[mirror]) < 30) near++;
    }
    return near > halfway / 5 * 0.7;
  })();
  const events: Event[] = [];

  // ---- climbs and descents ----
  const W = 10; // 100 m window
  const grade = ele.map((_, i) => (i + W < ele.length ? (ele[i + W] - ele[i]) / (cum[i + W] - cum[i] || 1) : 0));
  type Run = { s: number; e: number; dir: 1 | -1 };
  const runs: Run[] = [];
  for (const dir of [1, -1] as const) {
    let s = -1, lastIn = -1;
    for (let i = 0; i < grade.length; i++) {
      const inRun = dir * grade[i] >= 0.07;
      if (inRun) { if (s < 0) s = i; lastIn = i; }
      if (s >= 0 && (!inRun && i - lastIn > 6 || i === grade.length - 1)) {
        runs.push({ s, e: Math.min(ele.length - 1, lastIn + W), dir });
        s = -1;
      }
    }
  }
  let steepest: TrailFacts['steepest'] = null;
  const sections = runs
    .map((r) => ({ ...r, len: cum[r.e] - cum[r.s], gain: (ele[r.e] - ele[r.s]) * r.dir }))
    .filter((r) => r.len >= 250 && r.gain >= 40)
    .sort((a, b) => b.gain - a.gain);
  for (const r of sections.filter((x) => x.dir === 1).slice(0, 4)) {
    const g = (r.gain / r.len) * 100;
    if (!steepest || g > steepest.grade) steepest = { at: cum[r.s], length: r.len, grade: g };
    events.push({
      at: cum[r.s], kind: 'climb', title: 'Climb starts', priority: 3 + Math.min(2, r.gain / 150),
      fact: `a steady climb starts here; it is ${fmtKm(r.len)} long and gains ${Math.round(r.gain / 10) * 10} m (about ${Math.round(g)}% on average), topping out at ${Math.round(ele[r.e])} m`,
      numbers: [dist(r.len, 'length'), meters(r.gain, 25, 'gain'), pct(g), meters(ele[r.e], 20, 'elev')],
    });
  }
  for (const r of sections.filter((x) => x.dir === -1).slice(0, 3)) {
    const g = (r.gain / r.len) * 100;
    events.push({
      at: cum[r.s], kind: 'descent', title: 'Steep descent', priority: 2.5 + Math.min(1.5, r.gain / 150),
      fact: `a descent starts here; it is ${fmtKm(r.len)} long and drops ${Math.round(r.gain / 10) * 10} m (about ${Math.round(g)}% on average)`,
      numbers: [dist(r.len, 'length'), meters(r.gain, 25, 'loss'), pct(g)],
    });
  }

  // ---- high point ----
  let hi = 0, lo = 0;
  ele.forEach((v, i) => { if (v > ele[hi]) hi = i; if (v < ele[lo]) lo = i; });
  let hiName: string | undefined;
  let hiBest = 150;
  for (const p of ctx.pois) {
    if (p.kind !== 'peak' || !p.name) continue;
    const d = haversine(pts[hi], [p.lat, p.lon]);
    if (d < hiBest) { hiBest = d; hiName = p.name; }
  }
  if (hi > 5 && hi < ele.length - 5 && ele[hi] - Math.min(ele[0], ele[ele.length - 1]) > 40) {
    events.push({
      at: cum[hi], kind: 'summit', title: hiName ?? 'High point', priority: 4.5,
      fact: `the highest point of the walk${hiName ? `, near ${q(hiName)}` : ''}, at about ${Math.round(ele[hi])} m`,
      names: hiName ? [hiName] : [], numbers: [meters(ele[hi], 20, 'elev')],
    });
  }

  // ---- junctions ----
  const nodeWays = new Map<number, { w: PathWay; i: number }[]>();
  for (const w of ctx.paths) w.nodes.forEach((n, i) => {
    const arr = nodeWays.get(n);
    if (arr) arr.push({ w, i }); else nodeWays.set(n, [{ w, i }]);
  });
  const branchPoint = (w: PathWay, i: number, dir: 1 | -1): LL | null => {
    let d = 0, j = i;
    while (j + dir >= 0 && j + dir < w.coords.length) {
      d += haversine(w.coords[j], w.coords[j + dir]);
      j += dir;
      if (d >= 22) break;
    }
    return j === i ? null : w.coords[j];
  };
  type J = Event & { score: number };
  const junctions: J[] = [];
  for (const [, uses] of nodeWays) {
    if (uses.length < 2 && !(uses.length === 1 && uses[0].w.nodes[0] === uses[0].w.nodes[uses[0].w.nodes.length - 1])) continue;
    const c = uses[0].w.coords[uses[0].i];
    const s = snapToLine(frame.toXY(c), line, cum);
    if (s.offset > 12 || s.along < 40 || s.along > total - 40) continue;
    const before = at(s.along - 22), after = at(s.along + 22);
    const inB = bearing(before, c), outB = bearing(c, after);
    const back = (inB + 180) % 360;
    const branches: { b: number; name?: string; kind: string }[] = [];
    for (const { w, i } of uses) for (const dir of [1, -1] as const) {
      const p = branchPoint(w, i, dir);
      if (p) branches.push({ b: bearing(c, p), name: w.name, kind: w.kind });
    }
    const matchIn = branches.findIndex((x) => Math.abs(angleDiff(back, x.b)) < 35);
    const matchOut = branches.findIndex((x, k) => k !== matchIn && Math.abs(angleDiff(outB, x.b)) < 35);
    if (matchIn < 0 || matchOut < 0) continue;
    const others = branches.filter((_, k) => k !== matchIn && k !== matchOut)
      .filter((x, k, arr) => arr.findIndex((y) => Math.abs(angleDiff(x.b, y.b)) < 20) === k);
    if (!others.length) continue;
    const turnDeg = angleDiff(inB, outB);
    const rels = others.map((o) => ({ ...o, rel: angleDiff(inB, o.b) }));
    let turn: Turn;
    const nearStraight = rels.find((o) => Math.abs(o.rel) < 45);
    if (Math.abs(turnDeg) <= 25) turn = nearStraight ? (turnDeg < nearStraight.rel ? 'keep left' : 'keep right') : 'straight';
    else if (turnDeg > 0) turn = turnDeg > 130 ? 'sharp right' : turnDeg < 45 && !nearStraight ? 'slight right' : 'right';
    else turn = turnDeg < -130 ? 'sharp left' : turnDeg > -45 && !nearStraight ? 'slight left' : 'left';
    if ((turn === 'slight left' || turn === 'slight right') && !rels.some((o) => Math.abs(o.rel - turnDeg) < 50)) turn = turn === 'slight left' ? 'keep left' : 'keep right';
    const onto = branches[matchOut].name;
    const from = branches[matchIn].name;
    const sideOf = (r: number) => (Math.abs(r) < 30 ? 'straight ahead' : r > 0 ? 'on the right' : 'on the left');
    const otherText = rels.map((o) => `${o.name ? q(o.name) : o.kind === 'track' ? 'the track' : o.kind === 'path' || o.kind === 'footway' ? 'the path' : o.kind === 'steps' ? 'the steps' : 'the road'} ${sideOf(o.rel)}`).join(' and ');
    const verb = turn === 'straight' ? 'continue straight' : turn.startsWith('keep') ? turn : `turn ${turn}`;
    const fact = `junction: ${verb}${onto && onto !== from ? ` onto ${q(onto)}` : onto ? ` on ${q(onto)}` : ''}; ${otherText} ${rels.length > 1 ? 'are' : 'is'} not your route`;
    const trailish = (k: string) => /path|footway|track|steps|bridleway/.test(k);
    const renamed = !!onto && !!from && onto !== from;
    let score = turn === 'straight' ? 0.6 : turn.startsWith('keep') ? 3 : 3.5;
    if (renamed) score += 1.5;
    if (others.some((o) => trailish(o.kind))) score += 0.5;
    junctions.push({
      at: s.along, kind: 'junction', priority: score, score, required: turn !== 'straight' || renamed,
      title: turn === 'straight' ? 'Straight on' : turn.startsWith('keep') ? `Keep ${turn.split(' ')[1]}` : `Turn ${turn}`,
      fact, turn, onto, names: [onto, from, ...others.map((o) => o.name)].filter((n): n is string => !!n),
    });
  }
  junctions.sort((a, b) => a.at - b.at);
  for (const j of junctions) {
    const prev = events.find((e) => e.kind === 'junction' && Math.abs(e.at - j.at) < 30);
    if (prev) { if ((prev.priority ?? 0) < j.priority) Object.assign(prev, j); continue; }
    events.push(j);
  }

  // ---- points of interest ----
  const seenPoi = new Set<string>();
  const near = ctx.pois
    .map((p) => ({ p, xy: frame.toXY([p.lat, p.lon]) as XY }))
    .map((o) => ({ ...o, s: snapToLine(o.xy, line, cum) }))
    .filter((o) => o.s.offset <= POI_RADIUS[o.p.kind])
    .sort((a, b) => a.s.along - b.s.along);
  for (const { p, xy, s } of near) {
    if ((p.kind === 'parking' || p.kind === 'information') && s.along > 150 && s.along < total - 150) continue;
    const key = `${p.kind}:${p.name ?? Math.round(s.along / 150)}`;
    if (seenPoi.has(key)) continue;
    seenPoi.add(key);
    const a = line[Math.max(0, s.index)], b = line[Math.min(line.length - 1, s.index + 1)];
    const lr = s.offset < 15 ? 'beside the path' : side(a, b, xy) > 0 ? 'on your left' : 'on your right';
    const word = POI_WORD[p.kind];
    const kind: WaymarkKind = p.kind === 'viewpoint' || p.kind === 'peak' ? 'view' : p.kind === 'spring' || p.kind === 'drinking_water' ? 'water' : p.kind === 'shelter' || p.kind === 'hut' || p.kind === 'bench' || p.kind === 'picnic' || p.kind === 'cafe' || p.kind === 'toilets' ? 'rest' : 'poi';
    const nums: Allowed[] = [];
    if (p.ele) nums.push(meters(p.ele, 10, 'elev'));
    if (s.offset >= 40) nums.push(meters(s.offset, Math.max(15, s.offset * 0.3), 'off'));
    events.push({
      at: s.along, kind, title: p.name ?? word[0].toUpperCase() + word.slice(1), priority: (POI_PRIORITY[p.kind] ?? 1) * (p.name ? 1 : 0.55),
      fact: `${p.name ? `${q(p.name)}, ${article(p.kind)}` : article(p.kind)} ${lr}${s.offset >= 40 ? `, about ${Math.round(s.offset / 10) * 10} m off the path${s.offset >= 100 ? ' (it is not on the route)' : ''}` : ''}${p.ele ? `, ${Math.round(p.ele)} m high` : ''}`,
      names: p.name ? [p.name] : [], numbers: nums,
    });
  }

  // ---- lakes ----
  const lakes = ctx.areas.filter((a) => a.kind === 'water');
  for (const lake of lakes) {
    const ring = lake.ring.map((p) => frame.toXY(p));
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    if (Math.abs(area / 2) < 3000) continue;
    for (let i = 0; i < line.length; i += 3) {
      let d = Infinity, k = 0;
      ring.forEach((v, m) => { const dd = Math.hypot(v[0] - line[i][0], v[1] - line[i][1]); if (dd < d) { d = dd; k = m; } });
      if (d > 90 && !pointInRing(line[i], ring)) continue;
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      const lr = side(a, b, ring[k]) > 0 ? 'on your left' : 'on your right';
      events.push({
        at: cum[i], kind: 'lake', title: lake.name ?? 'Lake', priority: lake.name ? 3.5 : 2,
        fact: `${lake.name ? q(lake.name) : 'a lake'} comes into view ${lr}`, names: lake.name ? [lake.name] : [],
      });
      break;
    }
  }

  // ---- streams crossed ----
  let crossings = 0;
  for (const st of ctx.streams) {
    const sl = st.coords.map((p) => frame.toXY(p));
    for (let i = 0; i < line.length - 1 && crossings < 12; i++) {
      for (let j = 0; j < sl.length - 1; j++) {
        if (!segmentsCross(line[i], line[i + 1], sl[j], sl[j + 1])) continue;
        crossings++;
        events.push({
          at: cum[i], kind: 'stream', title: st.name ?? (st.kind === 'river' ? 'River' : 'Stream'), priority: st.name ? 2.5 : 1.1,
          fact: `the path crosses ${st.name ? q(st.name) : st.kind === 'river' ? 'a river' : 'a stream'}`, names: st.name ? [st.name] : [],
        });
        break;
      }
    }
  }

  // ---- bridges and steps on the route ----
  const onRoute = (w: PathWay) => {
    const a = snapToLine(frame.toXY(w.coords[0]), line, cum), b = snapToLine(frame.toXY(w.coords[w.coords.length - 1]), line, cum);
    return a.offset < 10 && b.offset < 10 && Math.abs(a.along - b.along) > 3 ? [Math.min(a.along, b.along), Math.max(a.along, b.along)] as const : null;
  };
  const steps: [number, number][] = [];
  for (const w of ctx.paths) {
    if (!w.bridge && w.kind !== 'steps') continue;
    const r = onRoute(w);
    if (!r) continue;
    if (w.bridge && r[1] - r[0] < 400) events.push({ at: r[0], kind: 'bridge', title: w.name ?? 'Bridge', priority: 2, fact: `a bridge${w.name ? `, ${q(w.name)}` : ''}`, names: w.name ? [w.name] : [] });
    if (w.kind === 'steps') steps.push([r[0], r[1]]);
  }
  steps.sort((a, b) => a[0] - b[0]);
  const flights: [number, number][] = [];
  for (const s of steps) {
    const last = flights[flights.length - 1];
    if (last && s[0] - last[1] < 60) last[1] = Math.max(last[1], s[1]); else flights.push([s[0], s[1]]);
  }
  for (const [a, b] of flights) {
    if (b - a < 30) continue;
    const dz = eleAt(b) - eleAt(a);
    events.push({
      at: a, kind: 'steps', title: 'Steps', priority: 2.5 + Math.min(1.5, (b - a) / 200),
      fact: `a flight of steps starts here; it is about ${Math.round((b - a) / 10) * 10} m long and ${dz >= 0 ? 'climbs' : 'drops'} ${Math.abs(Math.round(dz))} m`,
      numbers: [meters(b - a, 20, 'length'), meters(Math.abs(dz), 15, dz >= 0 ? 'gain' : 'loss')],
    });
  }

  // ---- forest edges ----
  const forests = ctx.areas.filter((a) => a.kind === 'forest').map((a) => {
    const r = a.ring.map((p) => frame.toXY(p));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { r, x0, y0, x1, y1 };
  });
  if (forests.length) {
    const inside: boolean[] = [];
    for (let i = 0; i < line.length; i += 3) {
      const [x, y] = line[i];
      inside.push(forests.some((f) => x >= f.x0 && x <= f.x1 && y >= f.y0 && y <= f.y1 && pointInRing(line[i], f.r)));
    }
    let runStart = 0;
    for (let k = 1; k <= inside.length; k++) {
      if (k < inside.length && inside[k] === inside[runStart]) continue;
      const len = (k - runStart) * 3 * STEP;
      if (len >= 400 && runStart > 0) {
        const d = runStart * 3 * STEP;
        events.push(inside[runStart]
          ? { at: d, kind: 'forest', title: 'Into the trees', priority: 1.5, fact: `the path enters woodland for about ${fmtKm(len)}`, numbers: [dist(len, 'length')] }
          : { at: d, kind: 'open', title: 'Out in the open', priority: 1.5, fact: `the path leaves the trees and is open for about ${fmtKm(len)}`, numbers: [dist(len, 'length')] });
      }
      runStart = k;
    }
  }

  // ---- start and finish ----
  const { up, down } = climbTotals(ele);
  const walk = walkingMinutes(cum, ele);
  const startNear = ctx.pois.filter((p) => (p.kind === 'parking' || p.kind === 'information' || p.kind === 'toilets') && haversine(pts[0], [p.lat, p.lon]) < 150);
  events.push({
    at: 0, kind: 'start', title: 'Start', priority: 10, required: true,
    fact: `start of ${q(name)}: ${fmtKm(total)} ${loop ? (outAndBack ? 'out and back' : 'loop') : 'one way'}, about ${Math.round(up / 10) * 10} m of climbing in total${startNear.length ? `; ${[...new Set(startNear.map((p) => article(p.kind)))].join(' and ')} here` : ''}`,
    names: [name], numbers: [km(total, 'total'), meters(up, Math.max(25, up * 0.1), 'gain')],
  });
  events.push({
    at: total, kind: 'finish', title: loop ? 'Back at the start' : 'Finish', priority: 10, required: true,
    fact: loop ? 'back at the start; the walk is complete' : 'the end of the route',
  });

  // ---- merge events into waymarks ----
  events.sort((a, b) => a.at - b.at || b.priority - a.priority);
  const groups: Event[][] = [];
  for (const e of events) {
    const g = groups[groups.length - 1];
    const pinned = (x: Event) => x.kind === 'start' || x.kind === 'finish';
    if (g && e.at - g[0].at < 50 && !(pinned(e) && pinned(g[0]))) g.push(e); else groups.push([e]);
  }
  const MAX = 18;
  let kept = groups.map((g) => ({ g, p: Math.max(...g.map((e) => e.priority + (e.required ? 20 : 0))) })).filter((k) => k.p >= 1.6);
  if (kept.length > MAX) {
    const cut = kept.map((k) => k.p).sort((a, b) => b - a)[MAX - 1];
    kept = kept.filter((k) => k.p >= cut).slice(0, MAX + 4);
  }
  const waymarks: Waymark[] = kept.map(({ g: all }, idx) => {
    const ranked = all.slice().sort((a, b) => (b.required ? 20 : 0) + b.priority - ((a.required ? 20 : 0) + a.priority));
    const lead = ranked[0];
    const g = all.filter((e) => ranked.indexOf(e) < 3);
    const d = g[0].kind === 'finish' ? total : lead.at;
    const [la, lo] = at(d);
    return {
      id: `w${idx + 1}`, at: Math.round(d), lat: la, lon: lo, ele: Math.round(eleAt(d)),
      kinds: [...new Set(g.map((e) => e.kind))], title: lead.title, facts: g.map((e) => e.fact),
      turn: g.find((e) => e.turn && e.turn !== 'straight')?.turn ?? g.find((e) => e.turn)?.turn,
      onto: (g.find((e) => e.turn && e.turn !== 'straight') ?? g.find((e) => e.turn))?.onto,
      names: [...new Set(g.flatMap((e) => e.names ?? []))], numbers: g.flatMap((e) => e.numbers ?? []),
      required: g.some((e) => e.required), priority: lead.priority,
    };
  });
  // what lies between each waymark and the next, when it is long enough to be worth saying
  waymarks.forEach((w, i) => {
    const n = waymarks[i + 1];
    if (!n) return;
    const gap = n.at - w.at;
    if (gap < 300) return;
    const a = Math.round(w.at / STEP), b = Math.round(n.at / STEP);
    const seg = ele.slice(a, b + 1);
    const { up: u, down: dn } = climbTotals(seg.length ? seg : [ele[a]]);
    const r10 = (v: number) => Math.round(v / 10) * 10;
    const shape = u > 25 && dn > 25 ? `climbs ${r10(u)} m and drops ${r10(dn)} m` : u > 15 ? `climbs ${r10(u)} m` : dn > 15 ? `drops ${r10(dn)} m` : 'is mostly level';
    w.facts.push(`after this, the next ${fmtKm(gap)} ${shape}`);
    w.numbers.push(dist(gap, 'length'), meters(u, 20, 'gain'), meters(dn, 20, 'loss'));
  });

  const trailNumbers: Allowed[] = [km(total, 'total'), meters(up, Math.max(25, up * 0.1), 'gain'), meters(down, Math.max(25, down * 0.1), 'loss'), meters(ele[hi], 20, 'elev'), meters(ele[lo], 20, 'elev'), { value: Math.round(walk), unit: 'min', tol: Math.max(10, walk * 0.15), role: 'time' }];
  if (steepest) trailNumbers.push(dist(steepest.length, 'length'), pct(steepest.grade));
  const summary = [
    `${fmtKm(total)} ${loop ? (outAndBack ? 'out and back' : 'loop') : 'one way'}`,
    `about ${Math.round(up / 10) * 10} m of climbing and ${Math.round(down / 10) * 10} m of descent`,
    `highest point ${Math.round(ele[hi])} m${hiName ? ` (${hiName})` : ''}, lowest ${Math.round(ele[lo])} m`,
    `about ${Math.floor(walk / 60)} h ${Math.round(walk % 60)} min of walking at a steady pace, not counting stops`,
  ];
  if (steepest) summary.push(`steepest sustained climb: ${fmtKm(steepest.length)} at about ${Math.round(steepest.grade)}%`);
  const names = [name, ...new Set(waymarks.flatMap((w) => w.names))];
  return {
    name, lengthM: Math.round(total), ascentM: Math.round(up), descentM: Math.round(down),
    highest: { ele: Math.round(ele[hi]), at: Math.round(cum[hi]), name: hiName }, lowest: { ele: Math.round(ele[lo]), at: Math.round(cum[lo]) },
    loop, outAndBack, walkMinutes: Math.round(walk), steepest, waymarks, profile: { pts, cum, ele }, names, numbers: trailNumbers, summary,
  };
}

/** Minutes from the start to a distance along the route, using the same walking model. */
export function minutesTo(f: TrailFacts, at: number): number {
  const i = Math.min(f.profile.cum.length - 1, Math.round(at / STEP));
  return walkingMinutes(f.profile.cum, f.profile.ele, 0, i);
}
