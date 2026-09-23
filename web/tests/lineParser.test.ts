import { describe, expect, it } from 'vitest';
import { LineParser } from '../src/lineParser';

describe('LineParser', () => {
  it('returns complete lines and keeps the partial tail', () => {
    const p = new LineParser();
    expect(p.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(p.pending).toBe('{"b"');
    expect(p.push(':2}\n')).toEqual(['{"b":2}']);
    expect(p.pending).toBe('');
  });

  it('handles CRLF endings, including a CR at the end of a chunk', () => {
    const p = new LineParser();
    expect(p.push('one\r')).toEqual([]);
    expect(p.push('\ntwo\r\n')).toEqual(['one', 'two']);
  });

  it('splits several lines in one chunk and skips blank lines', () => {
    const p = new LineParser();
    expect(p.push('a\n\n\r\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('reassembles a line delivered one character at a time', () => {
    const p = new LineParser();
    const text = '{"t":"hb","ms":5000,"seq":10}\n';
    const out: string[] = [];
    for (const ch of text) out.push(...p.push(ch));
    expect(out).toEqual(['{"t":"hb","ms":5000,"seq":10}']);
  });

  it('gives identical output for any chunking of the same stream', () => {
    const stream = Array.from({ length: 50 }, (_, i) => `{"t":"tel","seq":${i}}\r\n`).join('');
    const whole = new LineParser().push(stream);
    for (const size of [1, 3, 7, 64, 1000]) {
      const p = new LineParser();
      const out: string[] = [];
      for (let i = 0; i < stream.length; i += size) out.push(...p.push(stream.slice(i, i + size)));
      expect(out).toEqual(whole);
    }
    expect(whole).toHaveLength(50);
  });

  it('drops an over-long line without a newline, then recovers', () => {
    const p = new LineParser(16);
    expect(p.push('x'.repeat(40))).toEqual([]);
    expect(p.overflows).toBe(1);
    expect(p.push('still garbage\nok\n')).toEqual(['ok']);
  });

  it('drops an over-long complete line', () => {
    const p = new LineParser(8);
    expect(p.push('123456789012\nshort\n')).toEqual(['short']);
    expect(p.overflows).toBe(1);
  });

  it('reset() forgets the partial line', () => {
    const p = new LineParser();
    p.push('{"half');
    p.reset();
    expect(p.push('ok\n')).toEqual(['ok']);
  });
});
