import { cumulative, LocalFrame, pointAt, snapToLine, type LL, type XY } from './geo/geo';
import { decodePolyline, type Pack } from './share';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmt = (m: number) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

class Voice {
  private voice: SpeechSynthesisVoice | null = null;
  constructor() {
    const pick = () => {
      const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      this.voice = vs.find((v) => v.localService && /en-(GB|US|IN|AU)/.test(v.lang)) ?? vs.find((v) => v.localService) ?? vs[0] ?? null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  }
  say(text: string, onEnd?: () => void) {
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 0.98;
    u.onend = () => onEnd?.();
    speechSynthesis.speak(u);
  }
  stop() { speechSynthesis.cancel(); }
}

export interface PocketOptions { simulate?: number }

/** The phone view: dark screen, GPS, and a spoken cue at each waymark. */
export function mountPocket(root: HTMLElement, pack: Pack): () => void {
  const route = decodePolyline(pack.route);
  const frame = new LocalFrame(route[Math.floor(route.length / 2)]);
  const line: XY[] = route.map((p) => frame.toXY(p));
  const cum = cumulative(route);
  const total = cum[cum.length - 1];
  const scale = pack.lengthM / (total || 1);
  const cues = pack.cues.map(([at, text], i) => ({ i, at, text, spoken: false }));
  const voice = new Voice();
  let watch: number | null = null, sim: number | null = null, lock: WakeLockSentinel | null = null;
  let best = 0, offCount = 0, offSince = 0, warned = false, finished = false, lastFix = 0, lastSpoken = '';
  const startedAt = { t: 0 };

  root.className = 'pocket';
  root.innerHTML = `
    <section class="p-ready">
      <p class="p-eyebrow">Walk with Waymark</p>
      <h1>${esc(pack.name)}</h1>
      <p class="p-meta">${fmt(pack.lengthM)} ${pack.loop ? 'loop' : 'one way'} · ${Math.round(pack.ascentM / 10) * 10} m up · about ${Math.floor(pack.walkMinutes / 60)} h ${pack.walkMinutes % 60} min</p>
      <p class="p-note">${pack.cues.length} spoken cues. Waymark keeps the screen awake but dark and speaks when you reach each waymark. Once this page has loaded it needs no signal.</p>
      <button class="p-start" type="button">Start walk</button>
      <div class="p-row">
        <button class="p-ghost" data-act="brief" type="button">Hear the briefing</button>
        <button class="p-ghost" data-act="sim" type="button">Try a simulated walk</button>
      </div>
      <p class="p-small">Not a navigation or safety device. Carry a map, check conditions and tell someone your plan.</p>
    </section>
    <section class="p-walk" hidden>
      <div class="p-dim">
        <p class="p-status" aria-live="polite">Finding your position</p>
        <p class="p-next"></p>
        <div class="p-bar"><i></i></div>
        <div class="p-row">
          <button class="p-ghost" data-act="repeat" type="button">Repeat last cue</button>
          <button class="p-ghost" data-act="stop" type="button">End walk</button>
        </div>
        <p class="p-small">Tap the screen to show or dim this text.</p>
      </div>
    </section>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const status = (s: string) => { $('.p-status').textContent = s; };

  const speakCue = (c: { text: string }) => {
    lastSpoken = c.text;
    navigator.vibrate?.([180, 90, 180]);
    voice.say(c.text);
  };

  const update = (ll: LL, accuracy: number) => {
    lastFix = performance.now();
    if (accuracy > 60) { status(`Waiting for a better GPS fix (±${Math.round(accuracy)} m)`); return; }
    const p = frame.toXY(ll);
    const lo = cum.findIndex((d) => d >= best - 250);
    const hi = cum.findIndex((d) => d > best + 700);
    let s = snapToLine(p, line, cum, Math.max(0, lo), hi < 0 ? line.length - 1 : hi);
    if (s.offset > 120 && best < 50) s = snapToLine(p, line, cum);
    const along = s.along * scale;
    if (s.offset < 60) {
      best = Math.max(best, along);
      offCount = 0;
      if (warned && s.offset < 40) { warned = false; voice.say('You are back on the route.'); }
    } else {
      offCount++;
      if (!offSince) offSince = performance.now();
      if (!warned && offCount >= 3 && performance.now() - offSince > 20000) {
        warned = true;
        voice.say(`You may be off the route. The route is about ${Math.round(s.offset / 10) * 10} metres away.`);
      }
    }
    if (s.offset < 60) offSince = 0;
    for (const c of cues) {
      if (c.spoken || c.at > best + 25) continue;
      c.spoken = true;
      speakCue(c);
    }
    const next = cues.find((c) => !c.spoken);
    $('.p-next').textContent = next ? `Next cue in ${fmt(Math.max(0, next.at - best))}` : 'No more cues';
    (($('.p-bar i')) as HTMLElement).style.width = `${Math.min(100, (best / pack.lengthM) * 100)}%`;
    status(`${fmt(best)} of ${fmt(pack.lengthM)} · GPS ±${Math.round(accuracy)} m${s.offset >= 60 ? ` · ${Math.round(s.offset)} m off the route` : ''}`);
    if (!finished && best >= pack.lengthM - 30 && cues.every((c) => c.spoken)) {
      finished = true;
      const mins = Math.round((performance.now() - startedAt.t) / 60000);
      status(`Walk complete${mins ? ` in ${Math.floor(mins / 60)} h ${mins % 60} min` : ''}.`);
    }
  };

  const keepAwake = async () => {
    try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; }
  };
  const onVisible = () => { if (document.visibilityState === 'visible' && (watch !== null || sim !== null)) void keepAwake(); };
  document.addEventListener('visibilitychange', onVisible);

  const begin = (simulate: number) => {
    $('.p-ready').hidden = true;
    $('.p-walk').hidden = false;
    root.classList.add('dark');
    startedAt.t = performance.now();
    void keepAwake();
    voice.say('Waymark is on. You can put your phone in your pocket now.');
    if (simulate) {
      // replays the route at `simulate` times walking speed with a little GPS noise
      let d = 0;
      const speed = (4.4 / 3.6) * simulate;
      sim = window.setInterval(() => {
        d = Math.min(total, d + speed);
        const [la, lo] = pointAt(route, cum, d);
        const n = () => (Math.random() - 0.5) * 0.00006;
        update([la + n(), lo + n()], 6 + Math.random() * 6);
        if (d >= total) { clearInterval(sim!); sim = null; }
      }, 1000);
      status('Simulated walk');
      return;
    }
    if (!('geolocation' in navigator)) { status('This browser cannot read your location.'); return; }
    watch = navigator.geolocation.watchPosition(
      (pos) => update([pos.coords.latitude, pos.coords.longitude], pos.coords.accuracy),
      (err) => status(err.code === 1 ? 'Location permission was denied. Allow it in your browser settings to use Waymark on the trail.' : 'Waiting for GPS'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 },
    );
  };

  const stop = () => {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    if (sim !== null) clearInterval(sim);
    watch = sim = null;
    void lock?.release().catch(() => {});
    lock = null;
    voice.stop();
  };

  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    const act = b?.dataset.act;
    if (b?.classList.contains('p-start')) begin(0);
    else if (act === 'sim') begin(new URLSearchParams(location.search).has('fast') ? 25 : 8);
    else if (act === 'brief') voice.say(pack.briefing);
    else if (act === 'repeat') { if (lastSpoken) voice.say(lastSpoken); }
    else if (act === 'stop') { stop(); root.classList.remove('dark'); $('.p-walk').hidden = true; $('.p-ready').hidden = false; }
    else if (!b && root.classList.contains('dark')) root.classList.toggle('lit');
  });
  const stale = window.setInterval(() => { if (watch !== null && lastFix && performance.now() - lastFix > 45000) status('No GPS update for a while. Waymark will keep listening.'); }, 15000);
  void startedAt;
  return () => { stop(); clearInterval(stale); document.removeEventListener('visibilitychange', onVisible); };
}
