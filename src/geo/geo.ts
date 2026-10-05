export type LL = [lat: number, lon: number];
export type XY = [x: number, y: number];

const R = 6371008.8;
const rad = Math.PI / 180;

export function haversine(a: LL, b: LL): number {
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b in degrees, 0 = north, clockwise. */
export function bearing(a: LL, b: LL): number {
  const φ1 = a[0] * rad, φ2 = b[0] * rad, Δλ = (b[1] - a[1]) * rad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Signed difference b - a in degrees, in (-180, 180]. Positive means b is clockwise (to the right) of a. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Local east/north metres around an origin. Accurate to well under 1% over a few tens of kilometres. */
export class LocalFrame {
  readonly k: number;
  constructor(readonly origin: LL) {
    this.k = Math.cos(origin[0] * rad);
  }
  toXY([lat, lon]: LL): XY {
    return [(lon - this.origin[1]) * rad * R * this.k, (lat - this.origin[0]) * rad * R];
  }
  toLL([x, y]: XY): LL {
    return [this.origin[0] + y / (rad * R), this.origin[1] + x / (rad * R * this.k)];
  }
}

export function cumulative(points: LL[]): number[] {
  const d = [0];
  for (let i = 1; i < points.length; i++) d.push(d[i - 1] + haversine(points[i - 1], points[i]));
  return d;
}

/** Point at a given distance along a polyline with precomputed cumulative distances. */
export function pointAt(points: LL[], cum: number[], at: number): LL {
  if (at <= 0) return points[0];
  const n = points.length - 1;
  if (at >= cum[n]) return points[n];
  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= at) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (at - cum[lo]) / seg;
  return [points[lo][0] + (points[hi][0] - points[lo][0]) * t, points[lo][1] + (points[hi][1] - points[lo][1]) * t];
}

/** Resample a polyline every `step` metres (the last point is always kept). */
export function resample(points: LL[], step: number): { pts: LL[]; cum: number[] } {
  const cum = cumulative(points);
  const total = cum[cum.length - 1];
  const pts: LL[] = [];
  const out: number[] = [];
  for (let d = 0; d < total; d += step) {
    pts.push(pointAt(points, cum, d));
    out.push(d);
  }
  pts.push(points[points.length - 1]);
  out.push(total);
  return { pts, cum: out };
}

export interface Snap { along: number; offset: number; index: number }

/** Nearest point on a polyline (in a local frame) to p. `along` is metres from the start. */
export function snapToLine(p: XY, line: XY[], cum: number[], from = 0, to = line.length - 1): Snap {
  let best: Snap = { along: 0, offset: Infinity, index: 0 };
  for (let i = Math.max(0, from); i < Math.min(to, line.length - 1); i++) {
    const a = line[i], b = line[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a[0] + dx * t, qy = a[1] + dy * t;
    const off = Math.hypot(p[0] - qx, p[1] - qy);
    if (off < best.offset) best = { along: cum[i] + (cum[i + 1] - cum[i]) * t, offset: off, index: i };
  }
  return best;
}

/** Which side of the directed segment a->b the point p is on: > 0 left, < 0 right. */
export function side(a: XY, b: XY, p: XY): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

export function pointInRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const d1 = side(c, d, a), d2 = side(c, d, b), d3 = side(a, b, c), d4 = side(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Douglas-Peucker simplification in a local frame; returns kept indices. */
export function simplifyIdx(pts: XY[], tol: number): number[] {
  if (pts.length < 3) return pts.map((_, i) => i);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

export interface BBox { s: number; w: number; n: number; e: number }

export function bboxOf(points: LL[], padMeters = 0): BBox {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lat, lon] of points) {
    s = Math.min(s, lat); n = Math.max(n, lat);
    w = Math.min(w, lon); e = Math.max(e, lon);
  }
  const dLat = padMeters / (rad * R);
  const dLon = padMeters / (rad * R * Math.cos(((s + n) / 2) * rad));
  return { s: s - dLat, w: w - dLon, n: n + dLat, e: e + dLon };
}

export const fmtKm = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
