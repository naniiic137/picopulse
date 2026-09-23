import { PicoSimulator, mulberry32 } from './simulator';

/** Something that delivers raw text from a device and accepts command lines. */
export interface Transport {
  readonly kind: 'serial' | 'sim';
  readonly label: string;
  /**
   * `onClose` fires once when the link ends without close() being called.
   * `onWarn` reports problems the transport recovered from by itself.
   */
  start(
    onText: (chunk: string) => void,
    onClose: (reason?: string) => void,
    onWarn?: (message: string) => void,
  ): Promise<void>;
  send(line: string): Promise<void>;
  close(): Promise<void>;
}

export const isWebSerialSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator;

/** Raspberry Pi's USB vendor ID, used by MicroPython on the Pico / Pico W. */
const RPI_VENDOR_ID = 0x2e8a;

/**
 * Read buffer size passed to port.open(). The default (255 bytes) overruns
 * easily when the tab is busy; 64 KiB holds many seconds of telemetry.
 */
export const READ_BUFFER_SIZE = 64 * 1024;

/** Give up after this many read errors in a row without any data in between. */
export const MAX_READ_RETRIES = 5;

/** How long close() waits for queued commands before releasing the writer. */
const CLOSE_FLUSH_MS = 200;

/** The part of the Web Serial SerialPort that the transport uses (a fake in tests). */
export type SerialPortLike = Pick<SerialPort, 'readable' | 'writable' | 'open' | 'close' | 'setSignals' | 'getInfo'>;

const errorName = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SerialTransport implements Transport {
  readonly kind = 'serial';
  label = 'USB serial';
  private port: SerialPortLike | null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  /** One writer for the whole connection: getWriter() per send throws "locked" when sends overlap. */
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** Sends are chained so they reach the device in call order, one at a time. */
  private sendQueue: Promise<unknown> = Promise.resolve();
  private readLoop: Promise<void> | null = null;
  private closing = false;
  private readonly encoder = new TextEncoder();

  constructor(port: SerialPortLike | null = null) {
    this.port = port;
  }

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

  async start(
    onText: (chunk: string) => void,
    onClose: (reason?: string) => void,
    onWarn?: (message: string) => void,
  ): Promise<void> {
    const port = this.port;
    if (!port) throw new Error('No port selected');
    // USB CDC ignores the baud rate, but the API requires one.
    await port.open({ baudRate: 115200, bufferSize: READ_BUFFER_SIZE });
    // MicroPython only sends to a host that has asserted DTR.
    await port.setSignals({ dataTerminalReady: true }).catch(() => undefined);
    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined);
      throw new Error('Port is not readable');
    }
    this.closing = false;
    this.writer = port.writable.getWriter();
    this.sendQueue = Promise.resolve();
    this.readLoop = this.runReadLoop(port, onText, onWarn).then(async (reason) => {
      if (this.closing) return;
      await this.teardown();
      onClose(reason);
    });
  }

  /**
   * Reads until the port goes away. Web Serial replaces port.readable with a
   * fresh stream after a non-fatal error (buffer overrun, framing / parity
   * error, break) and sets it to null after a fatal one (device unplugged),
   * so the outer loop reopens the reader for the first kind only.
   */
  private async runReadLoop(
    port: SerialPortLike,
    onText: (chunk: string) => void,
    onWarn?: (message: string) => void,
  ): Promise<string> {
    let failures = 0;
    let lastError: string | undefined;
    while (port.readable && !this.closing) {
      const decoder = new TextDecoderStream();
      const piped = port.readable.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => undefined);
      const reader = decoder.readable.getReader();
      this.reader = reader;
      let ended = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          if (value) {
            failures = 0;
            onText(value);
          }
        }
      } catch (err) {
        // Unplugging the board lands here with a NetworkError.
        lastError = errorName(err);
        failures++;
      } finally {
        reader.releaseLock();
        this.reader = null;
        await piped;
      }
      if (ended || this.closing) break;
      if (failures > MAX_READ_RETRIES) {
        lastError = `${lastError} (gave up after ${MAX_READ_RETRIES} retries)`;
        break;
      }
      if (port.readable) onWarn?.(`Serial read error (${lastError}), reading resumed`);
    }
    return lastError ?? 'device disconnected';
  }

  send(line: string): Promise<void> {
    const writer = this.writer;
    if (!writer) return Promise.reject(new Error('Not connected'));
    const bytes = this.encoder.encode(line);
    const result = this.sendQueue.then(() => writer.write(bytes));
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.reader?.cancel().catch(() => undefined);
    await this.readLoop;
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    const writer = this.writer;
    this.writer = null;
    if (writer) {
      // Let queued commands go out, but do not hang on a device that stopped reading.
      await Promise.race([this.sendQueue, delay(CLOSE_FLUSH_MS)]);
      writer.releaseLock();
    }
    await this.port?.close().catch(() => undefined);
    this.readLoop = null;
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
