/**
 * PicoPulse wire protocol, version 1 (see docs/PROTOCOL.md).
 *
 * Device -> host: one JSON object per line, discriminated by `t`.
 * Host -> device: one JSON object per line, discriminated by `cmd`.
 */

export const PROTOCOL_VERSION = 1;
export const MIN_HZ = 0.2;
export const MAX_HZ = 20;

export interface HelloMsg {
  t: 'hello';
  v: number;
  fw: string;
  board: string;
  uid: string;
  mpy?: string;
  hz: number;
  adc0?: string;
  window?: number;
}

export interface TelemetryMsg {
  t: 'tel';
  seq: number;
  ms: number;
  /** Smoothed temperature in deg C; null when the sensor reading is implausible (e.g. Wokwi). */
  temp: number | null;
  temp_raw?: number | null;
  /** ADC0 as a 0..1 fraction of 3.3 V; null when nothing is wired to GP26. */
  adc0: number | null;
  mem?: number;
  led?: boolean;
}

export interface HeartbeatMsg {
  t: 'hb';
  ms: number;
  seq: number;
}

export interface AckMsg {
  t: 'ack';
  cmd: string;
  [extra: string]: unknown;
}

export interface ErrMsg {
  t: 'err';
  msg: string;
  cmd?: string;
}

export type DeviceMsg = HelloMsg | TelemetryMsg | HeartbeatMsg | AckMsg | ErrMsg;

export type Command =
  | { cmd: 'led'; on: boolean }
  | { cmd: 'rate'; hz: number }
  | { cmd: 'blink'; n?: number }
  | { cmd: 'info' }
  | { cmd: 'ping' }
  | { cmd: 'reset_stats' };

export type ParseResult =
  | { ok: true; msg: DeviceMsg }
  | { ok: false; error: string; line: string };

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNumOrNull = (x: unknown) => x === null || isNum(x);

/** Validate an already-parsed JSON value. Returns an error string or null. */
export function validateMessage(value: unknown): string | null {
  if (!isObj(value)) return 'not an object';
  switch (value.t) {
    case 'hello':
      if (!isNum(value.v)) return 'hello.v must be a number';
      if (Math.floor(value.v) !== PROTOCOL_VERSION) return `unsupported protocol version ${value.v}`;
      if (!isStr(value.fw) || !isStr(value.board) || !isStr(value.uid)) return 'hello needs fw, board, uid';
      if (!isNum(value.hz)) return 'hello.hz must be a number';
      return null;
    case 'tel':
      if (!isNum(value.seq) || !isNum(value.ms)) return 'tel needs numeric seq and ms';
      if (!isNumOrNull(value.temp)) return 'tel.temp must be a number or null';
      if (!isNumOrNull(value.adc0)) return 'tel.adc0 must be a number or null';
      if (isNum(value.adc0) && (value.adc0 < 0 || value.adc0 > 1)) return 'tel.adc0 out of range 0..1';
      if (value.temp_raw !== undefined && !isNumOrNull(value.temp_raw)) return 'tel.temp_raw must be a number or null';
      if (value.mem !== undefined && !isNum(value.mem)) return 'tel.mem must be a number';
      if (value.led !== undefined && typeof value.led !== 'boolean') return 'tel.led must be a boolean';
      return null;
    case 'hb':
      if (!isNum(value.ms) || !isNum(value.seq)) return 'hb needs numeric ms and seq';
      return null;
    case 'ack':
      if (!isStr(value.cmd)) return 'ack.cmd must be a string';
      return null;
    case 'err':
      if (!isStr(value.msg)) return 'err.msg must be a string';
      return null;
    default:
      return `unknown message type ${JSON.stringify(value.t)}`;
  }
}

/** Parse one line from the device. Never throws. */
export function parseLine(line: string): ParseResult {
  const trimmed = line.trim();
  // MicroPython prints tracebacks and the REPL banner as plain text; those
  // are reported as errors rather than crashing the dashboard.
  if (!trimmed.startsWith('{')) return { ok: false, error: 'not JSON', line };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'invalid JSON', line };
  }
  const error = validateMessage(value);
  if (error) return { ok: false, error, line };
  return { ok: true, msg: value as DeviceMsg };
}

/** Serialise a host command as one line. Clamps the rate to what the firmware accepts. */
export function encodeCommand(cmd: Command): string {
  if (cmd.cmd === 'rate') {
    const hz = Math.min(MAX_HZ, Math.max(MIN_HZ, cmd.hz));
    return JSON.stringify({ cmd: 'rate', hz: Math.round(hz * 10) / 10 }) + '\n';
  }
  return JSON.stringify(cmd) + '\n';
}
