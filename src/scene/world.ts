import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { getPosition } from 'suncalc';
import type { TrailBundle } from '../trail';
import type { Cue } from '../ai/guide';
import { Ground, buildTerrain, landcoverTexture, treeline } from './terrain';
import { buildBuildings, buildPaths, buildRoute, buildTrees, buildWater, waymarkPost } from './features';

export interface FlyoverHandlers {
  onCue?: (cue: Cue, index: number) => void;
  onProgress?: (t: number, at: number) => void;
  onEnd?: () => void;
}

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly labels: CSS2DRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 5, 200000);
  readonly controls: OrbitControls;
  private sun = new THREE.DirectionalLight('#fff4e0', 3.2);
  private hemi = new THREE.HemisphereLight('#cfe3ff', '#4a4032', 1.1);
  private trail = new THREE.Group();
  private ground: Ground | null = null;
  private route: ReturnType<typeof buildRoute> | null = null;
  private posts: { cue: Cue; group: THREE.Group; label: CSS2DObject; at: number }[] = [];
  private flight: { start: number; dur: number; map: (t: number) => number; handlers: FlyoverHandlers; next: number; length: number; heldAt: number } | null = null;
  private orbitSpin = 0;
  private tween: { from: THREE.Vector3; to: THREE.Vector3; tf: THREE.Vector3; tt: THREE.Vector3; t0: number; dur: number } | null = null;
  private smoothCurve: THREE.CatmullRomCurve3 | null = null;
  frames = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: new URLSearchParams(location.search).has('capture') });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    host.appendChild(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.addEventListener('start', () => { this.orbitSpin = 0; this.tween = null; });
    this.scene.add(this.sun, this.sun.target, this.hemi, this.trail);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    // keep the slab centred in the part of the screen the panel and profile strip leave free
    const clean = document.body.classList.contains('clean');
    const panel = w > 760 && !clean ? Math.min(410, w - 32) + 16 : 0;
    const strip = w > 760 && !clean ? 116 : 0;
    if (panel || strip) this.camera.setViewOffset(w, h, -panel / 2, strip / 2 - 40, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Puts the sun where it really is for this place and time. */
  setSun(date: Date) {
    if (!this.ground) return;
    const [lat, lon] = this.ground.frame.origin;
    const p = getPosition(date, lat, lon);
    const alt = Math.max(p.altitude, 0.06);
    const az = p.azimuth + Math.PI; // suncalc azimuth is measured from south
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    const g = this.ground;
    const c = new THREE.Vector3((g.x0 + g.x1) / 2, 0, (g.z0 + g.z1) / 2);
    const r = Math.max(g.width, g.depth);
    this.sun.position.copy(c).addScaledVector(dir, r * 1.4);
    this.sun.target.position.copy(c);
    const warm = THREE.MathUtils.clamp(1 - alt / 0.6, 0, 1);
    this.sun.color.setHSL(0.09, 0.45 + 0.4 * warm, 0.92 - 0.12 * warm);
    this.sun.intensity = 2.2 + 1.4 * Math.sin(Math.min(alt * 2, Math.PI / 2));
    this.hemi.intensity = 0.65 + 0.5 * (1 - warm);
    this.scene.fog = null;
  }

  setTrail(b: TrailBundle, cues: Cue[], opts: { lowPower?: boolean } = {}) {
    this.stopFlyover();
    this.trail.clear();
    this.posts = [];
    this.labels.domElement.replaceChildren();
    const g = new Ground(b.dem, b.bbox);
    this.ground = g;
    const cover = landcoverTexture(g, b.ctx, opts.lowPower ? 1024 : 2048);
    this.trail.add(buildTerrain(g, cover, opts.lowPower ? 220 : 400));
    this.trail.add(buildWater(g, b.ctx));
    this.trail.add(buildTrees(g, b.ctx, opts.lowPower ? 8000 : 26000, b.facts.profile.pts, cover.userData.isForest, g.y(treeline(g.frame.origin[0]))));
    const bld = buildBuildings(g, b.ctx);
    if (bld) this.trail.add(bld);
    this.trail.add(buildPaths(g, b.ctx));
    this.route = buildRoute(g, b.facts.profile.pts);
    this.trail.add(this.route.mesh);
    const span = Math.max(g.width, g.depth);
    const s = this.sun.shadow;
    s.mapSize.set(opts.lowPower ? 1024 : 4096, opts.lowPower ? 1024 : 4096);
    Object.assign(s.camera, { left: -span * 0.75, right: span * 0.75, top: span * 0.75, bottom: -span * 0.75, near: 10, far: span * 4 });
    s.camera.updateProjectionMatrix();
    s.map?.dispose();
    s.map = null as unknown as THREE.WebGLRenderTarget;
    this.setCues(b, cues);
    // smooth path for the camera: one control point every ~120 m
    const pts = b.facts.profile.pts;
    const every = Math.max(1, Math.round(120 / 10));
    const ctrl = pts.filter((_, i) => i % every === 0 || i === pts.length - 1).map((p) => g.toScene(p));
    this.smoothCurve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal', 0.5);
    this.frame(true);
  }

  setCues(b: TrailBundle, cues: Cue[]) {
    const g = this.ground!;
    for (const p of this.posts) this.trail.remove(p.group);
    this.posts = [];
    this.labels.domElement.replaceChildren();
    const h = Math.max(22, Math.max(g.width, g.depth) / 110);
    cues.forEach((cue, i) => {
      const group = waymarkPost(h);
      group.position.copy(g.toScene([cue.lat, cue.lon], 0));
      const el = document.createElement('button');
      el.className = 'pin';
      el.type = 'button';
      el.dataset.cue = cue.id;
      el.innerHTML = `<span class="num">${i + 1}</span><span class="t">${cue.title.replace(/[<>&]/g, '')}</span>`;
      el.addEventListener('click', () => this.host.dispatchEvent(new CustomEvent('pin', { detail: cue.id })));
      const label = new CSS2DObject(el);
      label.position.set(0, h + 12, 0);
      group.add(label);
      this.trail.add(group);
      this.posts.push({ cue, group, label, at: cue.at });
    });
    void b;
  }

  highlight(id: string | null) {
    for (const p of this.posts) {
      const on = p.cue.id === id;
      (p.label.element as HTMLElement).classList.toggle('on', on);
      const plate = p.group.getObjectByName('plate') as THREE.Mesh;
      (plate.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 1.4 : 0.25;
      p.group.scale.setScalar(on ? 1.35 : 1);
    }
  }

  /** Frames the whole slab from the south-east, the way a relief model is usually photographed. */
  frame(instant = false) {
    if (!this.ground) return;
    const g = this.ground;
    const c = new THREE.Vector3((g.x0 + g.x1) / 2, g.y((g.minEle + g.maxEle) / 2) * 0.5, (g.z0 + g.z1) / 2);
    const r = Math.hypot(g.width, g.depth) / 2;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const aspectFit = Math.max(1, 1.25 / this.camera.aspect);
    const d = (r / Math.tan(fov / 2)) * 1.08 * aspectFit;
    const pos = c.clone().add(new THREE.Vector3(0.5, 0.92, 0.82).normalize().multiplyScalar(d));
    this.controls.maxDistance = d * 2.2;
    this.controls.minDistance = r * 0.08;
    if (instant || reduceMotion()) {
      this.camera.position.copy(pos);
      this.controls.target.copy(c);
    } else this.moveTo(pos, c, 1400);
  }

  focus(id: string) {
    const p = this.posts.find((x) => x.cue.id === id);
    if (!p || !this.ground) return;
    const g = this.ground;
    const target = p.group.position.clone();
    const r = Math.max(g.width, g.depth);
    const dir = this.camera.position.clone().sub(this.controls.target).setY(0).normalize();
    const pos = target.clone().addScaledVector(dir, r * 0.16).add(new THREE.Vector3(0, r * 0.11, 0));
    this.moveTo(pos, target, 1100);
    this.highlight(id);
  }

  private moveTo(pos: THREE.Vector3, target: THREE.Vector3, dur: number) {
    this.orbitSpin = 0;
    this.tween = { from: this.camera.position.clone(), to: pos, tf: this.controls.target.clone(), tt: target, t0: performance.now(), dur: reduceMotion() ? 1 : dur };
  }

  spin(on: boolean) { this.orbitSpin = on && !reduceMotion() ? 1 : 0; }

  /** Flies along the route, slowing at each waymark. Duration scales with length. */
  playFlyover(handlers: FlyoverHandlers, seconds?: number) {
    if (!this.smoothCurve || !this.route || !this.ground) return;
    const length = this.route.curve.getLength();
    const total = this.posts.length ? Math.max(...this.posts.map((p) => p.at), 1) : 1;
    const routeLen = total;
    const dur = (seconds ?? THREE.MathUtils.clamp(routeLen / 110, 30, 70)) * 1000;
    // speed profile: slower near waymarks so each cue has time to be read or heard
    const N = 600;
    const w = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const at = (i / N) * routeLen;
      let s = 1;
      for (const p of this.posts) s += 2.6 * Math.exp(-(((at - p.at) / Math.max(60, routeLen / 60)) ** 2));
      w[i] = s;
    }
    const cum = new Float32Array(N + 1);
    for (let i = 1; i <= N; i++) cum[i] = cum[i - 1] + w[i];
    const map = (t: number) => {
      const target = t * cum[N];
      let lo = 0, hi = N;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < target) lo = m; else hi = m; }
      const f = (target - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
      return (lo + f) / N;
    };
    this.tween = null;
    this.orbitSpin = 0;
    this.controls.enabled = false;
    this.flight = { start: performance.now(), dur, map, handlers, next: 0, length, heldAt: 0 };
  }

  /** Freezes the flight (for example while a cue is being spoken). */
  hold() { if (this.flight && !this.flight.heldAt) this.flight.heldAt = performance.now(); }
  release() {
    const f = this.flight;
    if (f?.heldAt) { f.start += performance.now() - f.heldAt; f.heldAt = 0; }
  }

  stopFlyover() {
    if (!this.flight) return;
    const h = this.flight.handlers;
    this.flight = null;
    this.controls.enabled = true;
    this.route?.setProgress(1);
    h.onEnd?.();
  }

  get flying() { return !!this.flight; }

  private tick(now: number) {
    this.frames++;
    if (this.flight && this.smoothCurve && this.route && this.ground) {
      const f = this.flight;
      const t = Math.min(1, ((f.heldAt || now) - f.start) / f.dur);
      const u = f.map(t);
      const g = this.ground;
      const r = Math.max(g.width, g.depth);
      const curve = this.smoothCurve;
      const here = curve.getPointAt(Math.min(0.999, u));
      const ahead = curve.getPointAt(Math.min(1, u + 0.035));
      const tangent = ahead.clone().sub(here).setY(0).normalize();
      const back = Math.max(220, r * 0.055), up = Math.max(140, r * 0.035);
      const cam = here.clone().addScaledVector(tangent, -back).add(new THREE.Vector3(0, up, 0));
      const clear = g.heightAtXZ(cam.x, cam.z) + up * 0.6;
      if (cam.y < clear) cam.y = clear;
      this.camera.position.lerp(cam, 0.08);
      this.controls.target.lerp(ahead, 0.1);
      this.camera.lookAt(this.controls.target);
      this.route.setProgress(u);
      const at = u * (this.posts.length ? Math.max(...this.posts.map((p) => p.at)) : 0);
      f.handlers.onProgress?.(t, at);
      while (f.next < this.posts.length && this.posts[f.next].at <= at + 5) {
        const p = this.posts[f.next];
        this.highlight(p.cue.id);
        f.handlers.onCue?.(p.cue, f.next);
        f.next++;
      }
      if (t >= 1) this.stopFlyover();
    } else if (this.tween) {
      const tw = this.tween;
      const k = Math.min(1, (now - tw.t0) / tw.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.tf, tw.tt, e);
      if (k >= 1) this.tween = null;
      this.controls.update();
    } else {
      if (this.orbitSpin) {
        const off = this.camera.position.clone().sub(this.controls.target);
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.0009 * this.orbitSpin);
        this.camera.position.copy(this.controls.target).add(off);
      }
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    if (this.frames % 6 === 0) this.declutter();
  }

  /** Hides waymark numbers that would overlap an earlier one on screen (the active one always shows). */
  private declutter() {
    const shown: [number, number][] = [];
    const v = new THREE.Vector3();
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
    const order = [...this.posts].sort((a, b) => Number((b.label.element as HTMLElement).classList.contains('on')) - Number((a.label.element as HTMLElement).classList.contains('on')));
    for (const p of order) {
      p.label.getWorldPosition(v).project(this.camera);
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      const el = p.label.element as HTMLElement;
      const clash = shown.some(([sx, sy]) => Math.abs(sx - x) < 24 && Math.abs(sy - y) < 30);
      el.classList.toggle('hide', clash && !el.classList.contains('on'));
      if (!clash || el.classList.contains('on')) shown.push([x, y]);
    }
  }

  goHome() { this.frame(false); }

  stats() {
    const i = this.renderer.info;
    return { triangles: i.render.triangles, calls: i.render.calls, geometries: i.memory.geometries, textures: i.memory.textures };
  }
}
