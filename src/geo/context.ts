import { haversine, type BBox, type LL } from './geo';
import { bboxQL, overpass, type OsmElement } from './overpass';

export interface PathWay { id: number; nodes: number[]; coords: LL[]; kind: string; name?: string; bridge?: boolean; tunnel?: boolean }
export interface Poi { kind: PoiKind; name?: string; lat: number; lon: number; ele?: number }
export type PoiKind =
  | 'peak' | 'saddle' | 'viewpoint' | 'spring' | 'drinking_water' | 'waterfall' | 'shelter' | 'hut' | 'picnic'
  | 'bench' | 'toilets' | 'parking' | 'cafe' | 'information' | 'cairn' | 'cave' | 'camp';
export interface Area { kind: 'water' | 'river' | 'wetland' | 'forest' | 'rock' | 'scree' | 'glacier' | 'grass' | 'scrub' | 'built' | 'farm'; name?: string; ring: LL[]; holes?: LL[][] }
export interface Stream { kind: string; name?: string; coords: LL[] }

export interface Context {
  bbox: BBox;
  paths: PathWay[];
  areas: Area[];
  streams: Stream[];
  buildings: LL[][];
  pois: Poi[];
}

const HIGHWAYS = 'path|footway|track|steps|bridleway|cycleway|pedestrian|service|unclassified|residential|living_street|tertiary|secondary|primary|trunk|road';

export function contextQuery(b: BBox) {
  return `[out:json][timeout:120][bbox:${bboxQL(b)}];
(
  way["highway"~"^(${HIGHWAYS})$"];
  way["waterway"~"^(river|stream|brook|canal|drain|waterfall|riverbank)$"];
  way["natural"~"^(water|wood|scree|bare_rock|glacier|grassland|heath|scrub|wetland)$"];
  rel["natural"~"^(water|wood|scree|bare_rock|glacier)$"];
  way["landuse"~"^(forest|meadow|grass|farmland|residential|reservoir)$"];
  rel["landuse"~"^(forest|reservoir)$"];
  way["building"];
  node["natural"~"^(peak|saddle|spring|waterfall|cave_entrance)$"];
  node["waterway"="waterfall"];
  node["tourism"~"^(viewpoint|picnic_site|information|alpine_hut|wilderness_hut|camp_site)$"];
  way["tourism"~"^(viewpoint|alpine_hut|wilderness_hut|picnic_site)$"];
  node["amenity"~"^(drinking_water|water_point|bench|shelter|toilets|parking|cafe|restaurant)$"];
  way["amenity"~"^(shelter|parking|cafe|restaurant|toilets)$"];
  node["man_made"="cairn"];
);
out geom;`;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
const ll = (g: { lat: number; lon: number }): LL => [round(g.lat), round(g.lon)];

function areaKind(t: Record<string, string>): Area['kind'] | null {
  const n = t.natural, l = t.landuse;
  if (n === 'water' && /river|stream|canal|ditch|drain|rapids/.test(t.water ?? '')) return 'river';
  if (t.waterway === 'riverbank') return 'river';
  if (n === 'wetland') return 'wetland';
  if (n === 'water' || l === 'reservoir') return 'water';
  if (n === 'wood' || l === 'forest') return 'forest';
  if (n === 'bare_rock') return 'rock';
  if (n === 'scree') return 'scree';
  if (n === 'glacier') return 'glacier';
  if (n === 'grassland' || n === 'heath' || l === 'meadow' || l === 'grass') return 'grass';
  if (n === 'scrub') return 'scrub';
  if (l === 'residential') return 'built';
  if (l === 'farmland') return 'farm';
  return null;
}

function poiKind(t: Record<string, string>): PoiKind | null {
  const n = t.natural, tour = t.tourism, a = t.amenity;
  if (n === 'peak') return 'peak';
  if (n === 'saddle') return 'saddle';
  if (n === 'spring') return 'spring';
  if (n === 'waterfall' || t.waterway === 'waterfall') return 'waterfall';
  if (n === 'cave_entrance') return 'cave';
  if (tour === 'viewpoint') return 'viewpoint';
  if (tour === 'picnic_site') return 'picnic';
  if (tour === 'information') return t.information === 'office' || t.information === 'board' || t.information === 'guidepost' || t.information === 'map' ? 'information' : null;
  if (tour === 'alpine_hut' || tour === 'wilderness_hut') return 'hut';
  if (tour === 'camp_site') return 'camp';
  if (a === 'drinking_water' || a === 'water_point') return 'drinking_water';
  if (a === 'bench') return 'bench';
  if (a === 'shelter') return 'shelter';
  if (a === 'toilets') return 'toilets';
  if (a === 'parking') return 'parking';
  if (a === 'cafe' || a === 'restaurant') return 'cafe';
  if (t.man_made === 'cairn') return 'cairn';
  return null;
}

function inRing(p: LL, ring: LL[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Joins multipolygon member pieces into closed rings by matching endpoints. */
function rings(pieces: LL[][]): LL[][] {
  const left = pieces.filter((p) => p.length > 1).map((p) => p.slice());
  const out: LL[][] = [];
  while (left.length) {
    let ring = left.shift()!;
    let grew = true;
    while (grew && haversine(ring[0], ring[ring.length - 1]) > 1) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i], end = ring[ring.length - 1];
        if (haversine(end, p[0]) < 1) ring = ring.concat(p.slice(1));
        else if (haversine(end, p[p.length - 1]) < 1) ring = ring.concat(p.slice().reverse().slice(1));
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length > 3) out.push(ring);
  }
  return out;
}

export function parseContext(elements: OsmElement[], bbox: BBox): Context {
  const ctx: Context = { bbox, paths: [], areas: [], streams: [], buildings: [], pois: [] };
  for (const e of elements) {
    const t = e.tags ?? {};
    if (e.type === 'node') {
      const k = poiKind(t);
      if (k) ctx.pois.push({ kind: k, name: t.name, lat: round(e.lat), lon: round(e.lon), ele: t.ele ? parseFloat(t.ele) || undefined : undefined });
      continue;
    }
    if (e.type === 'way') {
      const g = e.geometry?.map(ll) ?? [];
      if (g.length < 2) continue;
      if (t.highway) {
        ctx.paths.push({ id: e.id, nodes: e.nodes, coords: g, kind: t.highway, name: t.name ?? t.ref, bridge: !!t.bridge && t.bridge !== 'no', tunnel: !!t.tunnel && t.tunnel !== 'no' });
      } else if (t.waterway && t.waterway !== 'riverbank') {
        if (t.waterway === 'waterfall') ctx.pois.push({ kind: 'waterfall', name: t.name, lat: g[0][0], lon: g[0][1] });
        else ctx.streams.push({ kind: t.waterway, name: t.name, coords: g });
      } else if (t.building) {
        if (ctx.buildings.length < 6000) ctx.buildings.push(g);
      } else {
        const k = areaKind(t);
        if (k) ctx.areas.push({ kind: k, name: t.name, ring: g });
        const p = poiKind(t);
        if (p) {
          const c = g.reduce((a, q) => [a[0] + q[0] / g.length, a[1] + q[1] / g.length], [0, 0]);
          ctx.pois.push({ kind: p, name: t.name, lat: round(c[0]), lon: round(c[1]) });
        }
      }
      continue;
    }
    const k = areaKind(t);
    if (!k) continue;
    const outer = e.members.filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry?.length).map((m) => m.geometry!.map(ll));
    const inner = rings(e.members.filter((m) => m.type === 'way' && m.role === 'inner' && m.geometry?.length).map((m) => m.geometry!.map(ll)));
    for (const r of rings(outer)) {
      const holes = inner.filter((h) => inRing(h[0], r));
      ctx.areas.push({ kind: k, name: t.name, ring: r, ...(holes.length ? { holes } : {}) });
    }
  }
  return ctx;
}

export async function loadContext(b: BBox, onStatus?: (m: string) => void): Promise<Context> {
  const res = await overpass(contextQuery(b), onStatus, 120000);
  return parseContext(res.elements, b);
}
