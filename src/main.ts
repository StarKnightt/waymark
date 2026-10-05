import '@fontsource-variable/figtree';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import './style.css';
import { renderSVG } from 'uqr';
import { getTimes } from 'suncalc';
import { World } from './scene/world';
import { ProfileStrip } from './profile';
import { ATTRIBUTION, buildFromRelation, buildFromTrack, loadStatic, type TrailBundle, type TrailFile } from './trail';
import { buildFacts } from './geo/facts';
import { parseGpx } from './geo/route';
import { overpass } from './geo/overpass';
import { cachedModel, getEngine, gpuStatus, MODEL } from './ai/gemma';
import { assemble, writeGuide, type Cue, type Guide, type GuideStats } from './ai/guide';
import { templateCue } from './ai/check';
import { decodePack, makePack, walkLink } from './share';
import { mountPocket } from './pocket';
import { getSaved, listSaved, saveGuide, type Saved } from './store';

const BASE = import.meta.env.BASE_URL;
const DEMOS = [
  { id: 'mist-trail', short: 'Mist Trail', region: 'Yosemite, USA' },
  { id: 'lake-agnes', short: 'Lake Agnes', region: 'Banff, Canada' },
  { id: 'triund', short: 'Triund', region: 'Himachal Pradesh, India' },
  { id: 'pen-y-fan', short: 'Pen y Fan', region: 'Brecon Beacons, Wales' },
];

const $ = <T extends HTMLElement = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const km = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const hm = (min: number) => `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;
const params = new URLSearchParams(location.search);

interface View { bundle: TrailBundle; guide: Guide; region?: string; savedId?: string; demo: boolean }

let world: World | null = null;
let strip: ProfileStrip | null = null;
let current: View | null = null;
let narrate = false;
let stopPocket: (() => void) | null = null;

function shell() {
  document.body.innerHTML = `
  <div class="app">
    <div class="stage" id="stage" aria-hidden="true"></div>
    <header class="top">
      <a class="brand" href="#/"><span class="mark" aria-hidden="true"></span>Waymark</a>
      <p class="tag">A trail guide you listen to</p>
      <a class="btn small" href="#/make">Make a guide for a trail</a>
    </header>
    <aside class="panel" id="panel" aria-live="polite"></aside>
    <div class="strip"><canvas id="profile" aria-label="Elevation profile with numbered waymarks"></canvas></div>
    <div class="caption" id="caption" hidden></div>
    <div class="flybar" id="flybar" hidden>
      <label class="check"><input type="checkbox" id="narrate"> Read the cues aloud</label>
      <button class="btn small" id="stopfly" type="button">Stop</button>
    </div>
  </div>
  <div id="pocket" hidden></div>
  <dialog id="send" class="sheet"></dialog>`;
  world = new World($('#stage'));
  $('#stage').addEventListener('pin', (e) => selectCue((e as CustomEvent<string>).detail, true));
  strip = new ProfileStrip($<HTMLCanvasElement>('#profile'), (id) => selectCue(id, true));
  $('#stopfly').addEventListener('click', () => world?.stopFlyover());
  $<HTMLInputElement>('#narrate').addEventListener('change', (e) => { narrate = (e.target as HTMLInputElement).checked; if (!narrate) speechSynthesis.cancel(); });
  (window as unknown as { __wm: unknown }).__wm = { world: () => world, play: () => play(), select: (id: string) => selectCue(id, true), view: () => current };
}

function sunFor(b: TrailBundle): Date {
  const [lat, lon] = b.facts.profile.pts[0];
  const t = params.get('sun');
  const times = getTimes(new Date(), lat, lon);
  if (t === 'noon') return times.solarNoon;
  const before = Number(t ?? 150);
  return times.sunset ? new Date(times.sunset.getTime() - before * 60000) : times.solarNoon;
}

function templateGuide(id: string, b: TrailBundle): Guide {
  const f = b.facts;
  const stats: GuideStats = { mode: 'tools', waymarks: f.waymarks.length, required: f.waymarks.filter((w) => w.required).length, modelCues: 0, cleanCues: 0, repairedCues: 0, replacedCues: 0, addedCues: 0, requiredCovered: 0, invalidOutput: 0, issues: { number: 0, name: 0, direction: 0, side: 0, length: 0, empty: 0 }, ms: 0, promptTokens: 0, outputTokens: 0, decodeTps: 0, prefillTps: 0 };
  const g = assemble(id, f, f.waymarks.map((w) => ({ waymark: w.id, text: templateCue(w, f) })), null, stats);
  g.model = 'templates';
  g.cues.forEach((c) => { c.source = 'template'; });
  return g;
}

async function show(v: View) {
  current = v;
  const b = v.bundle, f = b.facts, g = v.guide;
  world!.setTrail(b, g.cues, { lowPower: matchMedia('(max-width: 720px)').matches });
  world!.setSun(sunFor(b));
  world!.spin(!params.has('capture'));
  strip!.set(f, g.cues);
  const live = g.model !== 'templates' && !v.demo;
  const modelCues = g.cues.filter((c) => c.source === 'gemma').length;
  const checked = g.cues.filter((c) => c.issues.length).length;
  const date = new Date(g.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const saved = await listSaved().catch(() => [] as Saved[]);
  $('#panel').innerHTML = `
    <nav class="picker" aria-label="Demo trails">
      ${DEMOS.map((d) => `<a href="#/t/${d.id}" class="chip${b.id === d.id ? ' on' : ''}"><b>${d.short}</b><span>${d.region}</span></a>`).join('')}
      ${saved.map((s) => `<a href="#/g/${s.id}" class="chip mine${v.savedId === s.id ? ' on' : ''}"><b>${esc(s.name.slice(0, 28))}</b><span>On this device</span></a>`).join('')}
    </nav>
    <article class="card">
      <p class="eyebrow">${esc(v.region ?? b.track.tags?.['waymark:region'] ?? '')}</p>
      <h1>${esc(f.name)}</h1>
      <dl class="stats">
        <div><dt>Distance</dt><dd>${km(f.lengthM)}</dd><span>${f.loop ? 'loop' : 'one way'}</span></div>
        <div><dt>Climb</dt><dd>${Math.round(f.ascentM / 10) * 10} m</dd><span>up</span></div>
        <div><dt>Walking</dt><dd>${hm(f.walkMinutes)}</dd><span>steady pace</span></div>
      </dl>
      <p class="brief">${esc(g.briefing)}</p>
      <div class="actions">
        <button class="btn primary" data-act="play" type="button">Preview the walk</button>
        <button class="btn" data-act="send" type="button">Walk it with your phone</button>
      </div>
      <p class="source">${g.model === 'templates'
        ? `${g.cues.length} plain cues built from the facts, without the model.`
        : `${modelCues} of ${g.cues.length} cues written by ${esc(g.model)} ${live ? 'in this browser' : 'in a browser'} on ${date}${checked ? `; the checker repaired ${checked}` : ''}.${v.demo ? ' This demo uses that saved guide, so nothing large is downloaded.' : ''}`}
        <button class="link" data-act="facts" type="button" aria-pressed="false">Show the facts behind each cue</button>
        ${v.demo ? '<button class="link" data-act="rewrite" type="button">Write it again on this device</button>' : ''}
      </p>
    </article>
    <ol class="cues">
      ${g.cues.map((c, i) => {
        const w = f.waymarks.find((x) => x.id === c.id);
        return `<li data-id="${c.id}">
          <button class="cue" type="button" data-cue="${c.id}"><span class="blaze">${i + 1}</span>
            <span class="body"><span class="ct">${esc(c.title)}<span class="at">${km(c.at)}</span></span>
            <span class="cx">${esc(c.text)}</span></span></button>
          <div class="cf" hidden>
            <p><b>${c.source === 'gemma' ? 'Written by Gemma' : 'Built from the facts'}</b>${c.issues.length ? ` · checker: ${c.issues.map((x) => `${esc(x.detail)} (${x.fixed})`).join('; ')}` : ' · passed every check'}</p>
            ${c.original ? `<p class="orig">Gemma's draft: ${esc(c.original)}</p>` : ''}
            <ul>${(w?.facts ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          </div></li>`;
      }).join('')}
    </ol>
    <footer class="about">
      <details><summary>How it works</summary>
        <ol>
          <li>The facts come from open data: paths, junctions, water and landmarks from OpenStreetMap, and climbs from open elevation tiles. Junction directions are computed from the path geometry.</li>
          <li>${MODEL.name}, an open-weight model, runs in your browser on WebGPU and writes one short cue per waymark through a constrained tool call.</li>
          <li>A checker compares every number, name and direction with the facts, and removes or repairs anything they do not support.</li>
          <li>On the trail, your phone speaks each cue when you reach that waymark, with the screen dark.</li>
        </ol></details>
      <details><summary>What leaves your device</summary>
        <p>Requests for the trail's area go to OpenStreetMap and to the elevation tile service. Place searches go to OpenStreetMap's search. The model is downloaded once from Hugging Face. Your guides, your position on the trail and the cues stay on your device; the phone link keeps the guide after the #, which browsers do not send to any server.</p></details>
      <p class="credit">${esc(ATTRIBUTION)} Model: ${MODEL.name} (Google, open weights) on LiteRT-LM. 3D heights are exaggerated 1.25 times. Waymark is not a navigation or safety device.</p>
    </footer>`;
  $('#panel').scrollTop = 0;
}

function selectCue(id: string, fly: boolean) {
  if (!current) return;
  document.querySelectorAll('.cues li').forEach((li) => li.classList.toggle('on', (li as HTMLElement).dataset.id === id));
  const li = document.querySelector(`.cues li[data-id="${id}"]`);
  li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  strip?.setActive(id);
  if (fly && !world?.flying) world?.focus(id);
  else world?.highlight(id);
}

function caption(cue: Cue | null, index = 0) {
  const el = $('#caption');
  if (!cue) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="blaze">${index + 1}</span><p><b>${esc(cue.title)}</b> ${esc(cue.text)}</p>`;
  el.classList.remove('in');
  void el.offsetWidth;
  el.classList.add('in');
}

function play() {
  if (!current || !world) return;
  if (world.flying) { world.stopFlyover(); return; }
  document.body.classList.add('flying');
  $('#flybar').hidden = false;
  const seconds = params.get('flysec') ? Number(params.get('flysec')) : undefined;
  world.playFlyover({
    onCue: (cue, i) => {
      caption(cue, i);
      selectCue(cue.id, false);
      if (narrate) {
        world!.hold();
        const u = new SpeechSynthesisUtterance(cue.text);
        u.rate = 1.02;
        u.onend = u.onerror = () => setTimeout(() => world?.release(), 350);
        speechSynthesis.speak(u);
      }
    },
    onProgress: (_t, at) => strip?.setHead(at),
    onEnd: () => {
      document.body.classList.remove('flying');
      $('#flybar').hidden = true;
      caption(null);
      strip?.setHead(-1);
      speechSynthesis.cancel();
      world?.goHome();
      world?.spin(!params.has('capture'));
    },
  }, seconds);
}

async function openSend() {
  if (!current) return;
  const pack = makePack(current.bundle.facts, current.guide, current.region ?? current.bundle.track.tags?.['waymark:region']);
  const link = await walkLink(pack);
  const d = $<HTMLDialogElement>('#send');
  d.innerHTML = `
    <form method="dialog" class="sheet-in">
      <h2>Walk it with your phone</h2>
      <p>Scan this with your phone's camera, or send yourself the link. The whole guide is inside the link after the #, and browsers do not send that part to any server.</p>
      <div class="qr">${renderSVG(link, { border: 2, ecc: 'L' })}</div>
      <div class="row"><input class="linkbox" readonly value="${esc(link)}" aria-label="Walk link"><button class="btn small" type="button" data-copy>Copy</button></div>
      <p class="small">On the trail: open the link once while you have signal, then press Start walk. ${pack.cues.length} cues, ${(link.length / 1024).toFixed(1)} KB.</p>
      <div class="row end"><a class="btn small" href="${esc(link)}" target="_blank" rel="noopener">Open the phone view here</a><button class="btn small primary" value="close">Done</button></div>
    </form>`;
  $('[data-copy]', d).addEventListener('click', async (e) => { await navigator.clipboard.writeText(link); (e.target as HTMLElement).textContent = 'Copied'; });
  d.showModal();
}

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  const cue = t.closest<HTMLElement>('[data-cue]')?.dataset.cue;
  if (cue) selectCue(cue, true);
  if (act === 'play') play();
  else if (act === 'send') void openSend();
  else if (act === 'facts') {
    const btn = t.closest('button')!;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Hide the facts' : 'Show the facts behind each cue';
    document.querySelectorAll<HTMLElement>('.cf').forEach((x) => { x.hidden = !on; });
  } else if (act === 'rewrite' && current) void rewrite(current);
});

// ---------- making a guide ----------

function makeView() {
  current = null;
  world?.stopFlyover();
  $('#panel').innerHTML = `
    <section class="make">
      <a class="back" href="#/">Back to the demo trails</a>
      <h1>Make a guide for a trail</h1>
      <p>Waymark builds the facts from OpenStreetMap and open elevation data. Then Gemma 4 writes the cues on your computer.</p>
      <h2>Choose the trail</h2>
      <form class="row" id="find"><input name="q" required placeholder="A place, for example Lake Louise" aria-label="Place"><button class="btn small primary">Find trails</button></form>
      <ul class="results" id="results"></ul>
      <form class="row" id="rel"><input name="r" required placeholder="Or paste an OpenStreetMap route link" aria-label="OpenStreetMap route link"><button class="btn small">Use route</button></form>
      <label class="file btn small">Or open a GPX file<input type="file" accept=".gpx,application/gpx+xml" id="gpx" hidden></label>
      <ol class="log" id="log" hidden></ol>
      <div id="modelbox"></div>
    </section>`;
  $('#find').addEventListener('submit', (e) => { e.preventDefault(); void findTrails(new FormData(e.target as HTMLFormElement).get('q') as string); });
  $('#rel').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = String(new FormData(e.target as HTMLFormElement).get('r'));
    const id = Number(v.match(/relation\/(\d+)/)?.[1] ?? v.match(/^\s*(\d+)\s*$/)?.[1]);
    if (id) void build(() => buildFromRelation(id, log), `osm-${id}`); else log('That does not look like an OpenStreetMap route link (it should contain /relation/ and a number).', true);
  });
  $<HTMLInputElement>('#gpx').addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const track = parseGpx(await file.text(), file.name);
      void build(() => buildFromTrack(`gpx-${Date.now()}`, track, log), `gpx-${Date.now()}`);
    } catch (err) { log((err as Error).message, true); }
  });
}

function log(msg: string, error = false) {
  const l = $('#log');
  if (!l) return;
  l.hidden = false;
  const li = document.createElement('li');
  li.textContent = msg;
  if (error) li.className = 'err';
  l.appendChild(li);
}

async function findTrails(q: string) {
  const out = $('#results');
  out.innerHTML = '<li class="muted">Searching</li>';
  try {
    const places = await (await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`)).json();
    if (!places.length) { out.innerHTML = '<li class="muted">No place found with that name.</li>'; return; }
    const p = places[0];
    out.innerHTML = `<li class="muted">Looking for walking routes near ${esc(p.display_name.split(',').slice(0, 2).join(','))}</li>`;
    const res = await overpass(`[out:json][timeout:40];rel(around:9000,${p.lat},${p.lon})["route"~"^(hiking|foot)$"]["name"];out tags center 40;`);
    const rels = res.elements.filter((e) => e.type === 'relation').slice(0, 25);
    out.innerHTML = rels.length
      ? rels.map((r) => `<li><button class="pick" type="button" data-rel="${r.id}">${esc(r.tags?.name ?? 'Unnamed route')}${r.tags?.distance ? ` <span>${esc(r.tags.distance)} km</span>` : ''}</button></li>`).join('')
      : '<li class="muted">No mapped walking routes within 9 km. Try a GPX file instead.</li>';
    out.querySelectorAll<HTMLButtonElement>('[data-rel]').forEach((b) => b.addEventListener('click', () => { const id = Number(b.dataset.rel); void build(() => buildFromRelation(id, log), `osm-${id}`); }));
  } catch (e) {
    out.innerHTML = `<li class="err">Route search uses OpenStreetMap's Overpass service, which did not answer (${esc((e as Error).message)}). Try again in a few minutes, or open a GPX file instead.</li>`;
  }
}

async function build(make: () => Promise<TrailBundle>, id: string) {
  $('#log').replaceChildren();
  let b: TrailBundle;
  try {
    b = await make();
    b.id = id;
  } catch (e) { log((e as Error).message, true); return; }
  const f = b.facts;
  log(`${f.name}: ${km(f.lengthM)}, ${Math.round(f.ascentM)} m of climbing, ${f.waymarks.length} waymarks.`);
  world!.setTrail(b, [], {});
  world!.setSun(sunFor(b));
  const box = $('#modelbox');
  const gpu = await gpuStatus();
  const cached = gpu.ok && !!(await cachedModel());
  box.innerHTML = gpu.ok
    ? `<h2>Write the guide</h2><p>${cached ? `${MODEL.name} is already stored in this browser.` : `The first time, Waymark downloads ${MODEL.name} (${(MODEL.bytes / 1e9).toFixed(1)} GB) from Hugging Face and keeps it in this browser's storage. After that it loads in a few seconds and works offline.`}</p>
       <button class="btn primary" id="write" type="button">${cached ? 'Write the guide' : 'Download the model and write the guide'}</button>
       <div class="bar" hidden><i></i></div><p class="small" id="mstatus"></p>`
    : `<h2>Write the guide</h2><p>${esc(gpu.reason ?? '')} The model needs WebGPU, so this device can make a plain guide from the facts instead.</p><button class="btn primary" id="plain" type="button">Make a plain guide</button>`;
  $('#plain')?.addEventListener('click', () => void finish(b, templateGuide(b.id, b)));
  $('#write')?.addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('#write');
    btn.disabled = true;
    try {
      const guide = await runModel(b);
      await finish(b, guide);
    } catch (e) {
      $('#mstatus').textContent = (e as Error).message;
      btn.disabled = false;
    }
  });
}

async function runModel(b: TrailBundle): Promise<Guide> {
  const bar = document.querySelector<HTMLElement>('.bar');
  const status = (s: string) => { const el = document.querySelector('#mstatus'); if (el) el.textContent = s; };
  const engine = await getEngine((p) => {
    status(p.text);
    if (bar && p.total) { bar.hidden = false; ($('i', bar)).style.width = `${((p.loaded ?? 0) / p.total) * 100}%`; }
  });
  const t0 = performance.now();
  const timer = setInterval(() => status(`Gemma is writing the guide: ${Math.round((performance.now() - t0) / 1000)} s`), 500);
  try {
    return await writeGuide(engine, b.id, b.facts);
  } finally { clearInterval(timer); }
}

async function finish(b: TrailBundle, guide: Guide) {
  const { data, ...dem } = b.dem;
  const file: TrailFile = { id: b.id, track: b.track, bbox: b.bbox, dem, ctx: b.ctx, attribution: ATTRIBUTION, builtAt: new Date().toISOString() };
  const id = `${b.id}-${Date.now().toString(36)}`;
  await saveGuide({ id, name: b.facts.name, region: b.track.tags?.['waymark:region'], savedAt: new Date().toISOString(), file, dem: data, guide });
  location.hash = `#/g/${id}`;
}

async function rewrite(v: View) {
  const gpu = await gpuStatus();
  const src = $('.source');
  if (!gpu.ok) { src.insertAdjacentHTML('beforeend', `<span class="note">${esc(gpu.reason ?? '')}</span>`); return; }
  const cached = await cachedModel();
  if (!cached && !confirm(`This downloads ${MODEL.name} (${(MODEL.bytes / 1e9).toFixed(1)} GB) from Hugging Face once and keeps it in this browser. Continue?`)) return;
  src.insertAdjacentHTML('beforeend', '<span class="note" id="mstatus">Starting</span><span class="bar" hidden><i></i></span>');
  try {
    const guide = await runModel(v.bundle);
    await finish(v.bundle, guide);
  } catch (e) { $('#mstatus').textContent = (e as Error).message; }
}

// ---------- routing ----------

async function route() {
  const h = location.hash;
  stopPocket?.();
  stopPocket = null;
  if (h.startsWith('#/walk/')) {
    document.querySelector('.app')?.setAttribute('hidden', '');
    const root = $('#pocket');
    root.hidden = false;
    try { stopPocket = mountPocket(root, await decodePack(h.slice(7))); }
    catch (e) { root.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`; }
    return;
  }
  document.querySelector('.app')?.removeAttribute('hidden');
  $('#pocket').hidden = true;
  if (h === '#/make') { makeView(); return; }
  const saved = h.match(/^#\/g\/(.+)$/)?.[1];
  if (saved) {
    const s = await getSaved(saved);
    if (s) {
      const dem = { ...s.file.dem, data: s.dem };
      const facts = buildFacts(s.file.track.name, s.file.track.points, dem, s.file.ctx);
      await show({ bundle: { id: s.file.id, track: s.file.track, bbox: s.file.bbox, dem, ctx: s.file.ctx, facts }, guide: s.guide, region: s.region, savedId: s.id, demo: false });
      return;
    }
  }
  const id = h.match(/^#\/t\/(.+)$/)?.[1] ?? DEMOS[0].id;
  const demo = DEMOS.find((d) => d.id === id) ?? DEMOS[0];
  $('#panel').innerHTML = '<p class="muted pad">Loading the trail</p>';
  const [bundle, guide] = await Promise.all([
    loadStatic(BASE, demo.id),
    fetch(`${BASE}guides/${demo.id}.json`).then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? (r.json() as Promise<Guide>) : null)).catch(() => null),
  ]);
  await show({ bundle, guide: guide ?? templateGuide(demo.id, bundle), region: demo.region, demo: true });
}

shell();
if (params.has('clean')) document.body.classList.add('clean');
if (params.has('nopanel')) document.body.classList.add('nopanel');
if (params.has('cover')) {
  // used to render the cover image from the app itself (see README)
  document.body.classList.add('clean');
  document.body.insertAdjacentHTML('beforeend', `<div class="cover"><p class="cover-mark"><span class="mark"></span>Waymark</p><h1>A trail guide<br>you listen to</h1><p class="cover-sub">Gemma 4 writes the spoken cues in your browser,<br>from open map and elevation data.</p></div>`);
}
window.addEventListener('hashchange', () => void route());
void route();
