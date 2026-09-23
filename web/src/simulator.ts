import { MAX_HZ, MIN_HZ, PROTOCOL_VERSION } from './protocol';

/**
 * A fake Pico that speaks exactly the same protocol as firmware/main.py,
 * so the public demo works without hardware. It produces JSON *text*, which
 * the app then feeds through the same LineParser and validator as real
 * serial data (see SimTransport, which also splits it into random chunks).
 *
 * The signals are synthetic but shaped like the real thing:
 *  - temperature: ~24.5 C baseline, slow drift, sensor noise, and a periodic
 *    "finger on the chip" warm-up that decays exponentially (this is what
 *    trips the default 30 C alert);
 *  - adc0: a potentiometer being turned now and then;
 *  - mem: free heap slowly shrinking until a GC every heartbeat.
 */
export class PicoSimulator {
  hz = 2;
  led = false;
  private seq = 0;
  private rng: () => number;
  private readonly start: number;
  private nextSample: number;
  private nextHb: number;
  private blinkLeft = 0;
  private nextBlink = 0;
  private window: number[] = [];
  private adcAvg: number[] = [];
  private mem = 188_000;
  private potTarget = 0.42;
  private pot = 0.42;
  private nextPotMove: number;

  constructor(now: number, seed = 137) {
    this.rng = mulberry32(seed);
    this.start = now;
    this.nextSample = now;
    this.nextHb = now + 5000;
    this.nextPotMove = now + 3000;
  }

  hello(): string {
    return JSON.stringify({
      t: 'hello',
      v: PROTOCOL_VERSION,
      fw: '0.1.0-sim',
      board: 'simulator',
      uid: 'sim-0000000000000137',
      mpy: 'simulated in the browser',
      hz: this.hz,
      adc0: 'on',
      window: 8,
    });
  }

  /** Temperature model in deg C at uptime `t` ms (before noise and smoothing). */
  trueTemp(t: number): number {
    const s = t / 1000;
    const drift = 0.6 * Math.sin(s / 47) + 0.25 * Math.sin(s / 13);
    // A warm-up pulse starts 8 s in and then every 45 s: rises for ~6 s,
    // then decays with a ~9 s time constant.
    const phase = (s - 8) % 45;
    let pulse = 0;
    if (s >= 8) {
      pulse = phase < 6 ? 8.5 * (1 - Math.exp(-phase / 2)) : 8.5 * (1 - Math.exp(-3)) * Math.exp(-(phase - 6) / 9);
    }
    return 24.5 + drift + pulse;
  }

  /** Advance the simulation to `now` and return any messages due. */
  tick(now: number): string[] {
    const out: string[] = [];
    const period = 1000 / this.hz;

    if (this.blinkLeft > 0 && now >= this.nextBlink) {
      this.blinkLeft--;
      this.nextBlink = now + 120;
    }

    if (now >= this.nextPotMove) {
      this.potTarget = 0.05 + this.rng() * 0.9;
      this.nextPotMove = now + 4000 + this.rng() * 9000;
    }

    let guard = 0;
    while (now >= this.nextSample && guard++ < 50) {
      const t = this.nextSample - this.start;
      this.pot += (this.potTarget - this.pot) * Math.min(1, 1.8 / this.hz);
      const raw = this.trueTemp(t) + (this.rng() - 0.5) * 1.6; // RP2040 sensor is noisy
      this.window.push(raw);
      if (this.window.length > 8) this.window.shift();
      const temp = this.window.reduce((a, b) => a + b, 0) / this.window.length;
      const adcRaw = clamp(this.pot + (this.rng() - 0.5) * 0.01, 0, 1);
      this.adcAvg.push(adcRaw);
      if (this.adcAvg.length > 8) this.adcAvg.shift();
      const adc = this.adcAvg.reduce((a, b) => a + b, 0) / this.adcAvg.length;
      this.mem -= 40 + Math.round(this.rng() * 90);
      this.seq++;
      out.push(
        JSON.stringify({
          t: 'tel',
          seq: this.seq,
          ms: Math.round(t),
          temp: round(temp, 2),
          temp_raw: round(raw, 2),
          adc0: round(adc, 4),
          mem: this.mem,
          led: this.blinkLeft > 0 ? this.blinkLeft % 2 === 1 : this.led,
        }),
      );
      this.nextSample += period;
    }
    if (now - this.nextSample > period) this.nextSample = now + period;

    if (now >= this.nextHb) {
      this.mem = 188_000 - Math.round(this.rng() * 600); // gc.collect()
      out.push(JSON.stringify({ t: 'hb', ms: Math.round(now - this.start), seq: this.seq }));
      this.nextHb += 5000;
    }
    return out;
  }

  /** Handle one command line the same way the firmware does. */
  command(line: string, now: number): string[] {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return [JSON.stringify({ t: 'err', msg: 'bad json' })];
    }
    if (typeof msg !== 'object' || msg === null || !('cmd' in msg)) {
      return [JSON.stringify({ t: 'err', msg: 'missing cmd' })];
    }
    switch (msg.cmd) {
      case 'led':
        this.led = typeof msg.on === 'boolean' ? msg.on : !this.led;
        this.blinkLeft = 0;
        return [JSON.stringify({ t: 'ack', cmd: 'led', on: this.led })];
      case 'rate': {
        const hz = Number(msg.hz);
        if (!Number.isFinite(hz)) return [JSON.stringify({ t: 'err', msg: 'hz must be a number', cmd: 'rate' })];
        if (hz < MIN_HZ || hz > MAX_HZ) {
          return [JSON.stringify({ t: 'err', msg: `hz out of range ${MIN_HZ}..${MAX_HZ}`, cmd: 'rate' })];
        }
        this.hz = hz;
        this.nextSample = now + 1000 / hz;
        return [JSON.stringify({ t: 'ack', cmd: 'rate', hz })];
      }
      case 'blink': {
        const n = Number.isInteger(msg.n) && (msg.n as number) >= 1 && (msg.n as number) <= 20 ? (msg.n as number) : 3;
        this.blinkLeft = n * 2;
        this.nextBlink = now;
        return [JSON.stringify({ t: 'ack', cmd: 'blink', n })];
      }
      case 'info':
        return [this.hello()];
      case 'ping':
        return [JSON.stringify({ t: 'ack', cmd: 'ping', ms: Math.round(now - this.start) })];
      case 'reset_stats':
        this.window = [];
        this.adcAvg = [];
        return [JSON.stringify({ t: 'ack', cmd: 'reset_stats' })];
      default:
        return [JSON.stringify({ t: 'err', msg: 'unknown cmd', cmd: String(msg.cmd) })];
    }
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Small seeded PRNG so the simulator (and its tests) are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
