// Developer entry used by tools/build-trails.mjs to pre-build demo trails with the app's own code.
import { demToPng } from './geo/elevation';
import type { LL } from './geo/geo';
import { ATTRIBUTION, buildFromRelation, buildFromStops, type TrailFile } from './trail';

async function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsDataURL(b);
  });
}

export interface TrailSpec { id: string; name?: string; region?: string; relation?: number; stops?: LL[]; prefer?: string | null }

declare global { interface Window { wmBuild: (spec: TrailSpec, server?: string) => Promise<unknown> } }

window.wmBuild = async (spec, server) => {
  const useOsmApi = server === 'osmapi';
  if (server && !useOsmApi) sessionStorage.setItem('waymark.overpass.good', server);
  const log: string[] = [];
  const id = spec.id;
  const b = spec.relation
    ? await buildFromRelation(spec.relation, (m) => log.push(m), useOsmApi)
    : await buildFromStops(id, spec.name ?? id, spec.stops!, spec.prefer ?? null, (m) => log.push(m), useOsmApi);
  if (spec.name) b.track.name = spec.name;
  if (spec.region) b.track.tags = { ...b.track.tags, 'waymark:region': spec.region };
  const { data, ...demMeta } = b.dem;
  const file: TrailFile = { id, track: b.track, bbox: b.bbox, dem: demMeta, ctx: b.ctx, attribution: ATTRIBUTION, builtAt: new Date().toISOString() };
  const png = await blobToDataUrl(await demToPng(b.dem));
  const f = b.facts;
  return {
    file, png, log,
    report: {
      name: f.name, lengthM: f.lengthM, ascentM: f.ascentM, descentM: f.descentM, highest: f.highest, loop: f.loop, outAndBack: f.outAndBack,
      walkMinutes: f.walkMinutes, gap: b.track.gapMeters, dem: `${demMeta.cols}x${demMeta.rows} z${demMeta.z}`, data: data.length,
      counts: { paths: b.ctx.paths.length, areas: b.ctx.areas.length, streams: b.ctx.streams.length, buildings: b.ctx.buildings.length, pois: b.ctx.pois.length },
      summary: f.summary,
      waymarks: f.waymarks.map((w) => `${w.id} ${(w.at / 1000).toFixed(2)}km ${w.ele}m [${w.kinds.join(',')}]${w.turn ? ' ' + w.turn : ''}${w.required ? ' *' : ''} :: ${w.facts.join(' | ')}`),
    },
  };
};
