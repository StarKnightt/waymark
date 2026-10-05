import type { BBox } from './geo';

/** A grid of elevations in Web Mercator pixel space at zoom z. */
export interface Dem {
  z: number;
  /** Global pixel coordinates of the grid's top-left sample. */
  px0: number;
  py0: number;
  cols: number;
  rows: number;
  data: Float32Array;
}

const TILE = 256;
const URL_TPL = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export const lonToPx = (lon: number, z: number) => ((lon + 180) / 360) * TILE * 2 ** z;
export const latToPx = (lat: number, z: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};
export const pxToLon = (px: number, z: number) => (px / (TILE * 2 ** z)) * 360 - 180;
export const pxToLat = (py: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * py) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

/** Picks the most detailed zoom that covers the box with at most `maxTiles` tiles. */
export function pickZoom(b: BBox, maxTiles = 16, maxZ = 14): number {
  for (let z = maxZ; z > 8; z--) {
    const nx = Math.floor(lonToPx(b.e, z) / TILE) - Math.floor(lonToPx(b.w, z) / TILE) + 1;
    const ny = Math.floor(latToPx(b.s, z) / TILE) - Math.floor(latToPx(b.n, z) / TILE) + 1;
    if (nx * ny <= maxTiles) return z;
  }
  return 9;
}

async function decodeTile(blob: Blob): Promise<Float32Array> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(TILE, TILE);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, TILE, TILE).data;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return out;
}

/** Downloads open Terrarium elevation tiles (AWS Open Data) and crops them to the box. */
export async function loadDem(b: BBox, onStatus?: (m: string) => void): Promise<Dem> {
  const z = pickZoom(b);
  const x0 = Math.floor(lonToPx(b.w, z)), x1 = Math.ceil(lonToPx(b.e, z));
  const y0 = Math.floor(latToPx(b.n, z)), y1 = Math.ceil(latToPx(b.s, z));
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x1 - 1) / TILE);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y1 - 1) / TILE);
  const cols = x1 - x0, rows = y1 - y0;
  const data = new Float32Array(cols * rows);
  const jobs: Promise<void>[] = [];
  let done = 0;
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    jobs.push((async () => {
      const res = await fetch(URL_TPL(z, tx, ty));
      if (!res.ok) throw new Error(`Elevation tile ${z}/${tx}/${ty}: HTTP ${res.status}`);
      const tile = await decodeTile(await res.blob());
      for (let y = 0; y < TILE; y++) {
        const gy = ty * TILE + y - y0;
        if (gy < 0 || gy >= rows) continue;
        for (let x = 0; x < TILE; x++) {
          const gx = tx * TILE + x - x0;
          if (gx < 0 || gx >= cols) continue;
          data[gy * cols + gx] = tile[y * TILE + x];
        }
      }
      onStatus?.(`Elevation ${++done}/${total}`);
    })());
  }
  await Promise.all(jobs);
  return { z, px0: x0, py0: y0, cols, rows, data };
}

/** Bilinear elevation in metres at a coordinate. */
export function demAt(d: Dem, lat: number, lon: number): number {
  const fx = Math.min(d.cols - 1.001, Math.max(0, lonToPx(lon, d.z) - d.px0 - 0.5));
  const fy = Math.min(d.rows - 1.001, Math.max(0, latToPx(lat, d.z) - d.py0 - 0.5));
  const x = Math.floor(fx), y = Math.floor(fy), tx = fx - x, ty = fy - y;
  const i = y * d.cols + x;
  const a = d.data[i], b = d.data[i + 1], c = d.data[i + d.cols], e = d.data[i + d.cols + 1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + e * tx * ty;
}

/** Encodes a DEM as a Terrarium PNG so it can be shipped as a static file. */
export async function demToPng(d: Dem): Promise<Blob> {
  const c = new OffscreenCanvas(d.cols, d.rows);
  const g = c.getContext('2d')!;
  const img = g.createImageData(d.cols, d.rows);
  for (let i = 0; i < d.data.length; i++) {
    const v = Math.max(0, Math.min(65535.99, d.data[i] + 32768));
    img.data[i * 4] = Math.floor(v / 256);
    img.data[i * 4 + 1] = Math.floor(v) % 256;
    img.data[i * 4 + 2] = Math.floor((v - Math.floor(v)) * 256);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

export async function demFromPng(url: string, meta: Omit<Dem, 'data'>): Promise<Dem> {
  const bmp = await createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(meta.cols, meta.rows);
  const g = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!;
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, meta.cols, meta.rows).data;
  const data = new Float32Array(meta.cols * meta.rows);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  return { ...meta, data };
}
