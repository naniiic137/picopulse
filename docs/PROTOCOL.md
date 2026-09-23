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
{"t": "hello", "v": 1, "fw": "0.1.0", "board": "pico", "uid": "e6605838832a4f21",
 "mpy": "3.4.0; MicroPython v1.22.0 on 2023-12-27", "hz": 2, "adc0": "auto", "window": 8}
```

| field    | type   | required | meaning |
|----------|--------|----------|---------|
| `v`      | number | yes | protocol version |
| `fw`     | string | yes | firmware version |
| `board`  | string | yes | `"pico"`, `"pico-w"` (from `sys.implementation._machine`), or `"simulator"` |
| `uid`    | string | yes | `machine.unique_id()` as hex (flash chip ID) |
| `hz`     | number | yes | current telemetry rate |
| `mpy`    | string | no  | `sys.version` |
| `adc0`   | string | no  | ADC0 mode: `"auto"`, `"on"` or `"off"` |
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
| `ms`       | integer        | yes | milliseconds since the firmware started |
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

The sensor measures the chip itself, so it reads a few degrees above room
temperature and is noisy (±1 °C sample-to-sample is normal); hence the moving
average. Raw values below 5000 (≈0.25 V) are reported as `null`: a real
sensor sits around 0.7 V, and the Wokwi simulator always returns 0.

**ADC0 "not connected"**: in `auto` mode the firmware re-checks every 3 s by
reading GP26 once with the internal pull-up and once with the pull-down. A
floating pin follows the pull (large difference); a potentiometer or divider
holds its voltage (small difference). This is a heuristic — see the README's
hardware-testing notes.

### `hb` — heartbeat, every 5 s

```json
{"t": "hb", "ms": 50000, "seq": 101}
```

Proves the main loop is alive even at very low telemetry rates. The firmware
also runs `gc.collect()` at each heartbeat (visible as a jump in `mem`).

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
Possible `msg` values in v1: `bad json`, `missing cmd`, `unknown cmd`,
`hz must be a number`, `hz out of range 0.2..20`, `line too long` (> 256 chars).

## Host → device (commands)

One JSON object per line with a `cmd` field. The firmware reads stdin without
blocking (`uselect.poll`), so commands are handled between samples.

| command | example | effect | reply |
|---------|---------|--------|-------|
| `led`   | `{"cmd":"led","on":true}` | set the onboard LED (omit `on` to toggle); cancels a blink | `ack` with `on` |
| `blink` | `{"cmd":"blink","n":3}` | blink `n` times (1–20, default 3), 120 ms per step, without blocking, then restore the LED state | `ack` with `n` |
| `rate`  | `{"cmd":"rate","hz":10}` | telemetry rate, 0.2–20 Hz | `ack` with `hz`, or `err` |
| `info`  | `{"cmd":"info"}` | re-send `hello` | `hello` |
| `ping`  | `{"cmd":"ping"}` | round-trip check | `ack` with the device's `ms` |
| `reset_stats` | `{"cmd":"reset_stats"}` | clear the moving averages | `ack` |

## Rate limits

At 20 Hz a `tel` line is ~130 bytes, i.e. ~2.6 KB/s — far below what USB full
speed CDC carries. The 20 Hz cap is a design choice: chip temperature changes
over seconds, not milliseconds, so faster sampling mostly adds noise and load
on the browser.
