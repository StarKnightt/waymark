// Build-time data source: the main OpenStreetMap API. Used only to pre-build the demo trails
// (a handful of requests); the app itself uses Overpass, as the OSM API usage policy asks.
import type { BBox } from './geo';
import type { OsmElement, OsmMember } from './overpass';

const API = 'https://api.openstreetmap.org/api/0.6';

interface RawNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
interface RawWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> }
interface RawRel { type: 'relation'; id: number; members: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[]; tags?: Record<string, string> }
type Raw = RawNode | RawWay | RawRel;

function withGeometry(raw: Raw[]): OsmElement[] {
  const nodes = new Map<number, RawNode>();
  const ways = new Map<number, RawWay>();
  for (const e of raw) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
  }
  const geom = (w: RawWay) => w.nodes.map((n) => nodes.get(n)).filter((n): n is RawNode => !!n).map((n) => ({ lat: n.lat, lon: n.lon }));
  const out: OsmElement[] = [];
  for (const e of raw) {
    if (e.type === 'node') { if (e.tags) out.push(e); continue; }
    if (e.type === 'way') { out.push({ ...e, geometry: geom(e) }); continue; }
    out.push({
      ...e,
      members: e.members.map((m): OsmMember => (m.type === 'way' && ways.has(m.ref) ? { ...m, geometry: geom(ways.get(m.ref)!) } : m)),
    });
  }
  return out;
}

export async function osmApiRelation(id: number): Promise<OsmElement[]> {
  const res = await fetch(`${API}/relation/${id}/full.json`);
  if (!res.ok) throw new Error(`OSM API relation ${id}: HTTP ${res.status}`);
  return withGeometry((await res.json()).elements as Raw[]);
}

/** Downloads a box in tiles (the API caps each call by area and node count) and merges the results. */
export async function osmApiMap(b: BBox, onStatus?: (m: string) => void): Promise<OsmElement[]> {
  const split = Math.max(1, Math.ceil(Math.max(b.n - b.s, b.e - b.w) / 0.045));
  const seen = new Map<string, Raw>();
  let done = 0;
  for (let i = 0; i < split; i++) for (let j = 0; j < split; j++) {
    const s = b.s + ((b.n - b.s) * i) / split, n = b.s + ((b.n - b.s) * (i + 1)) / split;
    const w = b.w + ((b.e - b.w) * j) / split, e = b.w + ((b.e - b.w) * (j + 1)) / split;
    const res = await fetch(`${API}/map.json?bbox=${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`);
    if (!res.ok) throw new Error(`OSM API map: HTTP ${res.status}`);
    for (const el of (await res.json()).elements as Raw[]) seen.set(`${el.type}${el.id}`, el);
    onStatus?.(`Map tiles ${++done}/${split * split}`);
  }
  return withGeometry([...seen.values()]);
}
