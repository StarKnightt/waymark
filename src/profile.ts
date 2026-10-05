import type { TrailFacts } from './geo/facts';
import type { Cue } from './ai/guide';

/** Elevation profile with numbered waymarks and a playhead. */
export class ProfileStrip {
  private ctx: CanvasRenderingContext2D;
  private facts: TrailFacts | null = null;
  private cues: Cue[] = [];
  private head = -1;
  private active: string | null = null;

  constructor(private canvas: HTMLCanvasElement, onPick: (id: string) => void) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('click', (e) => {
      if (!this.facts || !this.cues.length) return;
      const r = canvas.getBoundingClientRect();
      const at = ((e.clientX - r.left) / r.width) * this.facts.lengthM;
      const best = this.cues.reduce((a, c) => (Math.abs(c.at - at) < Math.abs(a.at - at) ? c : a));
      onPick(best.id);
    });
  }

  set(f: TrailFacts, cues: Cue[]) {
    this.facts = f;
    this.cues = cues;
    this.head = -1;
    this.draw();
  }

  setHead(at: number) { this.head = at; this.draw(); }
  setActive(id: string | null) { this.active = id; this.draw(); }

  draw() {
    const c = this.canvas, k = this.ctx, f = this.facts;
    const dpr = Math.min(2, devicePixelRatio);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    k.setTransform(dpr, 0, 0, dpr, 0, 0);
    k.clearRect(0, 0, w, h);
    if (!f) return;
    const { cum, ele } = f.profile;
    const lo = Math.min(...ele), hi = Math.max(...ele);
    const pad = { l: 8, r: 8, t: 22, b: 18 };
    const X = (d: number) => pad.l + (d / f.lengthM) * (w - pad.l - pad.r);
    const Y = (e: number) => pad.t + (1 - (e - lo) / Math.max(1, hi - lo)) * (h - pad.t - pad.b);
    const css = getComputedStyle(c);
    const ink = css.getPropertyValue('--ink').trim() || '#1d2b24';
    const blaze = css.getPropertyValue('--blaze').trim() || '#f2c230';
    k.beginPath();
    k.moveTo(X(0), h - pad.b);
    for (let i = 0; i < cum.length; i += 2) k.lineTo(X(cum[i]), Y(ele[i]));
    k.lineTo(X(f.lengthM), h - pad.b);
    k.closePath();
    k.fillStyle = 'rgba(29, 43, 36, 0.12)';
    k.fill();
    k.beginPath();
    for (let i = 0; i < cum.length; i += 2) (i ? k.lineTo : k.moveTo).call(k, X(cum[i]), Y(ele[i]));
    k.strokeStyle = ink;
    k.lineWidth = 1.5;
    k.stroke();
    if (this.head >= 0) {
      k.save();
      k.beginPath();
      k.rect(0, 0, X(this.head), h);
      k.clip();
      k.beginPath();
      for (let i = 0; i < cum.length; i += 2) (i ? k.lineTo : k.moveTo).call(k, X(cum[i]), Y(ele[i]));
      k.strokeStyle = blaze;
      k.lineWidth = 3;
      k.stroke();
      k.restore();
    }
    k.font = '600 11px "Barlow Condensed", system-ui, sans-serif';
    k.textAlign = 'center';
    this.cues.forEach((cue, i) => {
      const x = X(cue.at), y = Y(ele[Math.min(ele.length - 1, Math.round(cue.at / 10))]);
      const on = cue.id === this.active;
      k.fillStyle = on ? blaze : 'rgba(29, 43, 36, 0.55)';
      k.fillRect(x - (on ? 1.5 : 0.75), y, on ? 3 : 1.5, h - pad.b - y);
      k.fillStyle = blaze;
      k.strokeStyle = ink;
      k.lineWidth = 1;
      k.fillRect(x - 7, 3, 14, 15);
      k.strokeRect(x - 7, 3, 14, 15);
      k.fillStyle = ink;
      k.fillText(String(i + 1), x, 14.5);
    });
    k.fillStyle = ink;
    k.textAlign = 'left';
    k.font = '500 11px Figtree, system-ui, sans-serif';
    k.fillText(`${Math.round(hi)} m`, pad.l, pad.t + 9);
    k.fillText(`${Math.round(lo)} m`, pad.l, h - 4);
    k.textAlign = 'right';
    k.fillText(`${(f.lengthM / 1000).toFixed(1)} km`, w - pad.r, h - 4);
  }
}
