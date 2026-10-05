import { LocalFrame, simplifyIdx, type LL } from './geo/geo';
import type { Guide } from './ai/guide';
import type { TrailFacts } from './geo/facts';

/** Everything the phone needs to guide a walk. Small enough for a QR code. */
export interface Pack {
  v: 1;
  name: string;
  region?: string;
  route: string;
  cues: [at: number, text: string][];
  briefing: string;
  lengthM: number;
  ascentM: number;
  walkMinutes: number;
  loop: boolean;
}

function encodePolyline(pts: LL[]): string {
  let out = '', pLat = 0, pLon = 0;
  const enc = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    while (s >= 0x20) { out += String.fromCharCode((0x20 | (s & 0x1f)) + 63); s >>= 5; }
    out += String.fromCharCode(s + 63);
  };
  for (const [la, lo] of pts) {
    const a = Math.round(la * 1e5), b = Math.round(lo * 1e5);
    enc(a - pLat); enc(b - pLon);
    pLat = a; pLon = b;
  }
  return out;
}

export function decodePolyline(s: string): LL[] {
  const pts: LL[] = [];
  let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let r = 0, sh = 0, b: number;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < s.length) { lat += dec(); lon += dec(); pts.push([lat / 1e5, lon / 1e5]); }
  return pts;
}

export function makePack(f: TrailFacts, g: Guide, region?: string): Pack {
  const pts = f.profile.pts;
  const frame = new LocalFrame(pts[Math.floor(pts.length / 2)]);
  const keep = simplifyIdx(pts.map((p) => frame.toXY(p)), 6);
  return {
    v: 1, name: f.name, region, route: encodePolyline(keep.map((i) => pts[i])),
    cues: g.cues.map((c) => [Math.round(c.at), c.text]), briefing: g.briefing,
    lengthM: f.lengthM, ascentM: f.ascentM, walkMinutes: f.walkMinutes, loop: f.loop,
  };
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePack(p: Pack): Promise<string> {
  return b64url(await pipe(new TextEncoder().encode(JSON.stringify(p)), new CompressionStream('deflate-raw')));
}

export async function decodePack(s: string): Promise<Pack> {
  const json = new TextDecoder().decode(await pipe(unb64url(s), new DecompressionStream('deflate-raw')));
  const p = JSON.parse(json) as Pack;
  if (p.v !== 1 || !Array.isArray(p.cues)) throw new Error('This walk link is not valid.');
  return p;
}

/** Link to the phone view. The pack lives after the #, which browsers do not send to any server. */
export async function walkLink(p: Pack): Promise<string> {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  return `${base}#/walk/${await encodePack(p)}`;
}
