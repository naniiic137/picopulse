"""
PicoPulse firmware - live telemetry from a Raspberry Pi Pico over USB serial.

Target : Raspberry Pi Pico / Pico W running MicroPython (v1.20 or newer).
Output : newline-delimited JSON on USB serial (stdout), see docs/PROTOCOL.md.
Input  : newline-delimited JSON commands on USB serial (stdin), read
         without blocking via uselect.poll.

Copy this file to the board as `main.py` (Thonny or `mpremote cp`) and it
starts streaming on boot. Press Ctrl+C in a serial terminal to stop it and
get the REPL back.

Hardware:
  * Nothing extra is required: the RP2040 internal temperature sensor
    (ADC channel 4) and the onboard LED are used.
  * Optional: a potentiometer or an LDR voltage divider on GP26 / ADC0
    (see docs/wiring.svg). When nothing is wired, `adc0` is reported as null.
"""

import sys
import gc
import json
import time
import machine
import uselect

# ---------------------------------------------------------------- config ---
FW_VERSION = "0.1.0"
PROTOCOL_VERSION = 1

DEFAULT_HZ = 2           # telemetry messages per second
MIN_HZ = 0.2
MAX_HZ = 20
SMOOTHING_WINDOW = 8     # moving-average window for temperature and ADC0
HEARTBEAT_MS = 5000      # "hb" message period
ADC0_MODE = "auto"       # "auto" = probe for a connected sensor, "on", "off"
ADC0_PROBE_MS = 3000     # how often "auto" re-checks whether ADC0 is wired
MAX_CMD_LEN = 256        # longer input lines are discarded

# RP2040 datasheet, section 4.9.5: T = 27 - (V_be - 0.706) / 0.001721
ADC_VREF = 3.3
CONVERSION = ADC_VREF / 65535
TEMP_RAW_MIN = 5000      # ~0.25 V; anything lower is not a real sensor reading


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
    """Write one protocol message as a single JSON line."""
    sys.stdout.write(json.dumps(obj))
    sys.stdout.write("\n")


def board_name():
    machine_str = getattr(sys.implementation, "_machine", "")
    return "pico-w" if "Pico W" in machine_str else "pico"


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
adc0_connected = ADC0_MODE == "on"
cmd_buf = ""
cmd_overflow = False

poller = uselect.poll()
poller.register(sys.stdin, uselect.POLLIN)


# --------------------------------------------------------------- sensors ---
def read_temp_c():
    """Internal sensor in deg C, or None if the reading is implausible.

    The sensor sits around 0.7 V, so a raw value near 0 means there is no
    real sensor behind channel 4 - which is what the Wokwi simulator does
    (it always returns 0, which the formula would turn into ~437 deg C).
    """
    raw = temp_adc.read_u16()
    if raw < TEMP_RAW_MIN:
        return None
    volts = raw * CONVERSION
    return 27 - (volts - 0.706) / 0.001721


def probe_adc0():
    """Best-effort check whether something drives GP26.

    A floating pin follows the internal pull resistor (~50 kOhm), so reading
    it with the pull-up and then the pull-down gives two very different
    values. A potentiometer or LDR divider (a few kOhm to tens of kOhm) holds
    the voltage, so the two reads stay close. The ADC keeps sampling the pad
    while the pulls are switched; the ADC object is re-created afterwards to
    restore the analog configuration (it disables the pulls again).
    """
    global adc0
    try:
        pin = machine.Pin(26, machine.Pin.IN, machine.Pin.PULL_UP)
        time.sleep_ms(2)
        high = adc0.read_u16()
        pin.init(machine.Pin.IN, machine.Pin.PULL_DOWN)
        time.sleep_ms(2)
        low = adc0.read_u16()
        adc0 = machine.ADC(26)
        return (high - low) < 20000
    except Exception:
        adc0 = machine.ADC(26)
        return True


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
        "adc0": ADC0_MODE,
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


# -------------------------------------------------------------- commands ---
def handle_command(line):
    global hz, period_ms, led_on, blink_left, blink_next
    try:
        msg = json.loads(line)
    except ValueError:
        send_err("bad json")
        return
    if not isinstance(msg, dict) or "cmd" not in msg:
        send_err("missing cmd")
        return

    cmd = msg["cmd"]
    if cmd == "led":
        led_on = bool(msg.get("on", not led_on))
        blink_left = 0
        led.value(1 if led_on else 0)
        send_ack("led", on=led_on)
    elif cmd == "rate":
        try:
            new_hz = float(msg.get("hz"))
        except (TypeError, ValueError):
            send_err("hz must be a number", cmd)
            return
        if new_hz < MIN_HZ or new_hz > MAX_HZ:
            send_err("hz out of range {}..{}".format(MIN_HZ, MAX_HZ), cmd)
            return
        hz = new_hz
        period_ms = int(1000 / hz)
        send_ack("rate", hz=hz)
    elif cmd == "blink":
        n = msg.get("n", 3)
        if not isinstance(n, int) or n < 1 or n > 20:
            n = 3
        blink_left = n * 2
        blink_next = time.ticks_ms()
        send_ack("blink", n=n)
    elif cmd == "info":
        send_hello()
    elif cmd == "ping":
        send_ack("ping", ms=time.ticks_ms())
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


def main():
    global seq, adc0_connected
    send_hello()
    start = time.ticks_ms()
    next_sample = start
    next_hb = time.ticks_add(start, HEARTBEAT_MS)
    next_probe = start

    while True:
        now = time.ticks_ms()
        poll_stdin()
        update_led(now)

        if ADC0_MODE == "auto" and time.ticks_diff(now, next_probe) >= 0:
            was = adc0_connected
            adc0_connected = probe_adc0()
            if adc0_connected != was:
                adc0_avg.reset()
            next_probe = time.ticks_add(now, ADC0_PROBE_MS)

        if time.ticks_diff(now, next_sample) >= 0:
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
                "ms": time.ticks_diff(now, start),
                "temp": temp,
                "temp_raw": raw_temp,
                "adc0": None if value is None else round(value, 4),
                "mem": gc.mem_free(),
                "led": led.value() == 1,
            })
            next_sample = time.ticks_add(next_sample, period_ms)
            # If we fell behind (e.g. after a rate change), resync instead of
            # bursting to catch up.
            if time.ticks_diff(now, next_sample) > period_ms:
                next_sample = time.ticks_add(now, period_ms)

        if time.ticks_diff(now, next_hb) >= 0:
            gc.collect()
            send({"t": "hb", "ms": time.ticks_diff(now, start), "seq": seq})
            next_hb = time.ticks_add(next_hb, HEARTBEAT_MS)

        time.sleep_ms(2)


# MicroPython runs main.py as __main__; the guard lets the host-side tests
# (firmware/tests) import this module with stubbed hardware.
if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        led.value(0)
