import type { Series } from './stats';

export interface ChartOptions {
  color: string;
  /** Visible time window in ms. */
  windowMs: number;
  /** Fixed y range; if omitted the range follows the visible data. */
  yMin?: number;
  yMax?: number;
  /** Smallest y span when auto-scaling, so noise is not blown up to full height. */
  minSpan: number;
  format: (v: number) => string;
  /** Optional horizontal alert line. */
  threshold?: () => number | null;
  /** Break the line when two samples are further apart than this (ms). */
  gapMs?: number;
}

/** "Nice" tick values (1, 2, 2.5, 5 x 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, maxTicks = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const raw = (max - min) / Math.max(1, maxTicks - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}

interface ThemeColors {
  grid: string;
  muted: string;
  danger: string;
}

let theme: ThemeColors | null = null;

/**
 * CSS custom properties used by the charts, read once and cached:
 * getComputedStyle on every frame forces style work for no benefit.
 * Call invalidateThemeColors() if the theme ever changes at runtime.
 */
export function themeColors(): ThemeColors {
  if (!theme) {
    const style = getComputedStyle(document.documentElement);
    const css = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    theme = { grid: css('--grid', '#223'), muted: css('--muted', '#889'), danger: css('--danger', '#ff5d5d') };
  }
  return theme;
}

export function invalidateThemeColors(): void {
  theme = null;
}

/**
 * Minimal real-time line chart on a <canvas>. The x axis is "seconds ago"
 * relative to the render time, so the trace scrolls smoothly at the display
 * frame rate regardless of how often samples arrive.
 */
export class TimeChart {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private lastDraw: { series: Series; now: number } | null = null;
  /** Derived colours, computed once instead of on every frame. */
  private readonly fillTop: string;
  private readonly fillBottom: string;
  private readonly halo: string;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: ChartOptions,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.fillTop = withAlpha(opts.color, 0.22);
    this.fillBottom = withAlpha(opts.color, 0);
    this.halo = withAlpha(opts.color, 0.25);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    // Resizing a canvas clears it, so repaint the last frame straight away.
    if (this.lastDraw) this.draw(this.lastDraw.series, this.lastDraw.now);
  }

  draw(series: Series, now: number): void {
    this.lastDraw = { series, now };
    const { ctx, width: W, height: H, opts } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const pad = { l: 44, r: 12, t: 10, b: 24 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    const t0 = now - opts.windowMs;

    // Visible range (include one sample before the window so the line enters from the edge).
    let lo = Infinity;
    let hi = -Infinity;
    let first = series.length;
    for (let i = series.length - 1; i >= 0; i--) {
      const t = series.timeAt(i);
      const v = series.valueAt(i);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      first = i;
      if (t < t0) break;
    }
    const thr = opts.threshold?.() ?? null;
    let yMin = opts.yMin ?? lo;
    let yMax = opts.yMax ?? hi;
    if (opts.yMin === undefined || opts.yMax === undefined) {
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
        yMin = 0;
        yMax = 1;
      }
      if (thr !== null && thr > yMax && thr - yMax < opts.minSpan) yMax = thr;
      const span = Math.max(yMax - yMin, opts.minSpan);
      const mid = (yMax + yMin) / 2;
      yMin = mid - span * 0.6;
      yMax = mid + span * 0.6;
    }
    const x = (t: number) => pad.l + ((t - t0) / opts.windowMs) * pw;
    const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ph;

    const { grid, muted, danger } = themeColors();
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.lineWidth = 1;

    // Horizontal grid + y labels.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of niceTicks(yMin, yMax, Math.max(5, Math.floor(ph / 36)))) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(W - pad.r, yy);
      ctx.stroke();
      // Auto-scaled axes have no meaningful labels until data arrives.
      if (series.length > 0 || opts.yMin !== undefined) {
        ctx.fillStyle = muted;
        ctx.fillText(opts.format(v), pad.l - 8, yy);
      }
    }

    // Vertical grid labelled as seconds ago.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Keep x labels at least ~48 px apart.
    const stepS = [10, 20, 30, 60].find((st) => (st * 1000 * pw) / opts.windowMs >= 48) ?? 60;
    for (let s = 0; s * 1000 <= opts.windowMs; s += stepS) {
      const xx = Math.round(x(now - s * 1000)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(xx, pad.t);
      ctx.lineTo(xx, pad.t + ph);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(s === 0 ? 'now' : `-${s}s`, Math.min(xx, W - pad.r - 12), pad.t + ph + 8);
    }

    // Alert threshold.
    if (thr !== null && thr >= yMin && thr <= yMax) {
      const yy = Math.round(y(thr)) + 0.5;
      ctx.save();
      ctx.strokeStyle = danger;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(W - pad.r, yy);
      ctx.stroke();
      ctx.fillStyle = danger;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`alert ${opts.format(thr)}`, pad.l + 6, yy - 3);
      ctx.restore();
    }

    if (series.length - first < 1) return;

    // Clip the trace to the plot area.
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t - 4, pw, ph + 8);
    ctx.clip();

    const gap = opts.gapMs ?? 6000;
    const path = new Path2D();
    const area = new Path2D();
    let started = false;
    let segStartX = 0;
    let prevT = 0;
    let lastX = 0;
    let lastY = 0;
    const closeArea = () => {
      area.lineTo(lastX, pad.t + ph);
      area.lineTo(segStartX, pad.t + ph);
      area.closePath();
    };
    for (let i = first; i < series.length; i++) {
      const t = series.timeAt(i);
      const px = x(t);
      const py = y(series.valueAt(i));
      if (!started || t - prevT > gap) {
        if (started) closeArea();
        path.moveTo(px, py);
        area.moveTo(px, py);
        segStartX = px;
        started = true;
      } else {
        path.lineTo(px, py);
        area.lineTo(px, py);
      }
      prevT = t;
      lastX = px;
      lastY = py;
    }
    closeArea();

    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    grad.addColorStop(0, this.fillTop);
    grad.addColorStop(1, this.fillBottom);
    ctx.fillStyle = grad;
    ctx.fill(area);

    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
    ctx.restore();

    // Latest sample marker.
    ctx.fillStyle = this.halo;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = opts.color;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
