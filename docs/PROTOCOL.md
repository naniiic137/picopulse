# PicoPulse serial protocol — version 1

The Pico and the dashboard exchange **newline-delimited JSON** over the Pico's
USB CDC serial port (the same port MicroPython uses for its REPL).

- One JSON object per line. Lines end with `\n`; the receiver also accepts
  `\r\n` (MicroPython's USB stdout may add the `\r`).
- UTF-8 (in practice plain ASCII).
- A receiver ignores blank lines and **reports but survives** any line that is
  not valid JSON or does not match a schema below (e.g. the MicroPython banner,
  a traceback, or a line cut in half when the port was opened mid-message).
- The baud rate is irrelevant for USB CDC; the dashboard opens the port at 115200.
- The dashboard must assert DTR, otherwise MicroPython does not send output.

Implementations: [`firmware/main.py`](../firmware/main.py) (device),
[`web/src/protocol.ts`](../web/src/protocol.ts) (validation, host),
[`web/src/simulator.ts`](../web/src/simulator.ts) (a fake device used by the demo).

## Versioning

- The device announces the protocol version in the `hello` message (`v`).
- The version is a number `MAJOR[.MINOR]`. The dashboard accepts any
  `v` whose integer part is `1`.
- **Minor** changes only *add* optional fields or new message / command types.
  Receivers must ignore fields they do not know.
- **Major** changes rename, remove or change the meaning of a field. The
  dashboard refuses a `hello` with an unknown major version and says so.
- `v` is only sent in `hello` (not in every message) to keep telemetry lines short.

## Device → host

Every message has a type field `t`.

### `hello` — sent at boot and in reply to `{"cmd":"info"}`

```json
{"t": "hello", "v": 1, "fw": "0.2.0", "board": "pico", "uid": "e6605838832a4f21",
 "mpy": "3.4.0; MicroPython v1.22.0 on 2023-12-27", "hz": 2, "adc0": "off", "window": 8}
```

| field    | type   | required | meaning |
|----------|--------|----------|---------|
| `v`      | number | yes | protocol version |
| `fw`     | string | yes | firmware version |
| `board`  | string | yes | `"pico"`, `"pico-w"` (from `sys.implementation._machine`), or `"simulator"` |
| `uid`    | string | yes | `machine.unique_id()` as hex (flash chip ID) |
| `hz`     | number | yes | current telemetry rate |
| `mpy`    | string | no  | `sys.version` |
| `adc0`   | string | no  | ADC0 mode in effect: `"off"` (default), `"on"` or `"auto"` |
| `window` | number | no  | moving-average window size |

The hello is printed at boot, usually before any host has opened the port, so
the dashboard sends `{"cmd":"info"}` right after connecting to get it again.

### `tel` — telemetry, sent at the configured rate (default 2 Hz)

```json
{"t": "tel", "seq": 42, "ms": 20500, "temp": 24.61, "temp_raw": 25.08,
 "adc0": 0.4731, "mem": 182304, "led": false}
```

| field      | type           | required | meaning |
|------------|----------------|----------|---------|
| `seq`      | integer        | yes | increments by 1 per `tel`; a gap means lost lines, a drop means the board restarted |
| `ms`       | integer        | yes | milliseconds since the firmware started; keeps increasing past the ~6.2-day `ticks_ms()` wrap (accumulated in a Python int) |
| `temp`     | number \| null | yes | internal sensor, °C, moving average over `window` samples; `null` if the raw reading is implausible (see below) |
| `temp_raw` | number \| null | no  | the same reading without smoothing |
| `adc0`     | number \| null | yes | GP26 voltage as a fraction of 3.3 V (0..1), smoothed; `null` when nothing is wired |
| `mem`      | integer        | no  | `gc.mem_free()` in bytes |
| `led`      | boolean        | no  | onboard LED state |

**Temperature conversion** (RP2040 datasheet, section 4.9.5), with the 16-bit
`read_u16()` value of ADC channel 4:

```
V    = raw * 3.3 / 65535
temp = 27 - (V - 0.706) / 0.001721
```

`raw` is the mean of 16 consecutive reads (`TEMP_OVERSAMPLE`), which lowers
ADC noise. The sensor measures the die, not the room: it reads above room
temperature, and its absolute error is a few °C (see the README's
"Temperature accuracy"); hence "good for trends, not a thermometer".
Raw values below 5000 (≈0.25 V) are reported as `null`: a real sensor sits
around 0.7 V, and the Wokwi simulator always returns 0.

**ADC0** depends on `ADC0_MODE` in `main.py`: `"off"` (default) always sends
`null`, `"on"` always reads GP26. `"auto"` is opt-in: every 3 s it switches
the GP26 pad's pull-up and then pull-down on for 2 ms each (by writing the
RP2040 pad register and restoring it, no objects allocated) and compares the
readings. A floating pin follows the pull (large difference); a potentiometer
or divider holds its voltage (small difference). This is a heuristic that has
not been verified on hardware yet.

### `hb` — heartbeat, every 5 s

```json
{"t": "hb", "ms": 50000, "seq": 101}
```

Proves the main loop is alive even at very low telemetry rates. The firmware
also runs `gc.collect()` at each heartbeat (visible as a jump in `mem`).

If the loop stalls (for example a long blocking write), the next `tel` and
`hb` are sent once and the schedule restarts from there — no burst of
catch-up messages.

### `ack` — a command succeeded

```json
{"t": "ack", "cmd": "rate", "hz": 10.0}
```

`cmd` is the command name; other fields echo the applied values.

### `err` — a command failed

```json
{"t": "err", "msg": "hz out of range 0.2..20", "cmd": "rate"}
```

`msg` is human-readable. `cmd` is present when the command name was readable.
Possible `msg` values in v1: `bad json`, `missing cmd`, `cmd must be a string`,
`unknown cmd`, `on must be true or false`, `hz must be a number`,
`hz out of range 0.2..20`, `n must be an integer 1..20`, `line too long`
(> 256 chars).

The firmware also uses `err` (without `cmd`) for unexpected exceptions in its
main loop, which it survives instead of dropping to the REPL:

```json
{"t": "err", "msg": "internal error: OSError: [Errno 5] EIO (+12 suppressed)"}
```

These are rate-limited to one per second; `(+N suppressed)` counts the ones
that were not sent in between.

## Host → device (commands)

One JSON object per line with a `cmd` field (a string). The firmware reads
stdin without blocking (`uselect.poll`), so commands are handled between
samples. Field types are checked strictly: `"on": "false"` or `"hz": "5"`
(strings) and `"n": true` are rejected with an `err`, not coerced.

| command | example | effect | reply |
|---------|---------|--------|-------|
| `led`   | `{"cmd":"led","on":true}` | set the onboard LED; `on` must be a boolean (omit it to toggle); cancels a blink | `ack` with `on`, or `err` |
| `blink` | `{"cmd":"blink","n":3}` | blink `n` times (integer 1–20, default 3), 120 ms per step, without blocking, then restore the LED state | `ack` with `n`, or `err` |
| `rate`  | `{"cmd":"rate","hz":10}` | telemetry rate, a number 0.2–20 Hz; the next sample is sent right away and the schedule restarts from there | `ack` with `hz`, or `err` |
| `info`  | `{"cmd":"info"}` | re-send `hello` | `hello` |
| `ping`  | `{"cmd":"ping"}` | round-trip check | `ack` with the device's uptime `ms` |
| `reset_stats` | `{"cmd":"reset_stats"}` | clear the moving averages | `ack` |

## Flow control

Each message is written with a single `write()` call. On current MicroPython
rp2 builds, output is dropped while no host has the port open (DTR not
asserted); if a host has it open but does not read, a write waits up to
~500 ms for buffer space and then drops the rest. The firmware keeps running
either way; a truncated line is reported and skipped by the dashboard's
parser. The dashboard opens the port with a 64 KiB read buffer and, after a
non-fatal read error (e.g. a buffer overrun), reopens the reader instead of
disconnecting.

## Rate limits

At 20 Hz a `tel` line is ~130 bytes, i.e. ~2.6 KB/s — far below what USB full
speed CDC carries. The 20 Hz cap is a design choice: chip temperature changes
over seconds, not milliseconds, so faster sampling mostly adds noise and load
on the browser.
