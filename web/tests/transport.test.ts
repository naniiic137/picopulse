import { describe, expect, it, vi } from 'vitest';
import { MAX_READ_RETRIES, READ_BUFFER_SIZE, SerialTransport, type SerialPortLike } from '../src/transport';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A fake Web Serial port built on real WHATWG streams, following the spec's
 * rules: after a non-fatal read error `readable` returns a fresh stream,
 * after a fatal one it returns null, and close() refuses locked streams.
 */
class FakePort implements SerialPortLike {
  options: SerialOptions | null = null;
  signals: SerialOutputSignals | null = null;
  written: string[] = [];
  closed = false;
  writeDelayMs = 5;
  private fatal = false;
  private current: ReadableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private stream: WritableStream<Uint8Array> | null = null;

  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.options || this.closed || this.fatal) return null;
    if (!this.current) {
      this.current = new ReadableStream<Uint8Array>({
        start: (c) => {
          this.controller = c;
        },
      });
    }
    return this.current;
  }

  get writable(): WritableStream<Uint8Array> | null {
    return this.options && !this.closed ? this.stream : null;
  }

  async open(options: SerialOptions): Promise<void> {
    this.options = options;
    this.closed = false;
    this.fatal = false;
    this.current = null;
    this.controller = null;
    this.stream = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        await new Promise((r) => setTimeout(r, this.writeDelayMs));
        this.written.push(dec.decode(chunk));
      },
    });
  }

  async setSignals(signals: SerialOutputSignals): Promise<void> {
    this.signals = signals;
  }

  getInfo(): SerialPortInfo {
    return { usbVendorId: 0x2e8a, usbProductId: 0x0005 };
  }

  async close(): Promise<void> {
    if (this.current?.locked || this.stream?.locked) throw new DOMException('stream locked', 'InvalidStateError');
    this.closed = true;
  }

  emit(text: string): void {
    void this.readable; // make sure a stream exists
    this.controller?.enqueue(enc.encode(text));
  }

  /** e.g. BufferOverrunError: the current stream errors and a new one takes its place. */
  failNonFatal(name = 'BufferOverrunError'): void {
    const c = this.controller;
    this.current = null;
    this.controller = null;
    c?.error(new DOMException('Receive buffer overrun', name));
  }

  /** The device was unplugged. */
  failFatal(): void {
    this.fatal = true;
    this.controller?.error(new DOMException('The device has been lost.', 'NetworkError'));
  }
}

async function connect(port = new FakePort()) {
  const t = new SerialTransport(port);
  const text: string[] = [];
  const warnings: string[] = [];
  const onClose = vi.fn<(reason?: string) => void>();
  await t.start((c) => text.push(c), onClose, (w) => warnings.push(w));
  return { t, port, text: () => text.join(''), warnings, onClose };
}

describe('SerialTransport', () => {
  it('opens with DTR and a large read buffer', async () => {
    const { port } = await connect();
    expect(port.options).toEqual({ baudRate: 115200, bufferSize: READ_BUFFER_SIZE });
    expect(port.signals).toEqual({ dataTerminalReady: true });
  });

  it('delivers received text', async () => {
    const { port, text } = await connect();
    port.emit('{"t":"hb",');
    port.emit('"ms":1,"seq":2}\n');
    await vi.waitFor(() => expect(text()).toBe('{"t":"hb","ms":1,"seq":2}\n'));
  });

  it('handles overlapping sends in order without a "locked" error', async () => {
    const { t, port } = await connect();
    const lines = ['{"cmd":"led","on":true}\n', '{"cmd":"blink","n":3}\n', '{"cmd":"rate","hz":5}\n'];
    await Promise.all(lines.map((l) => t.send(l)));
    expect(port.written).toEqual(lines);
  });

  it('keeps reading after a non-fatal read error', async () => {
    const { port, text, warnings, onClose } = await connect();
    port.emit('before\n');
    await vi.waitFor(() => expect(text()).toBe('before\n'));
    port.failNonFatal();
    await vi.waitFor(() => expect(warnings).toHaveLength(1));
    expect(warnings[0]).toMatch(/BufferOverrunError/);
    port.emit('after\n');
    await vi.waitFor(() => expect(text()).toBe('before\nafter\n'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('gives up after repeated errors with no data in between', async () => {
    const { port, onClose, warnings } = await connect();
    for (let i = 0; i <= MAX_READ_RETRIES; i++) {
      await vi.waitFor(() => expect(port.readable?.locked).toBe(true));
      port.failNonFatal();
      await vi.waitFor(() => expect(warnings.length + onClose.mock.calls.length).toBe(i + 1));
    }
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.calls[0][0]).toMatch(/gave up/);
    expect(port.closed).toBe(true);
  });

  it('reports a fatal error (unplugged) once and releases the port', async () => {
    const { t, port, onClose, warnings } = await connect();
    await vi.waitFor(() => expect(port.readable?.locked).toBe(true));
    port.failFatal();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onClose.mock.calls[0][0]).toMatch(/NetworkError/);
    expect(warnings).toEqual([]);
    expect(port.closed).toBe(true);
    await expect(t.send('{"cmd":"ping"}\n')).rejects.toThrow('Not connected');
  });

  it('close() unlocks both streams, closes the port and does not call onClose', async () => {
    const { t, port, onClose } = await connect();
    await vi.waitFor(() => expect(port.readable?.locked).toBe(true));
    const pending = t.send('{"cmd":"info"}\n');
    await t.close();
    await pending;
    expect(port.written).toEqual(['{"cmd":"info"}\n']);
    expect(port.closed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await expect(t.send('x\n')).rejects.toThrow('Not connected');
  });

  it('can reconnect after close()', async () => {
    const port = new FakePort();
    const first = await connect(port);
    await first.t.close();
    const second = await connect(port);
    port.emit('again\n');
    await vi.waitFor(() => expect(second.text()).toBe('again\n'));
    await second.t.send('ping\n');
    expect(port.written).toEqual(['ping\n']);
  });
});
