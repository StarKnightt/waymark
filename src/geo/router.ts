import { haversine, type LL } from './geo';
import type { PathWay } from './context';

const PENALTY: Record<string, number> = {
  path: 1, footway: 1, track: 1.05, steps: 1.1, bridleway: 1, pedestrian: 1.1, cycleway: 1.3, living_street: 1.2,
  service: 1.4, unclassified: 1.5, residential: 1.6, road: 1.6, tertiary: 2.5, secondary: 4, primary: 6, trunk: 10,
};

interface Edge { to: number; cost: number; len: number }

class Heap {
  private a: [number, number][] = [];
  push(k: number, v: number) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

/** Shortest walkable route through the given points on the OSM path network. */
export function routeThrough(paths: PathWay[], stops: LL[], prefer: RegExp | null = null): LL[] {
  const coord = new Map<number, LL>();
  const adj = new Map<number, Edge[]>();
  const add = (a: number, b: number, cost: number, len: number) => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push({ to: b, cost, len });
  };
  for (const w of paths) {
    const pen = (PENALTY[w.kind] ?? 3) * (prefer && w.name && prefer.test(w.name) ? 0.55 : 1);
    for (let i = 0; i < w.nodes.length; i++) coord.set(w.nodes[i], w.coords[i]);
    for (let i = 0; i + 1 < w.nodes.length; i++) {
      const len = haversine(w.coords[i], w.coords[i + 1]);
      add(w.nodes[i], w.nodes[i + 1], len * pen, len);
      add(w.nodes[i + 1], w.nodes[i], len * pen, len);
    }
  }
  const nearest = (p: LL) => {
    let best = -1, d = Infinity;
    for (const [id, c] of coord) {
      if (!adj.has(id)) continue;
      const dd = haversine(p, c);
      if (dd < d) { d = dd; best = id; }
    }
    if (d > 300) throw new Error(`No path within 300 m of ${p[0].toFixed(5)}, ${p[1].toFixed(5)}`);
    return best;
  };
  const ids = stops.map(nearest);
  const out: LL[] = [];
  for (let k = 0; k + 1 < ids.length; k++) {
    const src = ids[k], dst = ids[k + 1];
    const dist = new Map<number, number>([[src, 0]]);
    const prev = new Map<number, number>();
    const h = new Heap();
    h.push(0, src);
    const goal = coord.get(dst)!;
    while (h.size) {
      const [, u] = h.pop()!;
      if (u === dst) break;
      const du = dist.get(u)!;
      for (const e of adj.get(u) ?? []) {
        const nd = du + e.cost;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, u);
          h.push(nd + 0.55 * haversine(coord.get(e.to)!, goal), e.to);
        }
      }
    }
    if (!prev.has(dst) && src !== dst) throw new Error('No connected path between two of the points');
    const leg: LL[] = [];
    for (let v = dst; v !== undefined; v = prev.get(v)!) {
      leg.push(coord.get(v)!);
      if (v === src) break;
    }
    leg.reverse();
    out.push(...(out.length ? leg.slice(1) : leg));
  }
  return out;
}
