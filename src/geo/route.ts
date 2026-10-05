import { haversine, type LL } from './geo';
import { overpass, type OsmElement, type OsmRelation, type OsmWay } from './overpass';

export interface Track {
  name: string;
  points: LL[];
  /** Metres of straight-line gaps that had to be bridged while stitching ways. */
  gapMeters: number;
  source: { kind: 'osm-relation'; id: number } | { kind: 'gpx'; file: string } | { kind: 'osm-route'; stops: LL[] };
  tags?: Record<string, string>;
}

interface Piece { coords: LL[]; first: number; last: number }

const JOIN_M = 25;

function joins(a: LL, aId: number, b: LL, bId: number) {
  return (aId && aId === bId) || haversine(a, b) < JOIN_M;
}

/** Orders and orients the member ways of a route relation into one continuous line. */
export function stitch(pieces: Piece[]): { coords: LL[]; gap: number } {
  if (!pieces.length) return { coords: [], gap: 0 };
  const left = pieces.slice();
  const first = left.shift()!;
  let chain = first.coords.slice();
  let head = first.first, tail = first.last;
  // orient the first piece towards whichever end the second piece touches
  const next = left[0];
  if (next && (joins(chain[0], head, next.coords[0], next.first) || joins(chain[0], head, next.coords[next.coords.length - 1], next.last))) {
    chain.reverse();
    [head, tail] = [tail, head];
  }
  let gap = 0;
  while (left.length) {
    const end = chain[chain.length - 1];
    let pick = -1, rev = false;
    // prefer relation order, then any piece that touches the end
    for (let i = 0; i < left.length && pick < 0; i++) {
      const p = left[i];
      if (joins(end, tail, p.coords[0], p.first)) { pick = i; rev = false; }
      else if (joins(end, tail, p.coords[p.coords.length - 1], p.last)) { pick = i; rev = true; }
    }
    if (pick < 0) {
      // bridge the smallest gap if it is short; otherwise stop
      let best = Infinity;
      left.forEach((p, i) => {
        const d0 = haversine(end, p.coords[0]), d1 = haversine(end, p.coords[p.coords.length - 1]);
        if (d0 < best) { best = d0; pick = i; rev = false; }
        if (d1 < best) { best = d1; pick = i; rev = true; }
      });
      if (best > 400) break;
      gap += best;
    }
    const p = left.splice(pick, 1)[0];
    const c = rev ? p.coords.slice().reverse() : p.coords;
    chain = chain.concat(joins(end, tail, c[0], rev ? p.last : p.first) ? c.slice(1) : c);
    tail = rev ? p.first : p.last;
  }
  return { coords: chain, gap };
}

export async function loadRelation(id: number, onStatus?: (m: string) => void): Promise<Track> {
  const res = await overpass(`[out:json][timeout:60];rel(${id});out body;way(r);out geom;`, onStatus);
  return relationTrack(res.elements, id);
}

export function relationTrack(elements: OsmElement[], id: number): Track {
  const rel = elements.find((e): e is OsmRelation => e.type === 'relation' && e.id === id);
  if (!rel) throw new Error(`Route ${id} was not found on OpenStreetMap`);
  const ways = new Map<number, OsmWay>();
  for (const e of elements) if (e.type === 'way') ways.set(e.id, e);
  const pieces: Piece[] = [];
  for (const m of rel.members) {
    if (m.type !== 'way' || /platform|stop|guidepost|alternative|excursion|approach/.test(m.role)) continue;
    const w = ways.get(m.ref);
    if (!w?.geometry?.length) continue;
    pieces.push({ coords: w.geometry.map((g) => [g.lat, g.lon] as LL), first: w.nodes[0], last: w.nodes[w.nodes.length - 1] });
  }
  const { coords, gap } = stitch(pieces);
  if (coords.length < 2) throw new Error('That route has no usable path geometry');
  const t = rel.tags ?? {};
  return { name: t.name ?? t.ref ?? `Route ${id}`, points: dedupe(coords), gapMeters: Math.round(gap), source: { kind: 'osm-relation', id }, tags: t };
}

export function parseGpx(xml: string, file: string): Track {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file is not valid GPX');
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (nodes.length < 2) nodes = [...doc.getElementsByTagName('rtept')];
  const points = nodes.map((n) => [Number(n.getAttribute('lat')), Number(n.getAttribute('lon'))] as LL).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (points.length < 2) throw new Error('No track points found in that GPX file');
  const name = doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim() || file.replace(/\.gpx$/i, '');
  return { name, points: dedupe(points), gapMeters: 0, source: { kind: 'gpx', file } };
}

function dedupe(points: LL[]): LL[] {
  const out: LL[] = [points[0]];
  for (const p of points.slice(1)) if (haversine(out[out.length - 1], p) > 0.5) out.push(p);
  return out;
}
