import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { pointInRing, type LL, type XY } from '../geo/geo';
import type { Context } from '../geo/context';
import type { Ground } from './terrain';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function conifer(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 2.2, 5).translate(0, 1.1, 0);
  const a = new THREE.ConeGeometry(2.4, 5.2, 7).translate(0, 4.2, 0);
  const b = new THREE.ConeGeometry(1.8, 4.2, 7).translate(0, 6.6, 0);
  const c = new THREE.ConeGeometry(1.1, 3.0, 7).translate(0, 8.8, 0);
  const paint = (geo: THREE.BufferGeometry, col: THREE.Color) => {
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.toArray(arr, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo.toNonIndexed();
  };
  const leaf = new THREE.Color('#4f8152');
  return mergeGeometries([paint(trunk, new THREE.Color('#5a4030')), paint(a, leaf), paint(b, leaf.clone().multiplyScalar(1.08)), paint(c, leaf.clone().multiplyScalar(1.16))])!;
}

function broadleaf(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.25, 0.35, 2.6, 5).translate(0, 1.3, 0);
  const crown = new THREE.IcosahedronGeometry(2.6, 0).translate(0, 4.6, 0);
  const paint = (geo: THREE.BufferGeometry, col: THREE.Color) => {
    const g2 = geo.index ? geo.toNonIndexed() : geo;
    const n = g2.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.toArray(arr, i * 3);
    g2.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g2;
  };
  return mergeGeometries([paint(trunk, new THREE.Color('#6b4d36')), paint(crown, new THREE.Color('#77a04e'))])!;
}

/** Instanced trees scattered inside OSM woodland polygons. */
export function buildTrees(g: Ground, ctx: Context, max = 26000, route: LL[] = [], isForest: (x: number, z: number) => boolean = () => true, treelineY = Infinity): THREE.Group {
  const group = new THREE.Group();
  // the trail runs through a clearing, so keep trees off a corridor along the route
  const CELL = 20;
  const corridor = new Set<string>();
  for (const p of route) {
    const [x, y] = g.frame.toXY(p);
    const cx = Math.floor(x / CELL), cz = Math.floor(-y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) corridor.add(`${cx + i},${cz + j}`);
  }
  const forests = ctx.areas.filter((a) => a.kind === 'forest').map((a) => {
    const ring: XY[] = a.ring.map((p) => { const [x, y] = g.frame.toXY(p); return [x, -y]; });
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      x0 = Math.min(x0, ring[i][0]); x1 = Math.max(x1, ring[i][0]); z0 = Math.min(z0, ring[i][1]); z1 = Math.max(z1, ring[i][1]);
      area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return { ring, x0: Math.max(x0, g.x0), x1: Math.min(x1, g.x1), z0: Math.max(z0, g.z0), z1: Math.min(z1, g.z1), area: Math.abs(area / 2) };
  }).filter((f) => f.x1 > f.x0 && f.z1 > f.z0);
  const totalArea = forests.reduce((a, f) => a + Math.min(f.area, (f.x1 - f.x0) * (f.z1 - f.z0)), 0);
  if (!totalArea) return group;
  const spacing = Math.max(9, Math.sqrt(totalArea / max));
  const rand = rng(42);
  const spots: { x: number; z: number; s: number; r: number; broad: boolean }[] = [];
  const lowIsBroad = g.maxEle < 1800;
  for (const f of forests) {
    for (let x = f.x0; x < f.x1; x += spacing) for (let z = f.z0; z < f.z1; z += spacing) {
      const px = x + (rand() - 0.5) * spacing * 0.9, pz = z + (rand() - 0.5) * spacing * 0.9;
      if (corridor.has(`${Math.floor(px / CELL)},${Math.floor(pz / CELL)}`) || !isForest(px, pz)) continue;
      if (g.heightAtXZ(px, pz) > treelineY - 50 * rand() || !pointInRing([px, pz], f.ring)) continue;
      spots.push({ x: px, z: pz, s: 0.75 + rand() * 0.7, r: rand() * Math.PI * 2, broad: lowIsBroad && rand() < 0.45 });
      if (spots.length >= max) break;
    }
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
  for (const broad of [false, true]) {
    const list = spots.filter((s) => s.broad === broad);
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(broad ? broadleaf() : conifer(), mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    list.forEach((s, i) => {
      const y = g.heightAtXZ(s.x, s.z);
      q.setFromAxisAngle(up, s.r);
      const k = s.s * g.exaggeration;
      m.compose(new THREE.Vector3(s.x, y - 0.5, s.z), q, new THREE.Vector3(k, k * (0.9 + 0.3 * ((i * 7) % 5) / 5), k));
      mesh.setMatrixAt(i, m);
      const v = 0.82 + (((i * 7) % 11) / 11) * 0.36;
      col.setRGB(v * (0.97 + (((i * 13) % 5) / 5) * 0.06), v, v * 0.96);
      mesh.setColorAt(i, col);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.count = spots.length;
  return group;
}

/** Flat, slightly glossy surfaces for lakes, set just above the terrain at the shoreline height. */
export function buildWater(g: Ground, ctx: Context): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#2f6f8a', roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0.92 });
  // clip each lake to the slab (Sutherland-Hodgman against the four edges, in x/north space)
  const clip = (poly: XY[]): XY[] => {
    const edges: [(p: XY) => boolean, (a: XY, b: XY) => XY][] = [
      [(p) => p[0] >= g.x0, (a, b) => [g.x0, a[1] + ((b[1] - a[1]) * (g.x0 - a[0])) / (b[0] - a[0])]],
      [(p) => p[0] <= g.x1, (a, b) => [g.x1, a[1] + ((b[1] - a[1]) * (g.x1 - a[0])) / (b[0] - a[0])]],
      [(p) => p[1] <= -g.z0, (a, b) => [a[0] + ((b[0] - a[0]) * (-g.z0 - a[1])) / (b[1] - a[1]), -g.z0]],
      [(p) => p[1] >= -g.z1, (a, b) => [a[0] + ((b[0] - a[0]) * (-g.z1 - a[1])) / (b[1] - a[1]), -g.z1]],
    ];
    let out = poly;
    for (const [inside, cut] of edges) {
      const src = out;
      out = [];
      for (let i = 0; i < src.length; i++) {
        const a = src[i], b = src[(i + 1) % src.length];
        if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); }
        else if (inside(a)) out.push(cut(a, b));
      }
      if (!out.length) break;
    }
    return out;
  };
  for (const a of ctx.areas) {
    if (a.kind !== 'water' || a.ring.length < 4) continue;
    const poly = clip(a.ring.map((p) => g.frame.toXY(p)));
    if (poly.length < 3) continue;
    const pts = poly.map(([x, y]) => new THREE.Vector2(x, y));
    const shoreEle = a.ring.map((p) => g.ele(p)).sort((x, y) => x - y);
    const ele = shoreEle[Math.floor(shoreEle.length * 0.3)];
    const shape = new THREE.Shape(pts);
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = g.y(ele) + 1.2;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** The route as a constant-width line (in pixels) with a dark casing, a little above the ground. */
export function buildRoute(g: Ground, points: LL[], color = '#f2c230'): { mesh: THREE.Group; curve: THREE.CatmullRomCurve3; setProgress: (t: number) => void } {
  const step = Math.max(1, Math.floor(points.length / 1200));
  const v = points.filter((_, i) => i % step === 0 || i === points.length - 1).map((p) => g.toScene(p, 4));
  const curve = new THREE.CatmullRomCurve3(v, false, 'centripetal');
  const flat = v.flatMap((p) => [p.x, p.y, p.z]);
  const group = new THREE.Group();
  const casingGeo = new LineGeometry();
  casingGeo.setPositions(flat);
  const casing = new Line2(casingGeo, new LineMaterial({ color: 0x1d2b24, linewidth: 9, worldUnits: false, depthWrite: false }));
  casing.renderOrder = 1;
  const lineGeo = new LineGeometry();
  lineGeo.setPositions(flat);
  const bright = new THREE.Color(color), dim = new THREE.Color('#f7e3a1');
  const colors = new Float32Array(v.length * 3);
  let last = -1;
  const setProgress = (t: number) => {
    const k = Math.round(t * (v.length - 1));
    if (k === last) return;
    last = k;
    for (let i = 0; i < v.length; i++) (i <= k ? bright : dim).toArray(colors, i * 3);
    lineGeo.setColors(colors);
  };
  setProgress(1);
  const line = new Line2(lineGeo, new LineMaterial({ vertexColors: true, linewidth: 5, worldUnits: false, depthWrite: false }));
  line.renderOrder = 2;
  group.add(casing, line);
  return { mesh: group, curve, setProgress };
}

/** Other footpaths and tracks as thin pale lines, like the dashed paths on a printed map. */
export function buildPaths(g: Ground, ctx: Context): THREE.LineSegments {
  const verts: number[] = [];
  for (const p of ctx.paths) {
    if (!/path|footway|track|steps|bridleway/.test(p.kind)) continue;
    const pts = p.coords.map((c) => g.toScene(c, 1.4));
    const inside = (v: THREE.Vector3) => v.x > g.x0 && v.x < g.x1 && v.z > g.z0 && v.z < g.z1;
    for (let i = 0; i + 1 < pts.length; i++) if (inside(pts[i]) && inside(pts[i + 1])) verts.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const line = new THREE.LineSegments(geo, new THREE.LineDashedMaterial({ color: '#f4efe2', dashSize: 14, gapSize: 9, transparent: true, opacity: 0.75 }));
  line.computeLineDistances();
  return line;
}

/** Small buildings, mostly near trailheads. */
export function buildBuildings(g: Ground, ctx: Context, max = 2500): THREE.InstancedMesh | null {
  const list = ctx.buildings.filter((ring) => {
    const [x, y] = g.frame.toXY(ring[0]);
    return x > g.x0 + 10 && x < g.x1 - 10 && -y > g.z0 + 10 && -y < g.z1 - 10;
  }).slice(0, max);
  if (!list.length) return null;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: '#e9e3d6', roughness: 0.9 }), list.length);
  const m = new THREE.Matrix4();
  list.forEach((ring, i) => {
    const xy = ring.map((p) => g.frame.toXY(p));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cz = -(y0 + y1) / 2;
    const w = Math.max(4, x1 - x0), d = Math.max(4, y1 - y0);
    m.compose(new THREE.Vector3(cx, g.heightAtXZ(cx, cz) - 0.5, cz), new THREE.Quaternion(), new THREE.Vector3(w, 6 * g.exaggeration, d));
    mesh.setMatrixAt(i, m);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A waymark post with a painted blaze plate on top. */
export function waymarkPost(height: number): THREE.Group {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, height, 6).translate(0, height / 2, 0), new THREE.MeshStandardMaterial({ color: '#6e5338', roughness: 0.9 }));
  const plate = new THREE.Mesh(new THREE.BoxGeometry(5.2, 7.5, 1.2).translate(0, height + 3.2, 0), new THREE.MeshStandardMaterial({ color: '#f2c230', emissive: '#f2c230', emissiveIntensity: 0.25, roughness: 0.6 }));
  plate.name = 'plate';
  post.castShadow = plate.castShadow = true;
  const g = new THREE.Group();
  g.add(post, plate);
  return g;
}
