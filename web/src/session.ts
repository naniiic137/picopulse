import type { Row } from './csv';

/**
 * Recorded telemetry rows for CSV export, bounded in both count and age so
 * a dashboard left open for days does not grow without limit. A circular
 * buffer: pushing is O(1) and never copies the whole history.
 */
export class RowBuffer {
  private readonly buf: (Row | undefined)[];
  private head = 0; // index of the oldest row
  private count = 0;
  /** Rows dropped because of the count or age limit since the last clear(). */
  dropped = 0;

  constructor(
    readonly capacity: number,
    readonly maxAgeMs: number,
  ) {
    this.buf = new Array<Row | undefined>(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(row: Row): void {
    if (this.count === this.capacity) this.dropOldest();
    this.buf[(this.head + this.count) % this.capacity] = row;
    this.count++;
    this.trim(row.received);
  }

  /** Drop rows received before `now - maxAgeMs`. */
  trim(now: number): void {
    const cutoff = now - this.maxAgeMs;
    while (this.count > 0 && (this.buf[this.head] as Row).received < cutoff) this.dropOldest();
  }

  toArray(): Row[] {
    const out: Row[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.buf[(this.head + i) % this.capacity] as Row);
    return out;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.dropped = 0;
  }

  private dropOldest(): void {
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    this.dropped++;
  }
}

/** Counts lost `tel` lines from gaps in `seq` and spots device restarts. */
export class SeqTracker {
  last: number | null = null;
  lost = 0;

  update(seq: number): 'ok' | 'gap' | 'restart' {
    const prev = this.last;
    this.last = seq;
    if (prev === null) return 'ok';
    if (seq < prev) return 'restart';
    if (seq > prev + 1) {
      this.lost += seq - prev - 1;
      return 'gap';
    }
    return 'ok';
  }

  reset(): void {
    this.last = null;
    this.lost = 0;
  }
}

/**
 * Decides when the charts need repainting: when new data arrived (at most
 * `maxFps` times a second), plus a slow refresh while streaming so the
 * "seconds ago" axis keeps moving at low sample rates. Idle or paused
 * dashboards do not redraw at all.
 */
export class RedrawGate {
  private dirty = true;
  private last = -Infinity;
  private readonly minIntervalMs: number;

  constructor(
    maxFps = 30,
    private readonly scrollIntervalMs = 500,
  ) {
    // 1 ms of slack so a 60 Hz display (16.7 ms frames) really gets 30 fps.
    this.minIntervalMs = 1000 / maxFps - 1;
  }

  markDirty(): void {
    this.dirty = true;
  }

  shouldDraw(now: number, streaming: boolean): boolean {
    const since = now - this.last;
    if ((this.dirty && since >= this.minIntervalMs) || (streaming && since >= this.scrollIntervalMs)) {
      this.dirty = false;
      this.last = now;
      return true;
    }
    return false;
  }
}

/**
 * Rate-limits screen-reader announcements: the first message goes out
 * immediately, later ones at most once per `gapMs`; while waiting, only the
 * most recent message is kept (it describes the current state).
 */
export class AnnounceThrottle {
  private last = -Infinity;
  private pending: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly gapMs: number,
    private readonly emit: (text: string) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  say(text: string): void {
    const t = this.now();
    if (this.timer === null && t - this.last >= this.gapMs) {
      this.last = t;
      this.emit(text);
      return;
    }
    this.pending = text;
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.gapMs - (t - this.last));
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private flush(): void {
    this.timer = null;
    const text = this.pending;
    this.pending = null;
    if (text === null) return;
    this.last = this.now();
    this.emit(text);
  }
}

/** Device uptime for the info panel: "mm:ss", "h:mm:ss" or "Nd hh:mm:ss". */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  if (d) return `${d}d ${String(h).padStart(2, '0')}:${mm}:${ss}`;
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Index of the slider position closest to `hz`. */
export function nearestRateIndex(rates: readonly number[], hz: number): number {
  let best = 0;
  rates.forEach((r, i) => {
    if (Math.abs(r - hz) < Math.abs(rates[best] - hz)) best = i;
  });
  return best;
}
