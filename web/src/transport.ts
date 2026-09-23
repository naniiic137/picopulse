import { PicoSimulator, mulberry32 } from './simulator';

/** Something that delivers raw text from a device and accepts command lines. */
export interface Transport {
  readonly kind: 'serial' | 'sim';
  readonly label: string;
  start(onText: (chunk: string) => void, onClose: (reason?: string) => void): Promise<void>;
  send(line: string): Promise<void>;
  close(): Promise<void>;
}

export const isWebSerialSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator;

/** Raspberry Pi's USB vendor ID, used by MicroPython on the Pico / Pico W. */
const RPI_VENDOR_ID = 0x2e8a;

export class SerialTransport implements Transport {
  readonly kind = 'serial';
  label = 'USB serial';
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private readableClosed: Promise<void> | null = null;
  private closing = false;
  private readonly encoder = new TextEncoder();

  /** Must be called from a user gesture (click): shows the browser's port picker. */
  async request(showAllPorts = false): Promise<void> {
    this.port = await navigator.serial.requestPort(
      showAllPorts ? {} : { filters: [{ usbVendorId: RPI_VENDOR_ID }] },
    );
    const info = this.port.getInfo();
    if (info.usbVendorId !== undefined) {
      const hex = (n?: number) => (n ?? 0).toString(16).padStart(4, '0');
      this.label = `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
    }
  }

  async start(onText: (chunk: string) => void, onClose: (reason?: string) => void): Promise<void> {
    const port = this.port;
    if (!port) throw new Error('No port selected');
    // USB CDC ignores the baud rate, but the API requires one.
    await port.open({ baudRate: 115200 });
    // MicroPython only sends to a host that has asserted DTR.
    await port.setSignals({ dataTerminalReady: true }).catch(() => undefined);
    if (!port.readable) throw new Error('Port is not readable');

    const decoder = new TextDecoderStream();
    this.readableClosed = port.readable.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => undefined);
    this.reader = decoder.readable.getReader();

    const reader = this.reader;
    void (async () => {
      let reason: string | undefined;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) onText(value);
        }
      } catch (err) {
        // Unplugging the board lands here with a NetworkError.
        reason = err instanceof Error ? err.message : String(err);
      } finally {
        reader.releaseLock();
        if (!this.closing) {
          await this.teardown();
          onClose(reason ?? 'device disconnected');
        }
      }
    })();
  }

  async send(line: string): Promise<void> {
    const writable = this.port?.writable;
    if (!writable) throw new Error('Not connected');
    const writer = writable.getWriter();
    try {
      await writer.write(this.encoder.encode(line));
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.reader?.cancel().catch(() => undefined);
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    await this.readableClosed;
    await this.port?.close().catch(() => undefined);
    this.reader = null;
    this.readableClosed = null;
  }
}

/**
 * Drives a PicoSimulator on a timer and hands its output to the app as
 * text chunks cut at random positions - the same shape real serial reads
 * have - so the simulator also exercises the line parser.
 */
export class SimTransport implements Transport {
  readonly kind = 'sim';
  readonly label = 'Simulator';
  private sim: PicoSimulator | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = '';
  private readonly rng = mulberry32(42);
  private onText: ((chunk: string) => void) | null = null;

  async start(onText: (chunk: string) => void): Promise<void> {
    const now = performance.now();
    this.sim = new PicoSimulator(now);
    this.onText = onText;
    this.pending = this.sim.hello() + '\r\n';
    this.timer = setInterval(() => this.pump(), 16);
  }

  private pump(): void {
    if (!this.sim || !this.onText) return;
    for (const line of this.sim.tick(performance.now())) this.pending += line + '\r\n';
    // Deliver everything that is due, cut into random-length chunks like USB
    // reads that stop mid-line. A short tail is sometimes held back until the
    // next tick, so lines really do arrive split across callbacks.
    while (this.pending.length > 0) {
      const n = 1 + Math.floor(this.rng() * 96);
      if (n >= this.pending.length && this.rng() < 0.3) break;
      this.onText(this.pending.slice(0, n));
      this.pending = this.pending.slice(n);
    }
  }

  async send(line: string): Promise<void> {
    if (!this.sim) throw new Error('Simulator not running');
    const replies = this.sim.command(line.trim(), performance.now());
    for (const r of replies) this.pending += r + '\r\n';
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sim = null;
    this.onText = null;
    this.pending = '';
  }
}
