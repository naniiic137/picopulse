/**
 * Turns an arbitrary stream of text chunks into complete lines.
 *
 * Serial reads do not respect message boundaries: one read can hold half a
 * line, or three and a half. The parser keeps the unfinished tail between
 * calls, accepts \n and \r\n endings, and drops a line that grows beyond
 * `maxLineLength` (for example when the device prints garbage without a
 * newline) so memory cannot grow without bound.
 */
export class LineParser {
  private buffer = '';
  private discarding = false;
  /** Number of lines dropped because they exceeded maxLineLength. */
  overflows = 0;

  constructor(private readonly maxLineLength = 4096) {}

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) !== 10) continue; // '\n'
      const piece = chunk.slice(start, i);
      start = i + 1;
      if (this.discarding) {
        this.discarding = false;
        this.buffer = '';
        continue;
      }
      let line = this.buffer + piece;
      this.buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > this.maxLineLength) {
        this.overflows++;
        continue;
      }
      if (line.trim() !== '') lines.push(line);
    }
    if (!this.discarding) {
      this.buffer += chunk.slice(start);
      if (this.buffer.length > this.maxLineLength) {
        this.overflows++;
        this.buffer = '';
        this.discarding = true;
      }
    }
    return lines;
  }

  /** Text received after the last newline (not yet a complete line). */
  get pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    this.discarding = false;
  }
}
