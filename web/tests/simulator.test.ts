import { describe, expect, it } from 'vitest';
import { LineParser } from '../src/lineParser';
import { parseLine } from '../src/protocol';
import { PicoSimulator } from '../src/simulator';

describe('PicoSimulator', () => {
  it('only emits messages that pass protocol validation', () => {
    const sim = new PicoSimulator(0);
    const lines = [sim.hello()];
    for (let t = 0; t <= 60_000; t += 50) lines.push(...sim.tick(t));
    expect(lines.length).toBeGreaterThan(100);
    for (const l of lines) expect(parseLine(l), l).toMatchObject({ ok: true });
  });

  it('streams at the requested rate after a rate command', () => {
    const sim = new PicoSimulator(0);
    expect(JSON.parse(sim.command('{"cmd":"rate","hz":10}', 0)[0])).toEqual({ t: 'ack', cmd: 'rate', hz: 10 });
    const tel: string[] = [];
    for (let t = 0; t <= 10_000; t += 10) tel.push(...sim.tick(t).filter((l) => l.includes('"tel"')));
    expect(tel.length).toBeGreaterThanOrEqual(99);
    expect(tel.length).toBeLessThanOrEqual(101);
  });

  it('answers commands like the firmware', () => {
    const sim = new PicoSimulator(0);
    expect(JSON.parse(sim.command('{"cmd":"led","on":true}', 0)[0])).toEqual({ t: 'ack', cmd: 'led', on: true });
    expect(JSON.parse(sim.command('{"cmd":"rate","hz":99}', 0)[0]).t).toBe('err');
    expect(JSON.parse(sim.command('nope', 0)[0])).toEqual({ t: 'err', msg: 'bad json' });
    expect(JSON.parse(sim.command('{"cmd":"x"}', 0)[0]).msg).toBe('unknown cmd');
  });

  it('warms past a 30 C alert threshold during its warm-up pulse', () => {
    const sim = new PicoSimulator(0);
    expect(sim.trueTemp(1000)).toBeLessThan(27);
    expect(sim.trueTemp(15_000)).toBeGreaterThan(30);
  });

  it('survives being fed through the line parser in irregular chunks', () => {
    const sim = new PicoSimulator(0);
    let text = sim.hello() + '\r\n';
    for (let t = 0; t <= 20_000; t += 100) for (const l of sim.tick(t)) text += l + '\r\n';
    const p = new LineParser();
    const out: string[] = [];
    let i = 0;
    let k = 1;
    while (i < text.length) {
      k = (k * 7 + 3) % 61; // deterministic irregular chunk sizes 1..61
      out.push(...p.push(text.slice(i, i + k + 1)));
      i += k + 1;
    }
    expect(out.join('\r\n') + '\r\n').toBe(text);
  });
});
