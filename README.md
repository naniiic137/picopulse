# PicoPulse

**Live telemetry from a Raspberry Pi Pico to your browser over USB — no drivers, no server, no app to install.**

A MicroPython firmware streams the RP2040's internal temperature, an optional
analog input, uptime and free memory as newline-delimited JSON over USB serial.
A TypeScript dashboard reads it with the **Web Serial API**, draws live charts,
raises threshold alerts, exports CSV, and sends commands back to the board
(LED, blink, sample rate).

**Live demo:** https://naniiic137.github.io/picopulse/ — it will be available once GitHub Pages is enabled for this repository.
No Pico? Press **Run simulator** to see synthetic data in the same format (clearly labelled as simulated).

![Dashboard in simulator mode: temperature chart with alert line, analog input and free-heap charts, serial monitor, controls and device panel](docs/screenshots/dashboard.png)

| Alert raised, LED on, rate changed to 5 Hz | Mobile layout |
|---|---|
| ![Temperature above the 30 °C threshold, card highlighted in red, event log showing the commands and acknowledgements](docs/screenshots/alerts-controls.png) | <img src="docs/screenshots/mobile.png" alt="Dashboard on a 390 px wide phone screen" width="300"> |

*Screenshots were taken in simulator mode. See [Tested on](#tested-on).*

## What you need

- A **Raspberry Pi Pico** (a Pico W works too) and a **USB data cable**.
- **Chrome or Edge on desktop** (Web Serial is not available in Firefox, Safari or mobile browsers).
- Optional: a 10 kΩ potentiometer (or an LDR plus a 10 kΩ resistor) on GP26 / ADC0.
  If you wire one, set `ADC0_MODE = "on"` at the top of `firmware/main.py`
  (the default `"off"` reports `adc0` as `null`).

Nothing else is needed: the temperature sensor and the LED are on the board.

![Wiring: potentiometer outer legs to 3V3 (pin 36) and AGND (pin 33), wiper to GP26 (pin 31)](docs/wiring.svg)

## Quick start

### 1. Flash MicroPython (once)

1. Download the `.uf2` for your board from micropython.org:
   [Pico](https://micropython.org/download/RPI_PICO/) or [Pico W](https://micropython.org/download/RPI_PICO_W/).
2. Hold **BOOTSEL**, plug the Pico in, release. A drive called `RPI-RP2` appears.
3. Copy the `.uf2` onto it. The board reboots into MicroPython.

### 2. Copy the firmware

With **Thonny**: *Tools → Options → Interpreter → MicroPython (Raspberry Pi Pico)*,
open `firmware/main.py`, then *File → Save as… → Raspberry Pi Pico* and save it as `main.py`.

Or with **mpremote**:

```bash
pip install mpremote
mpremote cp firmware/main.py :main.py
mpremote reset
```

`main.py` runs on every boot. **Close Thonny / mpremote afterwards**: only one
program can hold the serial port at a time.

### 3. Open the dashboard

Use the hosted page, or run it locally:

```bash
cd web
npm install
npm run dev          # http://localhost:5183
```

Press **Connect Pico** and pick the Pico in the browser's port list (it is
filtered on Raspberry Pi's USB vendor ID, `2e8a`).

## Try it without a board

- **In the browser:** press **Run simulator** (or open `?sim`). A small model of the
  Pico produces the same JSON lines, chopped into random chunks like real USB reads,
  and they go through the same parser and validator as serial data.
- **On Wokwi:** the firmware itself runs in the [Wokwi](https://wokwi.com) simulator
  with a potentiometer on GP26:
  1. Open the [MicroPython Pi Pico template](https://wokwi.com/projects/new/micropython-pi-pico).
  2. Replace `main.py` with [`firmware/main.py`](firmware/main.py) and `diagram.json`
     with [`firmware/diagram.json`](firmware/diagram.json).
  3. Set `ADC0_MODE = "on"` in `main.py`, then start the simulation. The JSON lines
     appear in the serial monitor; you can type commands such as `{"cmd":"rate","hz":5}`
     there. Turn the potentiometer to change `adc0`.

  Wokwi's temperature sensor always reads 0, so `temp` is reported as `null` there (the
  firmware rejects impossible readings rather than showing 437 °C). The browser
  dashboard cannot connect to Wokwi; use its serial monitor.
  If Wokwi rejects the MicroPython version pinned in `diagram.json`'s `env`
  attribute, keep the template's Pico part and copy only the potentiometer and the
  three connections.

  For **Wokwi for VS Code**, [`firmware/wokwi.toml`](firmware/wokwi.toml) explains the steps
  (download the MicroPython `.uf2` next to it, start the simulator, then
  `python -m mpremote connect port:rfc2217://localhost:4000 run main.py`).

## How it works

```mermaid
flowchart LR
  subgraph Pico["Raspberry Pi Pico (MicroPython)"]
    S["ADC4 temp sensor<br/>ADC0 / GP26<br/>gc.mem_free()"] --> L["main loop<br/>moving average<br/>scheduler"]
    L -- "print JSON line" --> O[(USB CDC stdout)]
    I[(USB CDC stdin)] -- "uselect.poll, no blocking" --> C["command handler<br/>LED, blink, rate"]
    C --> L
  end
  O -- "text chunks" --> R
  subgraph Browser["Browser (TypeScript, no framework)"]
    R["Web Serial reader<br/>TextDecoderStream"] --> P["LineParser<br/>partial chunks, CRLF,<br/>overlong lines"]
    SIM["Simulator<br/>same protocol"] -. "random chunks" .-> P
    P --> V["validateMessage<br/>schema + version"]
    V --> ST["Series ring buffers<br/>min / avg / max<br/>threshold alert"]
    ST --> UI["canvas charts, redrawn on new data (max 30 fps)<br/>event log, CSV export"]
    UI -- "encodeCommand" --> W["writer"]
  end
  W --> I
```

- **Firmware** ([`firmware/main.py`](firmware/main.py)): a single cooperative loop that
  never blocks. Each pass drains stdin with `uselect.poll(0)`, advances the LED blink
  state machine, and sends a sample when the next `ticks_ms` deadline has passed
  (a `rate` command restarts that schedule, so 0.2 Hz → 20 Hz takes effect at once).
  Temperature uses the datasheet formula `27 − (V − 0.706) / 0.001721` on the mean of
  16 ADC reads, then an 8-sample moving average. The LED works on both boards
  (`Pin("LED")`, falling back to `Pin(25)`).
- **Staying up:** any exception in the loop (an `OSError`, a `MemoryError`, a bug) is
  sent as an `err` line — at most one per second, with a count of the suppressed
  ones — and the loop carries on; only Ctrl+C stops it. Uptime (`ms`) is summed
  from wrap-safe `ticks_diff` steps into a Python int, so it does not go negative
  after ~6.2 days. Each message is one `write()`; see
  [PROTOCOL.md → Flow control](docs/PROTOCOL.md#flow-control) for what happens when
  nobody reads the port.
- **Optional watchdog:** set `WATCHDOG_MS` (e.g. `4000`, max 8388) in `main.py` to
  enable `machine.WDT`, which resets the board if the loop hangs. It is off by
  default because it cannot be stopped once started: after Ctrl+C the board resets
  within that time, which gets in the way of Thonny / mpremote. Use it for
  unattended runs only.
- **Protocol** ([`docs/PROTOCOL.md`](docs/PROTOCOL.md)): `hello`, `tel`, `hb`, `ack`,
  `err` messages from the device; `led`, `blink`, `rate`, `info`, `ping`, `reset_stats`
  commands to it. Versioned through the `hello` message.
- **Dashboard** ([`web/src`](web/src)): the charts are plain `<canvas>` code (~260 lines,
  no chart library). The x axis is "seconds ago". Charts are repainted when new data
  arrives (at most 30 times a second) plus a 2 Hz scroll refresh while streaming, and
  not at all when idle or paused; theme colours are read once, not every frame.
  Memory is bounded: chart history is a fixed ring buffer and the CSV recording keeps
  the last 30 minutes (at most 36,000 rows). Commands go through one writer held for
  the whole connection, so overlapping clicks cannot fail with "stream locked", and a
  non-fatal read error (such as a buffer overrun) reopens the reader instead of
  disconnecting.
- **Accessibility:** the event log and serial monitor are not live regions (they would
  flood a screen reader at 20 Hz). Only threshold alerts and disconnects are announced,
  through one polite status region, at most once every 5 seconds.

## Temperature accuracy

The RP2040's built-in sensor measures the temperature of the **chip's die, not the
room**. The die runs warmer than the air around it (more so when the CPU is busy or
the board sits in a case), so expect readings a few degrees above room temperature.

Absolute accuracy is limited too. The datasheet formula uses typical values
(0.706 V at 27 °C, −1.721 mV/°C) that vary from chip to chip, and the result
depends on the 3.3 V supply the ADC uses as its reference: a 1 % error in that
reference alone moves the reading by about 4 °C. **Treat ±2 °C as the best case,
not a guarantee.**

What helps, and what does not:

- Each sample is the mean of **16 ADC reads** (`TEMP_OVERSAMPLE`), and the value shown
  is an 8-sample moving average. This reduces noise; it does not remove the offset.
- For a better absolute number, compare with a reference thermometer and set
  `TEMP_OFFSET_C` in `main.py`, or use an external sensor.
- The sensor is good at **trends**: warm-up, load changes, a finger on the chip.

## Tests

```bash
cd web && npm test                                  # Vitest: 69 tests
cd web && npm run build                             # type-check (tsc) + production build
python -m unittest discover -s firmware/tests -v    # 28 firmware tests (stubbed hardware)
python -m py_compile firmware/main.py firmware/examples/mqtt_picow.py
```

- **Web (Vitest):** the line parser (chunk boundaries, CRLF, one byte at a time,
  overlong lines), message validation (every message type, bad types, out-of-range
  values, protocol version), statistics and the alert hysteresis, CSV export, tick
  generation, cached chart colours, the simulator (every line it emits passes
  validation, rate changes, strict command validation), the **Web Serial transport**
  against a fake port built on real Web Streams (overlapping sends, recovery from a
  buffer overrun, giving up after repeated errors, unplugging, close / reconnect),
  and the dashboard logic taken out of `main.ts` (bounded CSV buffer, sequence-gap
  counting, the redraw limiter, the screen-reader announcement throttle, uptime
  formatting).
- **Firmware:** CPython cannot import `machine` or `uselect`, so the tests replace them
  with small fakes, including a `ticks_ms()` clock that wraps at 2^30 like
  MicroPython's. They check the moving average, the temperature formula and
  oversampling, command parsing and strict type checks (`"on": "false"` is refused),
  the **scheduler loop** (sample and heartbeat timing, a `rate` change taking effect
  at once, no burst after a stall, uptime staying correct across the wrap over 7
  simulated days), **error survival** (an `OSError` on every pass, or a `MemoryError`
  from a sensor, leaves the loop running and sends rate-limited `err` lines), one
  write per message, the opt-in watchdog and the opt-in ADC0 probe that allocates
  nothing. This checks the logic, not the hardware.

GitHub Actions runs both on every push ([`ci.yml`](.github/workflows/ci.yml)) and deploys
the dashboard to GitHub Pages from `main` ([`pages.yml`](.github/workflows/pages.yml)).

## Tested on

| What | Status |
|---|---|
| Dashboard with the simulator, headless Chrome via Puppeteer (1280 px desktop and 390 px mobile viewports) | Done |
| Web unit tests and production build | Passing |
| Firmware logic on CPython with stubbed hardware | Passing |
| Firmware on a real Raspberry Pi Pico | **Pending.** The owner will test it on his Pico and update this section |
| Firmware on a Pico W | Not tested |
| `examples/mqtt_picow.py` (Pico W, MQTT) | Not tested on hardware |
| Wokwi | Files written against the Wokwi docs; not yet run on wokwi.com |

Things that most need checking on hardware: the ADC0 `"auto"` detection
(a pull-up / pull-down heuristic, opt-in), that output starts as soon as the dashboard
connects, the behaviour when the dashboard stops reading, and the LED on older
MicroPython builds.

### How to test on a real Pico

A checklist for the first hardware run. Write down the board, the MicroPython version
(from the REPL banner) and the date, then update the table above.

1. **Flash and copy:** flash MicroPython, copy `firmware/main.py` as `main.py`, reset.
2. **Raw output:** in Thonny's shell (or `mpremote`), check that a `tel` line arrives
   about every 0.5 s and an `hb` every 5 s. Type `{"cmd":"info"}` and check the `hello`
   line: the right `board`, a real `uid`, `adc0` = `"off"`. Close Thonny afterwards.
3. **Connect:** open the dashboard in Chrome or Edge and press **Connect Pico**. The
   Device panel should fill in, *Rate* should read about 2.0 Hz measured and
   *Last heartbeat* should stay at 5 s or less.
4. **Temperature:** the reading should be a few °C above room temperature. Hold a
   finger on the RP2040 chip: it should rise within seconds and fall afterwards.
   Write down the offset from a reference thermometer.
5. **Controls:** toggle the LED and press Blink. Each should get an `ack` in the event
   log, and the LED on the board should follow.
6. **Rate:** set 0.2 Hz, wait for a sample, then set 20 Hz. Samples should resume
   at once (no 5 s pause) and *Rate* should reach about 20 Hz with 0 lost.
7. **Bad input:** in a serial terminal, send `{"cmd":"led","on":"false"}`. You should get
   an `err`, and the LED should stay as it was.
8. **ADC0 (if wired):** with `ADC0_MODE = "on"`, turning the potentiometer should sweep
   about 0–100 %. Then try `"auto"`: disconnect the wiper, and within about 3 s `adc0`
   should become `null`. Reconnect it, and the values should come back.
9. **Unplug:** pull the USB cable while connected. The dashboard should log
   "Link closed" and stay usable. Plug it back in and connect again.
10. **Nobody reading:** keep the port open in a terminal that is paused (or freeze the
    dashboard's tab) for a minute. When reading resumes, the board should still be
    running and answer commands, and `seq` should have kept counting.
11. **Long run:** leave it streaming for a few hours. `mem` should stay flat on average
    and *Uptime* should keep increasing. A run of more than 6.2 days also checks the
    `ticks_ms` wrap.
12. **Watchdog (optional):** set `WATCHDOG_MS = 4000` and run as above. Ctrl+C in
    Thonny should then reset the board within about 4 s. This is expected.

## Optional: Pico W over MQTT

[`firmware/examples/mqtt_picow.py`](firmware/examples/mqtt_picow.py) is a separate,
minimal example that publishes the same `tel` messages to an MQTT broker over WiFi
using `umqtt.simple`. It is **untested on hardware** and not used by the dashboard.

## Project structure

```
picopulse/
├── firmware/
│   ├── main.py                 # MicroPython firmware (copy to the board as main.py)
│   ├── diagram.json            # Wokwi circuit: Pico + potentiometer on GP26
│   ├── wokwi.toml              # Wokwi for VS Code config
│   ├── examples/mqtt_picow.py  # optional Pico W MQTT example (untested)
│   └── tests/test_main.py      # host-side tests with stubbed hardware
├── web/
│   ├── index.html
│   ├── src/
│   │   ├── main.ts             # UI wiring
│   │   ├── transport.ts        # Web Serial + simulator transports
│   │   ├── session.ts          # CSV row buffer, seq tracking, redraw + announcement throttles
│   │   ├── lineParser.ts       # chunks -> lines
│   │   ├── protocol.ts         # message types, validation, command encoding
│   │   ├── simulator.ts        # fake Pico speaking the same protocol
│   │   ├── stats.ts            # ring buffers, min/avg/max, threshold alert
│   │   ├── chart.ts            # canvas time-series chart
│   │   ├── csv.ts              # CSV export
│   │   └── style.css
│   └── tests/                  # Vitest
├── docs/
│   ├── PROTOCOL.md
│   ├── wiring.svg
│   └── screenshots/
└── .github/workflows/          # CI + GitHub Pages
```

## Tech stack

- **Device:** Raspberry Pi Pico (RP2040), MicroPython (`machine.ADC`, `machine.Pin`, `uselect`, `json`, `gc`)
- **Browser:** TypeScript, Vite, Web Serial API, Canvas 2D, no UI framework, no runtime dependencies
- **Tooling:** Vitest, Python `unittest`, GitHub Actions, GitHub Pages, Wokwi

## Troubleshooting

- **"Connect Pico" is greyed out:** the browser has no Web Serial. Use Chrome or Edge on desktop.
- **"Could not open the port":** Thonny, mpremote or another serial monitor still has it. Close it.
- **The Pico is not in the port list:** check that the cable carries data (some are charge-only) and that MicroPython is flashed.
- **Only text lines, no charts:** `main.py` is not running (e.g. it stopped with an error, shown in the event log). Reset the board.

## Author

Hamza Ben Ismail ([@naniiic137](https://github.com/naniiic137)), Tunisia.

## License

© 2026 Hamza Ben Ismail. All rights reserved.
