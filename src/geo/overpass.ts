export interface OsmNode { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> }
export interface OsmWay {
  type: 'way'; id: number; nodes: number[]; tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
export interface OsmMember { type: 'node' | 'way' | 'relation'; ref: number; role: string; geometry?: { lat: number; lon: number }[] }
export interface OsmRelation { type: 'relation'; id: number; members: OsmMember[]; tags?: Record<string, string> }
export type OsmElement = OsmNode | OsmWay | OsmRelation;
export interface OsmResponse { elements: OsmElement[] }

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const GOOD_KEY = 'waymark.overpass.good';

/** Runs an Overpass QL query, trying each public server until one answers with JSON. */
export async function overpass(query: string, onStatus?: (msg: string) => void, timeoutMs = 90000): Promise<OsmResponse> {
  const good = sessionStorage.getItem(GOOD_KEY);
  const order = good ? [good, ...SERVERS.filter((s) => s !== good)] : SERVERS;
  const errors: string[] = [];
  for (const url of order) {
    const host = new URL(url).host;
    onStatus?.(`Asking ${host} for map data`);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok || !text.trimStart().startsWith('{')) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(text) as OsmResponse & { remark?: string };
      if (json.remark && /runtime error|timed out/i.test(json.remark)) throw new Error(json.remark.slice(0, 80));
      sessionStorage.setItem(GOOD_KEY, url);
      return json;
    } catch (e) {
      errors.push(`${host}: ${(e as Error).message}`);
    }
  }
  throw new Error(`No map server answered (${errors.join('; ')})`);
}

export const bboxQL = (b: { s: number; w: number; n: number; e: number }) =>
  [b.s, b.w, b.n, b.e].map((v) => v.toFixed(6)).join(',');
