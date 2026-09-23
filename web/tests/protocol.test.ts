import { describe, expect, it } from 'vitest';
import { encodeCommand, parseLine, validateMessage } from '../src/protocol';

const tel = { t: 'tel', seq: 1, ms: 500, temp: 24.3, temp_raw: 24.9, adc0: 0.51, mem: 180000, led: false };

describe('parseLine', () => {
  it('accepts a valid telemetry line (with trailing whitespace)', () => {
    const r = parseLine(JSON.stringify(tel) + '\r');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.msg).toEqual(tel);
  });

  it('accepts null temp and adc0 (Wokwi / nothing wired)', () => {
    expect(parseLine(JSON.stringify({ ...tel, temp: null, temp_raw: null, adc0: null })).ok).toBe(true);
  });

  it('accepts the firmware hello, hb, ack and err messages', () => {
    const lines = [
      '{"t": "hello", "v": 1, "fw": "0.1.0", "board": "pico", "uid": "e660", "hz": 2, "adc0": "auto"}',
      '{"t": "hb", "ms": 5000, "seq": 10}',
      '{"t": "ack", "cmd": "rate", "hz": 10.0}',
      '{"t": "err", "msg": "unknown cmd", "cmd": "x"}',
    ];
    for (const l of lines) expect(parseLine(l)).toMatchObject({ ok: true });
  });

  it('rejects plain text such as a MicroPython traceback', () => {
    expect(parseLine('Traceback (most recent call last):')).toMatchObject({ ok: false, error: 'not JSON' });
  });

  it('rejects broken JSON (e.g. a line cut in half)', () => {
    expect(parseLine('{"t":"tel","seq":1,"ms"')).toMatchObject({ ok: false, error: 'invalid JSON' });
  });
});

describe('validateMessage', () => {
  it.each([
    ['array', []],
    ['null', null],
    ['unknown type', { t: 'boom' }],
    ['missing seq', { ...tel, seq: undefined }],
    ['string temp', { ...tel, temp: '24.3' }],
    ['non-finite temp', { ...tel, temp: Infinity }],
    ['adc0 above 1', { ...tel, adc0: 1.5 }],
    ['adc0 below 0', { ...tel, adc0: -0.1 }],
    ['non-boolean led', { ...tel, led: 1 }],
    ['hb without seq', { t: 'hb', ms: 1 }],
    ['ack without cmd', { t: 'ack' }],
    ['err without msg', { t: 'err' }],
  ])('rejects %s', (_name, value) => {
    expect(validateMessage(value)).not.toBeNull();
  });

  it('rejects a hello with an unsupported major protocol version', () => {
    const hello = { t: 'hello', v: 2, fw: '9', board: 'pico', uid: 'x', hz: 2 };
    expect(validateMessage(hello)).toMatch(/unsupported protocol version/);
    expect(validateMessage({ ...hello, v: 1 })).toBeNull();
    expect(validateMessage({ ...hello, v: 1.1 })).toBeNull(); // minor bumps stay compatible
  });
});

describe('encodeCommand', () => {
  it('produces one newline-terminated JSON line', () => {
    expect(encodeCommand({ cmd: 'led', on: true })).toBe('{"cmd":"led","on":true}\n');
    expect(encodeCommand({ cmd: 'blink', n: 3 })).toBe('{"cmd":"blink","n":3}\n');
  });

  it('clamps the rate to the range the firmware accepts', () => {
    expect(JSON.parse(encodeCommand({ cmd: 'rate', hz: 1000 })).hz).toBe(20);
    expect(JSON.parse(encodeCommand({ cmd: 'rate', hz: 0 })).hz).toBe(0.2);
    expect(JSON.parse(encodeCommand({ cmd: 'rate', hz: 10 })).hz).toBe(10);
  });
});
