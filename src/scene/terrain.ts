import * as THREE from 'three';
import { LocalFrame, type BBox, type LL } from '../geo/geo';
import { demAt, type Dem } from '../geo/elevation';
import type { Context } from '../geo/context';

/** Maps the trail's area to scene units (1 unit = 1 metre, y up, x east, z south). */
export class Ground {
  readonly frame: LocalFrame;
  readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number;
  readonly base: number;
  readonly minEle: number; readonly maxEle: number;
  constructor(readonly dem: Dem, readonly bbox: BBox, readonly exaggeration = 1.25) {
    this.frame = new LocalFrame([(bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2]);
    const sw = this.frame.toXY([bbox.s, bbox.w]), ne = this.frame.toXY([bbox.n, bbox.e]);
    this.x0 = sw[0]; this.x1 = ne[0]; this.z0 = -ne[1]; this.z1 = -sw[1];
    let lo = Infinity, hi = -Infinity;
    for (const v of dem.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    this.minEle = lo; this.maxEle = hi;
    this.base = lo;
  }
  /** Elevation in metres at a coordinate. */
  ele(ll: LL) { return demAt(this.dem, ll[0], ll[1]); }
  /** Scene height for an elevation. */
  y(ele: number) { return (ele - this.base) * this.exaggeration; }
  toScene(ll: LL, lift = 0): THREE.Vector3 {
    const [x, y] = this.frame.toXY(ll);
    return new THREE.Vector3(x, this.y(this.ele(ll)) + lift, -y);
  }
  heightAtXZ(x: number, z: number) { return this.y(this.ele(this.frame.toLL([x, -z]))); }
  get width() { return this.x1 - this.x0; }
  get depth() { return this.z1 - this.z0; }
}

export const FOREST = '#3d6a47';
const LAND: Record<string, string> = {
  forest: FOREST, water: '#3b7891', river: '#3f7f95', rock: '#7d776c', scree: '#8b857a', glacier: '#e9eef2',
  grass: '#8ea55d', scrub: '#6f8a4b', built: '#b9b0a0', farm: '#a8ad6a', wetland: '#7b9277',
};

/** Latitude-based treeline estimate in metres (about 3,200 m in the Sierra Nevada, 2,150 m in the Canadian Rockies). */
export const treeline = (lat: number) => Math.max(300, Math.min(4200, 3900 - 75 * (Math.abs(lat) - 28)));

/** Paints OSM land cover into a texture aligned with the terrain. */
export function landcoverTexture(g: Ground, ctx: Context, size = 2048): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const k = c.getContext('2d')!;
  k.fillStyle = '#000';
  k.fillRect(0, 0, size, size);
  const px = (ll: LL): [number, number] => {
    const [x, y] = g.frame.toXY(ll);
    return [((x - g.x0) / g.width) * size, ((-y - g.z0) / g.depth) * size];
  };
  const order: string[] = ['farm', 'grass', 'wetland', 'built', 'scrub', 'forest', 'scree', 'rock', 'glacier', 'river', 'water'];
  for (const kind of order) {
    k.fillStyle = LAND[kind];
    for (const a of ctx.areas) {
      if (a.kind !== kind || a.ring.length < 3) continue;
      k.beginPath();
      for (const r of [a.ring, ...(a.holes ?? [])]) {
        r.forEach((p, i) => { const [x, y] = px(p); if (i) k.lineTo(x, y); else k.moveTo(x, y); });
        k.closePath();
      }
      k.fill('evenodd');
    }
  }
  k.strokeStyle = LAND.river;
  k.lineCap = 'round';
  for (const s of ctx.streams) {
    k.lineWidth = s.kind === 'river' ? 6 : 2.5;
    k.beginPath();
    s.coords.forEach((p, i) => { const [x, y] = px(p); if (i) k.lineTo(x, y); else k.moveTo(x, y); });
    k.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  // a lookup for placing trees only where the painted cover is woodland
  const img = k.getImageData(0, 0, size, size).data;
  // canvas pixels are sRGB bytes; THREE.Color would convert to linear, so read the hex directly
  const hex = parseInt(FOREST.slice(1), 16);
  const fr = (hex >> 16) & 255, fg = (hex >> 8) & 255, fb = hex & 255;
  t.userData.isForest = (x: number, z: number) => {
    const i = (Math.floor(((z - g.z0) / g.depth) * size) * size + Math.floor(((x - g.x0) / g.width) * size)) * 4;
    return i >= 0 && i < img.length && Math.abs(img[i] - fr) + Math.abs(img[i + 1] - fg) + Math.abs(img[i + 2] - fb) < 12;
  };
  return t;
}

/** The relief slab: a height-field top with earth-coloured side walls, like a museum terrain model. */
export function buildTerrain(g: Ground, cover: THREE.Texture, res = 384): THREE.Group {
  const group = new THREE.Group();
  const nx = res, nz = Math.max(16, Math.round(res * (g.depth / g.width)));
  const geo = new THREE.PlaneGeometry(g.width, g.depth, nx - 1, nz - 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate((g.x0 + g.x1) / 2, 0, (g.z0 + g.z1) / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const ele = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const e = g.ele(g.frame.toLL([x, -z]));
    ele[i] = e;
    pos.setY(i, g.y(e));
  }
  geo.setAttribute('ele', new THREE.BufferAttribute(ele, 1));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, map: cover });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uContour = { value: 50 * g.exaggeration };
    sh.uniforms.uSnow = { value: g.y(Math.max(treeline(g.frame.origin[0]) + 450, g.minEle + 0.82 * (g.maxEle - g.minEle))) };
    sh.uniforms.uTree = { value: g.y(treeline(g.frame.origin[0])) };
    sh.uniforms.uForest = { value: new THREE.Color(FOREST) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float ele;\nvarying float vEle;\nvarying float vY;\nvarying vec3 vN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEle = ele;\nvY = position.y;\nvN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uContour;\nuniform float uSnow;\nuniform float uTree;\nuniform vec3 uForest;\nvarying float vEle;\nvarying float vY;\nvarying vec3 vN;')
      .replace('#include <map_fragment>', `
        vec4 lc = texture2D(map, vMapUv);
        float slope = 1.0 - clamp(vN.y, 0.0, 1.0);
        vec3 meadow = vec3(0.47, 0.56, 0.33);
        vec3 rock = vec3(0.44, 0.42, 0.39);
        vec3 baseCol = mix(meadow, rock, smoothstep(0.25, 0.6, slope));
        float hasCover = step(0.02, lc.r + lc.g + lc.b);
        float forestish = 1.0 - step(0.06, distance(lc.rgb, uForest));
        float cover = hasCover * (1.0 - forestish * smoothstep(uTree - 80.0, uTree + 80.0, vY));
        vec3 col = mix(baseCol, lc.rgb, cover * 0.88);
        col = mix(col, vec3(0.93, 0.95, 0.97), smoothstep(uSnow - 40.0, uSnow + 60.0, vY) * (1.0 - smoothstep(0.55, 0.8, slope)));
        float c = vY / uContour;
        float w = fwidth(c);
        float line = 1.0 - smoothstep(0.0, w * 1.2, abs(fract(c - 0.5) - 0.5));
        float major = 1.0 - smoothstep(0.0, w * 1.6, abs(fract(c / 5.0 - 0.5) - 0.5) * 5.0);
        col = mix(col, col * 0.62, clamp(line * 0.55 + major * 0.35, 0.0, 0.8));
        diffuseColor.rgb = col;
      `);
  };
  const top = new THREE.Mesh(geo, mat);
  top.receiveShadow = true;
  top.castShadow = true;
  top.name = 'terrain';
  group.add(top);

  // side walls down to a common floor
  const floor = -Math.max(80, (g.maxEle - g.minEle) * 0.08) * g.exaggeration;
  const wallMat = new THREE.MeshStandardMaterial({ color: '#8a6c4e', roughness: 1, emissive: '#3a2a1c', emissiveIntensity: 0.55 });
  wallMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vH;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvH = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float band = sin(vH * 0.035) * 0.5 + 0.5;
        float fine = sin(vH * 0.21) * 0.5 + 0.5;
        diffuseColor.rgb *= mix(0.82, 1.08, band) * mix(0.94, 1.03, fine);`);
  };
  const edge = (idx: (k: number) => number, count: number) => {
    const verts: number[] = [];
    for (let k = 0; k < count - 1; k++) {
      const a = idx(k), b = idx(k + 1);
      const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
      const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
      verts.push(ax, ay, az, bx, by, bz, bx, floor, bz, ax, ay, az, bx, floor, bz, ax, floor, az);
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    wg.computeVertexNormals();
    const m = new THREE.Mesh(wg, wallMat);
    m.material.side = THREE.DoubleSide;
    m.castShadow = true;
    group.add(m);
  };
  edge((k) => k, nx); // north edge
  edge((k) => (nz - 1) * nx + k, nx); // south edge
  edge((k) => k * nx, nz); // west edge
  edge((k) => k * nx + nx - 1, nz); // east edge
  const bottom = new THREE.Mesh(new THREE.PlaneGeometry(g.width, g.depth), new THREE.MeshStandardMaterial({ color: '#3c3127', roughness: 1 }));
  bottom.rotation.x = Math.PI / 2;
  bottom.position.set((g.x0 + g.x1) / 2, floor, (g.z0 + g.z1) / 2);
  group.add(bottom);
  group.userData.floor = floor;
  return group;
}
