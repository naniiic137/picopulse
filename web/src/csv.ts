import type { TelemetryMsg } from './protocol';

export interface Row {
  /** Host wall-clock time of arrival (ms since epoch). */
  received: number;
  msg: TelemetryMsg;
}

export const CSV_HEADER = ['received_iso', 'seq', 'uptime_ms', 'temp_c', 'temp_raw_c', 'adc0', 'mem_free', 'led'];

const cell = (x: unknown): string => {
  if (x === null || x === undefined) return '';
  const s = String(x);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: readonly Row[]): string {
  const lines = [CSV_HEADER.join(',')];
  for (const { received, msg } of rows) {
    lines.push(
      [
        new Date(received).toISOString(),
        msg.seq,
        msg.ms,
        msg.temp,
        msg.temp_raw,
        msg.adc0,
        msg.mem,
        msg.led === undefined ? '' : msg.led ? 1 : 0,
      ]
        .map(cell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
