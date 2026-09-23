import './style.css';
import { TimeChart } from './chart';
import { toCsv, type Row } from './csv';
import { LineParser } from './lineParser';
import { encodeCommand, parseLine, type Command, type DeviceMsg, type HelloMsg, type TelemetryMsg } from './protocol';
import { Series, ThresholdAlert, measuredRate } from './stats';
import { SerialTransport, SimTransport, isWebSerialSupported, type Transport } from './transport';

// ------------------------------------------------------------------ config
const WINDOW_MS = 60_000;
const HISTORY = 20 * 300; // 5 minutes at the maximum rate of 20 Hz
const MAX_ROWS = 200_000; // CSV rows kept in memory (~3 h at 20 Hz)
const RATES = [0.2, 0.5, 1, 2, 5, 10, 20];
const COLORS = { temp: '#ffb547', adc: '#4cc9f0', mem: '#a78bfa' };

// --------------------------------------------------------------------- DOM
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  status: $('status'),
  statusText: $('status-text'),
  connect: $<HTMLButtonElement>('btn-connect'),
  sim: $<HTMLButtonElement>('btn-sim'),
  disconnect: $<HTMLButtonElement>('btn-disconnect'),
  bannerUnsupported: $('banner-unsupported'),
  bannerSim: $('banner-sim'),
  bannerError: $('banner-error'),
  empty: $('empty-state'),
  led: $<HTMLButtonElement>('btn-led'),
  blink: $<HTMLButtonElement>('btn-blink'),
  rate: $<HTMLInputElement>('rate'),
  rateOut: $<HTMLOutputElement>('rate-out'),
  threshold: $<HTMLInputElement>('threshold'),
  alertChip: $('alert-chip'),
  log: $<HTMLOListElement>('log'),
  pause: $<HTMLButtonElement>('btn-pause'),
  clear: $<HTMLButtonElement>('btn-clear'),
  csv: $<HTMLButtonElement>('btn-csv'),
  rows: $('rows'),
  adcNote: $('adc-note'),
  cardTemp: $('card-temp'),
  raw: $('raw'),
};

// ------------------------------------------------------------------- state
const parser = new LineParser();
const series = { temp: new Series(HISTORY), adc: new Series(HISTORY), mem: new Series(HISTORY) };
const alert = new ThresholdAlert(loadThreshold());
let transport: Transport | null = null;
let rows: Row[] = [];
let hello: HelloMsg | null = null;
let last: TelemetryMsg | null = null;
let lastSeq: number | null = null;
let lastHbAt = 0;
let arrivals: number[] = [];
let counts = { ok: 0, bad: 0, lost: 0 };
let paused = false;
let pausedAt = 0;
let dirty = true;

const fmt1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '--');
const charts = {
  temp: new TimeChart($<HTMLCanvasElement>('chart-temp'), {
    color: COLORS.temp,
    windowMs: WINDOW_MS,
    minSpan: 2,
    format: fmt1,
    threshold: () => alert.threshold,
  }),
  adc: new TimeChart($<HTMLCanvasElement>('chart-adc'), {
    color: COLORS.adc,
    windowMs: WINDOW_MS,
    yMin: 0,
    yMax: 100,
    minSpan: 100,
    format: (v) => v.toFixed(0),
  }),
  mem: new TimeChart($<HTMLCanvasElement>('chart-mem'), {
    color: COLORS.mem,
    windowMs: WINDOW_MS,
    minSpan: 4,
    format: (v) => v.toFixed(0),
  }),
};

// ------------------------------------------------------------ connections
async function connectSerial(): Promise<void> {
  const serial = new SerialTransport();
  try {
    await serial.request();
  } catch (err) {
    // The user closed the port picker - not an error worth shouting about.
    if (err instanceof DOMException && err.name === 'NotFoundError') return;
    showError(`Could not open the port picker: ${errorText(err)}`);
    return;
  }
  await startTransport(serial);
}

async function startTransport(next: Transport): Promise<void> {
  await stopTransport();
  resetSession();
  hideError();
  transport = next;
  setStatus('connecting', next.kind === 'sim' ? 'Starting simulator' : 'Connecting');
  try {
    await next.start(onText, (reason) => {
      if (transport !== next) return;
      transport = null;
      logEvent('warn', `Link closed: ${reason ?? 'unknown reason'}`);
      setStatus('idle', 'Disconnected');
      updateControls();
    });
  } catch (err) {
    transport = null;
    setStatus('idle', 'Disconnected');
    showError(serialHelp(err));
    updateControls();
    return;
  }
  setStatus(next.kind, next.kind === 'sim' ? 'Simulator running' : 'Connected');
  logEvent('info', next.kind === 'sim' ? 'Simulator started' : `Connected (${next.label})`);
  updateControls();
  // The hello was printed at boot, probably before we opened the port: ask again.
  if (next.kind === 'serial') void sendCommand({ cmd: 'info' }, false);
}

async function stopTransport(): Promise<void> {
  const t = transport;
  transport = null;
  if (t) {
    await t.close();
    logEvent('info', t.kind === 'sim' ? 'Simulator stopped' : 'Disconnected');
  }
  setStatus('idle', 'Disconnected');
  updateControls();
}

async function sendCommand(cmd: Command, log = true): Promise<void> {
  if (!transport) return;
  try {
    const line = encodeCommand(cmd);
    await transport.send(line);
    rawLine('tx', line);
    if (log) logEvent('cmd', `Sent ${describe(cmd)}`);
  } catch (err) {
    logEvent('error', `Send failed: ${errorText(err)}`);
  }
}

// ------------------------------------------------------------- data path
const RAW_LINES = 9;
function rawLine(dir: 'rx' | 'tx', text: string, bad = false): void {
  if (paused && dir === 'rx') return;
  const div = document.createElement('div');
  div.className = `raw-${dir}${bad ? ' raw-bad' : ''}`;
  div.textContent = text.trimEnd();
  el.raw.append(div);
  while (el.raw.children.length > RAW_LINES) el.raw.firstElementChild?.remove();
}

function onText(chunk: string): void {
  for (const line of parser.push(chunk)) {
    const res = parseLine(line);
    rawLine('rx', line, !res.ok);
    if (res.ok) {
      counts.ok++;
      handleMessage(res.msg);
    } else {
      counts.bad++;
      // Plain-text lines are usually the MicroPython banner or a traceback: show them.
      if (res.error === 'not JSON') logEvent('warn', `Device: ${line.slice(0, 120)}`);
      else logEvent('error', `Bad message (${res.error})`);
    }
  }
}

function handleMessage(msg: DeviceMsg): void {
  const now = performance.now();
  switch (msg.t) {
    case 'hello':
      hello = msg;
      el.rate.value = String(nearestRateIndex(msg.hz));
      el.rateOut.textContent = `${msg.hz} Hz`;
      logEvent('info', `Hello from ${msg.board} (fw ${msg.fw})`);
      break;
    case 'tel':
      onTelemetry(msg, now);
      break;
    case 'hb':
      lastHbAt = now;
      break;
    case 'ack':
      if (msg.cmd === 'rate' && typeof msg.hz === 'number') el.rateOut.textContent = `${msg.hz} Hz`;
      if (msg.cmd !== 'info') logEvent('ok', `Device ack: ${msg.cmd}${ackDetail(msg)}`);
      break;
    case 'err':
      logEvent('error', `Device error: ${msg.msg}${msg.cmd ? ` (${msg.cmd})` : ''}`);
      break;
  }
  dirty = true;
}

function onTelemetry(msg: TelemetryMsg, now: number): void {
  if (lastSeq !== null && msg.seq > lastSeq + 1) counts.lost += msg.seq - lastSeq - 1;
  if (lastSeq !== null && msg.seq < lastSeq) logEvent('warn', 'Sequence restarted (device reset?)');
  lastSeq = msg.seq;
  last = msg;
  arrivals.push(now);
  if (arrivals.length > 40) arrivals.shift();
  if (paused) return;

  if (msg.temp !== null) series.temp.push(now, msg.temp);
  if (msg.adc0 !== null) series.adc.push(now, msg.adc0 * 100);
  if (msg.mem !== undefined) series.mem.push(now, msg.mem / 1024);
  if (rows.length < MAX_ROWS) rows.push({ received: Date.now(), msg });

  const change = alert.update(msg.temp);
  if (change === 'raised') logEvent('alert', `Temperature ${msg.temp?.toFixed(1)} °C crossed ${alert.threshold} °C`);
  if (change === 'cleared') logEvent('ok', `Temperature back to ${msg.temp?.toFixed(1)} °C`);
}

// -------------------------------------------------------------- rendering
function frame(): void {
  const now = paused ? pausedAt : performance.now();
  if (transport || dirty) {
    charts.temp.draw(series.temp, now);
    charts.adc.draw(series.adc, now);
    charts.mem.draw(series.mem, now);
  }
  if (dirty) renderText(now);
  requestAnimationFrame(frame);
}

let textTimer = 0;
function renderText(now: number): void {
  // Text does not need 60 fps; five updates a second keeps it readable.
  if (performance.now() - textTimer < 200) return;
  textTimer = performance.now();
  dirty = !!transport;

  const since = now - WINDOW_MS;
  const t = series.temp.stats(since);
  const a = series.adc.stats(since);
  const m = series.mem.stats(since);
  setText('temp-now', last?.temp != null ? last.temp.toFixed(1) : '--.-');
  setText('temp-min', fmtUnit(t.min, 1, '°'));
  setText('temp-avg', fmtUnit(t.avg, 1, '°'));
  setText('temp-max', fmtUnit(t.max, 1, '°'));
  setText('temp-count', String(t.count));
  setText('adc-now', last?.adc0 != null ? (last.adc0 * 100).toFixed(0) : '--');
  setText('adc-min', fmtUnit(a.min, 0, '%'));
  setText('adc-avg', fmtUnit(a.avg, 0, '%'));
  setText('adc-max', fmtUnit(a.max, 0, '%'));
  setText('mem-now', last?.mem !== undefined ? (last.mem / 1024).toFixed(1) : '--');
  setText('mem-min', fmtUnit(m.min, 1, ''));
  setText('mem-avg', fmtUnit(m.avg, 1, ''));
  setText('mem-max', fmtUnit(m.max, 1, ''));
  el.adcNote.hidden = !(last && last.adc0 === null);
  el.empty.hidden = series.temp.length > 0 || (last !== null && last.temp === null);
  if (last && last.temp === null) setText('temp-now', 'n/a');

  el.cardTemp.classList.toggle('alarm', alert.active);
  el.alertChip.className = `chip ${alert.active ? 'alarm' : 'ok'}`;
  el.alertChip.textContent = alert.active ? `Above ${alert.threshold} °C` : 'Normal';

  setText('i-board', hello ? boardLabel(hello.board) : '—');
  setText('i-fw', hello?.fw ?? '—');
  setText('i-proto', hello ? `v${hello.v}` : '—');
  setText('i-uid', hello?.uid ?? '—');
  setText('i-mpy', hello?.mpy ? shortMpy(hello.mpy) : '—');
  setText('i-link', transport ? transport.label : '—');
  setText('i-uptime', last ? formatUptime(last.ms) : '—');
  setText('i-rate', last ? `${measuredRate(arrivals).toFixed(1)} Hz measured` : '—');
  setText('i-msgs', transport || counts.ok ? `${counts.ok} ok · ${counts.bad} bad · ${counts.lost} lost` : '—');
  setText('i-hb', lastHbAt ? `${((performance.now() - lastHbAt) / 1000).toFixed(0)} s ago` : '—');
  if (last) {
    el.led.setAttribute('aria-checked', String(!!last.led));
  }
  el.rows.textContent = `${rows.length.toLocaleString('en-US')} rows`;
  el.csv.disabled = rows.length === 0;
}

// ---------------------------------------------------------------- helpers
function setText(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node && node.textContent !== text) node.textContent = text;
}

function fmtUnit(v: number, digits: number, unit: string): string {
  return Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : '--';
}

function setStatus(state: 'idle' | 'connecting' | 'serial' | 'sim', text: string): void {
  el.status.dataset.state = state;
  el.statusText.textContent = text;
  el.bannerSim.hidden = state !== 'sim';
}

function updateControls(): void {
  const live = !!transport;
  el.led.disabled = !live;
  el.blink.disabled = !live;
  el.rate.disabled = !live;
  el.connect.hidden = live;
  el.sim.hidden = live;
  el.disconnect.hidden = !live;
  el.disconnect.textContent = transport?.kind === 'sim' ? 'Stop simulator' : 'Disconnect';
  el.connect.disabled = !isWebSerialSupported();
  dirty = true;
}

type LogKind = 'info' | 'ok' | 'warn' | 'error' | 'alert' | 'cmd';
function logEvent(kind: LogKind, text: string): void {
  const li = document.createElement('li');
  li.className = `log-${kind}`;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const span = document.createElement('span');
  span.textContent = text;
  li.append(time, span);
  el.log.prepend(li);
  while (el.log.children.length > 60) el.log.lastElementChild?.remove();
}

function resetSession(): void {
  parser.reset();
  for (const s of Object.values(series)) s.clear();
  rows = [];
  hello = null;
  last = null;
  lastSeq = null;
  lastHbAt = 0;
  arrivals = [];
  counts = { ok: 0, bad: 0, lost: 0 };
  alert.active = false;
  el.raw.replaceChildren();
  dirty = true;
}

function showError(text: string): void {
  el.bannerError.textContent = text;
  el.bannerError.hidden = false;
}

function hideError(): void {
  el.bannerError.hidden = true;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serialHelp(err: unknown): string {
  const msg = errorText(err);
  if (/open|busy|access/i.test(msg)) {
    return `Could not open the port (${msg}). Close Thonny, mpremote or any other serial monitor using the Pico and try again.`;
  }
  return `Connection failed: ${msg}`;
}

function describe(cmd: Command): string {
  switch (cmd.cmd) {
    case 'led':
      return `LED ${cmd.on ? 'on' : 'off'}`;
    case 'rate':
      return `rate ${cmd.hz} Hz`;
    case 'blink':
      return `blink x${cmd.n ?? 3}`;
    default:
      return cmd.cmd;
  }
}

function ackDetail(msg: Record<string, unknown>): string {
  if (msg.cmd === 'led') return msg.on ? ' (on)' : ' (off)';
  if (msg.cmd === 'rate') return ` (${msg.hz} Hz)`;
  if (msg.cmd === 'blink') return ` (x${msg.n})`;
  return '';
}

function boardLabel(board: string): string {
  return { pico: 'Raspberry Pi Pico', 'pico-w': 'Raspberry Pi Pico W', simulator: 'Simulated Pico' }[board] ?? board;
}

function shortMpy(v: string): string {
  const m = /MicroPython (v[\d.]+)/.exec(v);
  return m ? m[1] : v;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function nearestRateIndex(hz: number): number {
  let best = 0;
  RATES.forEach((r, i) => {
    if (Math.abs(r - hz) < Math.abs(RATES[best] - hz)) best = i;
  });
  return best;
}

function loadThreshold(): number {
  try {
    const v = Number(localStorage.getItem('picopulse.threshold'));
    return Number.isFinite(v) && v !== 0 ? v : 30;
  } catch {
    return 30;
  }
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------------------------------------------------------- events
el.connect.addEventListener('click', () => void connectSerial());
el.sim.addEventListener('click', () => void startTransport(new SimTransport()));
el.disconnect.addEventListener('click', () => void stopTransport());

el.led.addEventListener('click', () => {
  const on = el.led.getAttribute('aria-checked') !== 'true';
  el.led.setAttribute('aria-checked', String(on));
  void sendCommand({ cmd: 'led', on });
});
el.blink.addEventListener('click', () => void sendCommand({ cmd: 'blink', n: 3 }));
el.rate.addEventListener('input', () => {
  el.rateOut.textContent = `${RATES[Number(el.rate.value)]} Hz`;
});
el.rate.addEventListener('change', () => void sendCommand({ cmd: 'rate', hz: RATES[Number(el.rate.value)] }));
el.threshold.value = String(alert.threshold);
el.threshold.addEventListener('change', () => {
  const v = Number(el.threshold.value);
  if (!Number.isFinite(v)) return;
  alert.threshold = v;
  alert.active = false;
  try {
    localStorage.setItem('picopulse.threshold', String(v));
  } catch {
    /* storage unavailable: keep the value for this session only */
  }
  logEvent('info', `Alert threshold set to ${v} °C`);
  dirty = true;
});

el.pause.addEventListener('click', () => {
  paused = !paused;
  pausedAt = performance.now();
  el.pause.setAttribute('aria-pressed', String(paused));
  el.pause.textContent = paused ? 'Resume' : 'Pause';
  logEvent('info', paused ? 'Paused - incoming samples are not recorded' : 'Resumed');
  dirty = true;
});
el.clear.addEventListener('click', () => {
  for (const s of Object.values(series)) s.clear();
  rows = [];
  counts = { ok: 0, bad: 0, lost: 0 };
  alert.active = false;
  el.log.replaceChildren();
  el.raw.replaceChildren();
  dirty = true;
});
el.csv.addEventListener('click', () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  download(`picopulse-${stamp}.csv`, toCsv(rows));
  logEvent('info', `Exported ${rows.length} rows to CSV`);
});

if (isWebSerialSupported()) {
  navigator.serial.addEventListener('disconnect', () => {
    if (transport?.kind === 'serial') logEvent('warn', 'USB device unplugged');
  });
} else {
  el.bannerUnsupported.hidden = false;
  el.connect.title = 'Web Serial needs Chrome or Edge on desktop';
}

updateControls();
logEvent('info', 'Ready. Connect a Pico or run the simulator.');
requestAnimationFrame(frame);

// ?sim opens the dashboard straight into simulator mode (handy for demos).
if (new URLSearchParams(location.search).has('sim')) void startTransport(new SimTransport());
