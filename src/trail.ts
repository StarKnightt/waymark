import { bboxOf, type BBox, type LL } from './geo/geo';
import { loadContext, parseContext, type Context } from './geo/context';
import { demFromPng, loadDem, type Dem } from './geo/elevation';
import { buildFacts, type TrailFacts } from './geo/facts';
import { osmApiMap, osmApiRelation } from './geo/osmapi';
import { loadRelation, relationTrack, type Track } from './geo/route';
import { routeThrough } from './geo/router';

export interface TrailBundle {
  id: string;
  track: Track;
  bbox: BBox;
  dem: Dem;
  ctx: Context;
  facts: TrailFacts;
}

/** Stored next to a Terrarium PNG of the elevation grid. */
export interface TrailFile {
  id: string;
  track: Track;
  bbox: BBox;
  dem: Omit<Dem, 'data'>;
  ctx: Context;
  attribution: string;
  builtAt: string;
}

export const ATTRIBUTION = 'Map data © OpenStreetMap contributors (ODbL). Elevation: Terrarium tiles, AWS Open Data (Mapzen; sources include SRTM, NED, ETOPO1 and others).';

type Status = (m: string) => void;

async function context(b: BBox, onStatus?: Status, useOsmApi = false): Promise<Context> {
  return useOsmApi ? parseContext(await osmApiMap(b, onStatus), b) : loadContext(b, onStatus);
}

function inside(a: BBox, b: BBox) {
  return a.s >= b.s && a.w >= b.w && a.n <= b.n && a.e <= b.e;
}

export async function buildFromTrack(id: string, track: Track, onStatus?: Status, useOsmApi = false, known?: Context): Promise<TrailBundle> {
  const bbox = bboxOf(track.points, 1100);
  onStatus?.('Downloading elevation');
  const dem = await loadDem(bbox, onStatus);
  const near = bboxOf(track.points, 1050);
  onStatus?.('Downloading paths, water and landmarks');
  let ctx: Context;
  try {
    ctx = known && inside(near, known.bbox) ? { ...known } : await context(near, onStatus, useOsmApi);
  } catch (e) {
    // without map details the guide still covers climbs, distances, the high point and the finish
    onStatus?.(`Map details were unavailable (${(e as Error).message}). The guide will cover climbs and distances only.`);
    ctx = { bbox: near, paths: [], areas: [], streams: [], buildings: [], pois: [] };
  }
  ctx.bbox = bbox;
  onStatus?.('Working out junctions, climbs and landmarks');
  const facts = buildFacts(track.name, track.points, dem, ctx);
  return { id, track, bbox, dem, ctx, facts };
}

export async function buildFromRelation(relId: number, onStatus?: Status, useOsmApi = false): Promise<TrailBundle> {
  onStatus?.('Loading the route');
  const track = useOsmApi ? relationTrack(await osmApiRelation(relId), relId) : await loadRelation(relId, onStatus);
  return buildFromTrack(`osm-${relId}`, track, onStatus, useOsmApi);
}

/** Routes along footpaths through the given stops, then builds the trail. */
export async function buildFromStops(id: string, name: string, stops: LL[], prefer: string | null, onStatus?: Status, useOsmApi = false): Promise<TrailBundle> {
  onStatus?.('Downloading the path network');
  const area = bboxOf(stops, 1500);
  const ctx = await context(area, onStatus, useOsmApi);
  onStatus?.('Finding the walking route');
  const points = routeThrough(ctx.paths, stops, prefer ? new RegExp(prefer, 'i') : null);
  const track: Track = { name, points, gapMeters: 0, source: { kind: 'osm-route', stops } };
  return buildFromTrack(id, track, onStatus, useOsmApi, ctx);
}

export async function loadStatic(base: string, id: string): Promise<TrailBundle> {
  const file = (await (await fetch(`${base}trails/${id}.json`)).json()) as TrailFile;
  const dem = await demFromPng(`${base}trails/${id}.png`, file.dem);
  const facts = buildFacts(file.track.name, file.track.points, dem, file.ctx);
  return { id: file.id, track: file.track, bbox: file.bbox, dem, ctx: file.ctx, facts };
}
