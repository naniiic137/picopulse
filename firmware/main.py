"""
PicoPulse firmware - live telemetry from a Raspberry Pi Pico over USB serial.

Target : Raspberry Pi Pico / Pico W running MicroPython (v1.20 or newer).
Output : newline-delimited JSON on USB serial (stdout), see docs/PROTOCOL.md.
Input  : newline-delimited JSON commands on USB serial (stdin), read
         without blocking via uselect.poll.

Copy this file to the board as `main.py` (Thonny or `mpremote cp`) and it
starts streaming on boot. Press Ctrl+C in a serial terminal to stop it and
get the REPL back (unless the watchdog is enabled, see WATCHDOG_MS).

Hardware:
  * Nothing extra is required: the RP2040 internal temperature sensor
    (ADC channel 4) and the onboard LED are used.
  * Optional: a potentiometer or an LDR voltage divider on GP26 / ADC0
    (see docs/wiring.svg). Set ADC0_MODE below to "on" once it is wired;
    with the default "off", `adc0` is reported as null.

Robustness:
  * Any exception inside the main loop (OSError, MemoryError, a bug) is
    reported as an `err` message - at most one per ERR_MIN_INTERVAL_MS, with
    a count of the ones that were suppressed - and the loop keeps running.
    Only Ctrl+C (KeyboardInterrupt) stops it.
  * Uptime is accumulated from wrap-safe ticks_diff() deltas in a Python int,
    so `ms` keeps counting up past the ~6.2 day ticks_ms() wrap-around.
"""

import sys
import gc
import json
import time
import machine
import uselect

# ---------------------------------------------------------------- config ---
FW_VERSION = "0.2.0"
PROTOCOL_VERSION = 1

DEFAULT_HZ = 2           # telemetry messages per second
MIN_HZ = 0.2
MAX_HZ = 20
SMOOTHING_WINDOW = 8     # moving-average window for temperature and ADC0
HEARTBEAT_MS = 5000      # "hb" message period
MAX_CMD_LEN = 256        # longer input lines are discarded

# GP26 / ADC0:
#   "off"  - not read, `adc0` is always null (default: nothing is wired).
#   "on"   - always read. Use this when a potentiometer / LDR divider is wired.
#   "auto" - opt-in heuristic: every ADC0_PROBE_MS briefly switch the pad's
#            pull-up / pull-down on to guess whether something drives the pin
#            (RP2040 only; falls back to "on" on other chips). Not verified
#            on hardware yet - prefer "on" / "off".
ADC0_MODE = "off"
ADC0_PROBE_MS = 3000

# Internal temperature sensor.
TEMP_OVERSAMPLE = 16     # ADC reads averaged per sample (1 = no oversampling)
TEMP_OFFSET_C = 0.0      # add a calibration offset measured against a thermometer

# Hardware watchdog: 0 = off (default). 1..8388 ms enables machine.WDT, which
# resets the board if the loop stalls for that long. Once started it cannot
# be stopped: after Ctrl+C the board resets within this time, which makes
# the REPL (Thonny, mpremote) hard to use. Enable it only for unattended runs
# and keep it >= 2000 ms (a USB write can block for a while, see send()).
WATCHDOG_MS = 0
WATCHDOG_MAX_MS = 8388   # RP2040 hardware limit

ERR_MIN_INTERVAL_MS = 1000   # at most one internal-error report per second
LOOP_SLEEP_MS = 2

# RP2040 datasheet, section 4.9.5: T = 27 - (V_be - 0.706) / 0.001721
ADC_VREF = 3.3
CONVERSION = ADC_VREF / 65535
TEMP_RAW_MIN = 5000      # ~0.25 V; anything lower is not a real sensor reading

# RP2040 pad control register of GPIO26 (PADS_BANK0 base 0x4001c000,
# GPIOn at 0x04 + 4 * n) and its pull-down / pull-up enable bits.
PAD_GPIO26 = 0x4001C06C
PAD_PDE = 0x04
PAD_PUE = 0x08
PAD_PULLS = PAD_PDE | PAD_PUE
ADC0_FLOAT_DELTA = 20000  # pull-up vs pull-down difference that means "floating"


# --------------------------------------------------------------- helpers ---
class MovingAverage:
    """Fixed-size moving average without allocating on every sample."""

    def __init__(self, size):
        self.size = size
        self.buf = [0.0] * size
        self.count = 0
        self.index = 0
        self.total = 0.0

    def add(self, value):
        if self.count < self.size:
            self.count += 1
        else:
            self.total -= self.buf[self.index]
        self.buf[self.index] = value
        self.total += value
        self.index = (self.index + 1) % self.size
        return self.total / self.count

    def reset(self):
        self.count = 0
        self.index = 0
        self.total = 0.0


def send(obj):
    """Write one protocol message as a single JSON line, in one write call.

    One write per message keeps a line in one piece as far as MicroPython is
    concerned. What happens when the host is not reading depends on the
    MicroPython version; on current rp2 builds:
      * no host has the port open (DTR not asserted): the output is dropped;
      * a host has the port open but does not read: the write waits for room
        in the USB buffer for up to ~500 ms, then drops the rest. The loop
        slows down but does not stop, and a truncated line is simply reported
        as a bad line by the dashboard's parser.
    """
    sys.stdout.write(json.dumps(obj) + "\n")


def is_number(x):
    # bool is a subclass of int in both CPython and MicroPython.
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def board_name():
    machine_str = getattr(sys.implementation, "_machine", "")
    return "pico-w" if "Pico W" in machine_str else "pico"


def is_rp2040():
    return "RP2040" in getattr(sys.implementation, "_machine", "")


def unique_id():
    try:
        return "".join("{:02x}".format(b) for b in machine.unique_id())
    except Exception:
        return "unknown"


def make_led():
    # Pico W: the LED hangs off the CYW43 chip and is only reachable as "LED".
    # Pico: GP25. Recent MicroPython also maps "LED" to GP25 on the plain Pico,
    # but older builds do not, hence the fallback.
    try:
        return machine.Pin("LED", machine.Pin.OUT)
    except (TypeError, ValueError):
        return machine.Pin(25, machine.Pin.OUT)


def resolve_adc0_mode(mode):
    if mode not in ("on", "off", "auto"):
        return "off"
    if mode == "auto" and not is_rp2040():
        return "on"
    return mode


# ----------------------------------------------------------------- state ---
temp_adc = machine.ADC(4)
adc0 = machine.ADC(26)
led = make_led()
led.value(0)

temp_avg = MovingAverage(SMOOTHING_WINDOW)
adc0_avg = MovingAverage(SMOOTHING_WINDOW)

hz = DEFAULT_HZ
period_ms = int(1000 / hz)
seq = 0
led_on = False           # the state the user asked for
blink_left = 0           # remaining LED toggles of a "blink" command
blink_next = 0
adc0_mode = resolve_adc0_mode(ADC0_MODE)
adc0_connected = adc0_mode == "on"
cmd_buf = ""
cmd_overflow = False

# Scheduler (all deadlines are ticks_ms() values, compared with ticks_diff).
last_ticks = 0
uptime_ms = 0            # Python int, never wraps
next_sample = 0
next_hb = 0
next_probe = 0

# Internal-error reporting.
err_last = None
err_suppressed = 0

poller = uselect.poll()
poller.register(sys.stdin, uselect.POLLIN)


# --------------------------------------------------------------- sensors ---
def read_temp_c():
    """Internal sensor in deg C, or None if the reading is implausible.

    TEMP_OVERSAMPLE raw reads are averaged, which lowers the ADC noise (it
    does not fix the sensor's absolute error, see the README).

    The sensor sits around 0.7 V, so a raw value near 0 means there is no
    real sensor behind channel 4 - which is what the Wokwi simulator does
    (it always returns 0, which the formula would turn into ~437 deg C).
    """
    total = 0
    for _ in range(TEMP_OVERSAMPLE):
        total += temp_adc.read_u16()
    raw = total / TEMP_OVERSAMPLE
    if raw < TEMP_RAW_MIN:
        return None
    volts = raw * CONVERSION
    return 27 - (volts - 0.706) / 0.001721 + TEMP_OFFSET_C


def probe_adc0():
    """Best-effort check whether something drives GP26 ("auto" mode only).

    A floating pin follows the internal pull resistor (~50 kOhm), so reading
    it with the pull-up and then the pull-down gives two very different
    values. A potentiometer or LDR divider (a few kOhm to tens of kOhm) holds
    the voltage, so the two reads stay close.

    The pulls are switched by writing the pad register directly and the
    original value is restored afterwards, so the pin stays in ADC mode and
    no Pin / ADC objects are created on each probe.
    """
    mem = machine.mem32
    pad = mem[PAD_GPIO26]
    base = pad & ~PAD_PULLS
    try:
        mem[PAD_GPIO26] = base | PAD_PUE
        time.sleep_ms(2)
        high = adc0.read_u16()
        mem[PAD_GPIO26] = base | PAD_PDE
        time.sleep_ms(2)
        low = adc0.read_u16()
    finally:
        mem[PAD_GPIO26] = pad
    return (high - low) < ADC0_FLOAT_DELTA


def read_adc0():
    """Return ADC0 as a smoothed 0..1 fraction, or None when not wired."""
    if not adc0_connected:
        return None
    return adc0_avg.add(adc0.read_u16() / 65535)


# -------------------------------------------------------------- messages ---
def send_hello():
    send({
        "t": "hello",
        "v": PROTOCOL_VERSION,
        "fw": FW_VERSION,
        "board": board_name(),
        "uid": unique_id(),
        "mpy": sys.version,
        "hz": hz,
        "adc0": adc0_mode,
        "window": SMOOTHING_WINDOW,
    })


def send_ack(cmd, **extra):
    msg = {"t": "ack", "cmd": cmd}
    msg.update(extra)
    send(msg)


def send_err(msg, cmd=None):
    out = {"t": "err", "msg": msg}
    if cmd is not None:
        out["cmd"] = cmd
    send(out)


def report_exception(exc):
    """Report an unexpected exception as an `err` line, rate-limited.

    Timing uses uptime_ms (a plain int), so the limit keeps working however
    long the board has been quiet."""
    global err_last, err_suppressed
    if isinstance(exc, MemoryError):
        gc.collect()
    if err_last is not None and uptime_ms - err_last < ERR_MIN_INTERVAL_MS:
        err_suppressed += 1
        return
    err_last = uptime_ms
    try:
        text = "internal error: {}: {}".format(type(exc).__name__, exc)
        if err_suppressed:
            text += " (+{} suppressed)".format(err_suppressed)
        err_suppressed = 0
        send_err(text[:160])
    except Exception:
        # Reporting failed too (e.g. out of memory): stay quiet, keep running.
        pass


# -------------------------------------------------------------- commands ---
def handle_command(line):
    global hz, period_ms, led_on, blink_left, blink_next, next_sample
    try:
        msg = json.loads(line)
    except ValueError:
        send_err("bad json")
        return
    if not isinstance(msg, dict) or "cmd" not in msg:
        send_err("missing cmd")
        return

    cmd = msg["cmd"]
    if not isinstance(cmd, str):
        send_err("cmd must be a string")
        return

    if cmd == "led":
        on = msg.get("on")
        if on is None:
            on = not led_on
        elif not isinstance(on, bool):
            send_err("on must be true or false", cmd)
            return
        led_on = on
        blink_left = 0
        led.value(1 if led_on else 0)
        send_ack("led", on=led_on)
    elif cmd == "rate":
        new_hz = msg.get("hz")
        if not is_number(new_hz):
            send_err("hz must be a number", cmd)
            return
        new_hz = float(new_hz)
        if not (MIN_HZ <= new_hz <= MAX_HZ):  # also rejects NaN
            send_err("hz out of range {}..{}".format(MIN_HZ, MAX_HZ), cmd)
            return
        hz = new_hz
        period_ms = int(1000 / hz)
        # Restart the schedule: without this, going from 0.2 Hz to 20 Hz
        # would stay silent until the old 5 s deadline.
        next_sample = time.ticks_ms()
        send_ack("rate", hz=hz)
    elif cmd == "blink":
        n = msg.get("n", 3)
        if not isinstance(n, int) or isinstance(n, bool) or n < 1 or n > 20:
            send_err("n must be an integer 1..20", cmd)
            return
        blink_left = n * 2
        blink_next = time.ticks_ms()
        send_ack("blink", n=n)
    elif cmd == "info":
        send_hello()
    elif cmd == "ping":
        send_ack("ping", ms=uptime_ms)
    elif cmd == "reset_stats":
        temp_avg.reset()
        adc0_avg.reset()
        send_ack("reset_stats")
    else:
        send_err("unknown cmd", cmd)


def poll_stdin():
    """Drain whatever is waiting on stdin without blocking."""
    global cmd_buf, cmd_overflow
    while poller.poll(0):
        ch = sys.stdin.read(1)
        if not ch:
            return
        if ch == "\n" or ch == "\r":
            line = cmd_buf.strip()
            cmd_buf = ""
            if cmd_overflow:
                cmd_overflow = False
                send_err("line too long")
            elif line:
                handle_command(line)
        elif not cmd_overflow:
            cmd_buf += ch
            if len(cmd_buf) > MAX_CMD_LEN:
                cmd_buf = ""
                cmd_overflow = True


# --------------------------------------------------------------- the loop ---
def update_led(now):
    global blink_left, blink_next
    if blink_left > 0:
        if time.ticks_diff(now, blink_next) >= 0:
            led.toggle()
            blink_left -= 1
            blink_next = time.ticks_add(now, 120)
            if blink_left == 0:
                led.value(1 if led_on else 0)


def next_deadline(deadline, period, now):
    """The deadline after `deadline`; resyncs to `now` if we fell behind,
    so a stall (or a long blocking write) does not cause a burst."""
    deadline = time.ticks_add(deadline, period)
    if time.ticks_diff(now, deadline) > period:
        deadline = time.ticks_add(now, period)
    return deadline


def init_schedule(now):
    global last_ticks, uptime_ms, next_sample, next_hb, next_probe
    last_ticks = now
    uptime_ms = 0
    next_sample = now
    next_hb = time.ticks_add(now, HEARTBEAT_MS)
    next_probe = now


def advance_clock(now):
    """Accumulate uptime from a wrap-safe delta (called every loop pass,
    so the delta is tiny compared with the ~6.2 day ticks_diff limit)."""
    global last_ticks, uptime_ms
    uptime_ms += time.ticks_diff(now, last_ticks)
    last_ticks = now


def tick(now):
    """One pass of the cooperative loop. Never blocks for long."""
    global seq, adc0_connected, next_sample, next_hb, next_probe
    advance_clock(now)
    poll_stdin()
    update_led(now)

    if adc0_mode == "auto" and time.ticks_diff(now, next_probe) >= 0:
        next_probe = time.ticks_add(now, ADC0_PROBE_MS)
        was = adc0_connected
        adc0_connected = probe_adc0()
        if adc0_connected != was:
            adc0_avg.reset()

    if time.ticks_diff(now, next_sample) >= 0:
        # Advance first: if reading a sensor raises, the next attempt is one
        # period later instead of on every loop pass.
        next_sample = next_deadline(next_sample, period_ms, now)
        raw_temp = read_temp_c()
        value = read_adc0()
        seq += 1
        if raw_temp is None:
            temp = None
        else:
            temp = round(temp_avg.add(raw_temp), 2)
            raw_temp = round(raw_temp, 2)
        send({
            "t": "tel",
            "seq": seq,
            "ms": uptime_ms,
            "temp": temp,
            "temp_raw": raw_temp,
            "adc0": None if value is None else round(value, 4),
            "mem": gc.mem_free(),
            "led": led.value() == 1,
        })

    if time.ticks_diff(now, next_hb) >= 0:
        next_hb = next_deadline(next_hb, HEARTBEAT_MS, now)
        gc.collect()
        send({"t": "hb", "ms": uptime_ms, "seq": seq})


def make_watchdog():
    if not WATCHDOG_MS:
        return None
    return machine.WDT(timeout=max(1, min(int(WATCHDOG_MS), WATCHDOG_MAX_MS)))


def main(loops=-1):
    """Run the loop forever (or `loops` passes, for the tests)."""
    wdt = make_watchdog()
    now = time.ticks_ms()
    init_schedule(now)
    try:
        send_hello()
    except Exception as exc:
        report_exception(exc)
    while loops != 0:
        loops -= 1
        now = time.ticks_ms()
        try:
            tick(now)
        except Exception as exc:  # KeyboardInterrupt is not an Exception
            report_exception(exc)
        if wdt is not None:
            wdt.feed()
        time.sleep_ms(LOOP_SLEEP_MS)


# MicroPython runs main.py as __main__; the guard lets the host-side tests
# (firmware/tests) import this module with stubbed hardware.
if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        led.value(0)
