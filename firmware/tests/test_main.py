"""Host-side tests for firmware/main.py.

MicroPython-only modules (machine, uselect, time.ticks_*) are replaced by
small fakes so the pure logic - smoothing, the temperature formula, command
handling, the stdin line reader and the scheduler loop - can run under
CPython:

    python -m unittest discover -s firmware/tests

The fake clock wraps like MicroPython's ticks_ms() (period 2**30 ms), so the
tests also cover the wrap-around. These tests do NOT replace testing on a
real Pico.
"""

import gc
import importlib
import io
import json
import os
import sys
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

TICKS_PERIOD = 1 << 30
TICKS_MAX = TICKS_PERIOD - 1
TICKS_HALF = TICKS_PERIOD // 2
DAY_MS = 24 * 3600 * 1000


class FakeClock:
    """Absolute milliseconds; ticks_ms() exposes them modulo 2**30."""

    def __init__(self):
        self.t = 0

    def ticks_ms(self):
        return self.t & TICKS_MAX

    def sleep_ms(self, ms):
        self.t += ms


def ticks_diff(a, b):
    # Same semantics as MicroPython: signed difference in (-2**29, 2**29].
    return ((a - b + TICKS_HALF) & TICKS_MAX) - TICKS_HALF


def ticks_add(a, b):
    return (a + b) & TICKS_MAX


CLOCK = FakeClock()


class FakeADC:
    values = {4: 14000, 26: 32768}
    created = 0
    fail = None  # exception instance raised by read_u16, if set

    def __init__(self, ch):
        FakeADC.created += 1
        self.key = ch

    def read_u16(self):
        if FakeADC.fail is not None:
            raise FakeADC.fail
        if self.key == 26 and FakeMem.probe is not None:
            return FakeMem.probe()
        return FakeADC.values[self.key]


class FakePin:
    OUT, IN, PULL_UP, PULL_DOWN = 1, 0, 1, 2
    created = 0

    def __init__(self, pin_id, mode=None, pull=None):
        FakePin.created += 1
        self.id = pin_id
        self._v = 0

    def init(self, mode=None, pull=None):
        pass

    def value(self, v=None):
        if v is None:
            return self._v
        self._v = 1 if v else 0

    def toggle(self):
        self._v ^= 1


class FakeMem(dict):
    """machine.mem32 stand-in; unknown addresses read as 0."""

    probe = None  # callable returning the GP26 ADC value for the current pad state

    def __missing__(self, key):
        return 0


class FakeWDT:
    instances = []

    def __init__(self, timeout):
        self.timeout = timeout
        self.feeds = 0
        FakeWDT.instances.append(self)

    def feed(self):
        self.feeds += 1


class FakePoll:
    fail = None

    def register(self, *args):
        pass

    def poll(self, timeout):
        if FakePoll.fail is not None:
            raise FakePoll.fail
        stdin = sys.stdin
        if not isinstance(stdin, io.StringIO):
            return False
        return stdin.tell() < len(stdin.getvalue())


def install_fakes():
    machine = types.ModuleType("machine")
    machine.ADC = FakeADC
    machine.Pin = FakePin
    machine.WDT = FakeWDT
    machine.mem32 = FakeMem()
    machine.unique_id = lambda: b"\xe6\x60\x58\x38\x83\x2a\x4f\x21"
    uselect = types.ModuleType("uselect")
    uselect.POLLIN = 1
    uselect.poll = FakePoll
    sys.modules["machine"] = machine
    sys.modules["uselect"] = uselect
    time.ticks_ms = CLOCK.ticks_ms
    time.ticks_diff = ticks_diff
    time.ticks_add = ticks_add
    time.sleep_ms = CLOCK.sleep_ms
    gc.mem_free = lambda: 182304


install_fakes()
fw = importlib.import_module("main")
machine = sys.modules["machine"]


class CountingStdout(io.StringIO):
    def __init__(self):
        super().__init__()
        self.writes = 0

    def write(self, s):
        self.writes += 1
        return super().write(s)


class FirmwareTest(unittest.TestCase):
    def setUp(self):
        self.out = CountingStdout()
        self._stdout, self._stdin = sys.stdout, sys.stdin
        sys.stdout = self.out
        sys.stdin = io.StringIO("")
        # Fresh device state for every test.
        CLOCK.t = 1_000_000
        FakeADC.values = {4: 14000, 26: 32768}
        FakeADC.fail = None
        FakePoll.fail = None
        FakeMem.probe = None
        machine.mem32.clear()
        fw.hz = fw.DEFAULT_HZ
        fw.period_ms = int(1000 / fw.hz)
        fw.seq = 0
        fw.led_on = False
        fw.led.value(0)
        fw.blink_left = 0
        fw.adc0_mode = "off"
        fw.adc0_connected = False
        fw.cmd_buf = ""
        fw.cmd_overflow = False
        fw.err_last = None
        fw.err_suppressed = 0
        fw.WATCHDOG_MS = 0
        fw.temp_avg.reset()
        fw.adc0_avg.reset()
        fw.init_schedule(CLOCK.ticks_ms())

    def tearDown(self):
        sys.stdout, sys.stdin = self._stdout, self._stdin

    def messages(self, t=None):
        msgs = [json.loads(l) for l in self.out.getvalue().splitlines() if l]
        return [m for m in msgs if t is None or m["t"] == t]

    def feed(self, text):
        sys.stdin = io.StringIO(text)
        fw.poll_stdin()

    def run_for(self, ms, step=fw.LOOP_SLEEP_MS):
        """Drive tick() the way main() does, advancing the fake clock."""
        end = CLOCK.t + ms
        while CLOCK.t < end:
            fw.tick(CLOCK.ticks_ms())
            CLOCK.sleep_ms(step)

    # ------------------------------------------------------------ helpers
    def test_moving_average(self):
        avg = fw.MovingAverage(3)
        self.assertEqual(avg.add(3), 3)
        self.assertEqual(avg.add(6), 4.5)
        self.assertEqual(avg.add(9), 6)
        self.assertEqual(avg.add(12), 9)  # window slides: 6, 9, 12

    def test_fake_ticks_wrap_like_micropython(self):
        self.assertEqual(ticks_add(TICKS_MAX, 1), 0)
        self.assertEqual(ticks_diff(5, TICKS_MAX - 4), 10)
        self.assertEqual(ticks_diff(TICKS_MAX - 4, 5), -10)

    # --------------------------------------------------------- temperature
    def test_temperature_formula(self):
        # 0.706 V is 27 deg C by definition of the datasheet formula.
        FakeADC.values[4] = round(0.706 / 3.3 * 65535)
        self.assertAlmostEqual(fw.read_temp_c(), 27, delta=0.1)
        # A lower voltage means a higher temperature (negative slope).
        FakeADC.values[4] = round(0.689 / 3.3 * 65535)
        self.assertAlmostEqual(fw.read_temp_c(), 36.9, delta=0.2)

    def test_temperature_implausible_reading_is_none(self):
        FakeADC.values[4] = 0  # what Wokwi returns
        self.assertIsNone(fw.read_temp_c())

    def test_temperature_oversampling_averages_reads(self):
        seq = iter([14000, 14016] * fw.TEMP_OVERSAMPLE)
        adc = fw.temp_adc
        original = adc.read_u16
        adc.read_u16 = lambda: next(seq)
        try:
            value = fw.read_temp_c()
        finally:
            adc.read_u16 = original
        FakeADC.values[4] = 14008
        self.assertAlmostEqual(value, fw.read_temp_c(), places=9)
        self.assertEqual(fw.TEMP_OVERSAMPLE, 16)

    # ------------------------------------------------------------ commands
    def test_rate_command(self):
        self.feed('{"cmd":"rate","hz":10}\n')
        self.assertEqual(fw.hz, 10)
        self.assertEqual(fw.period_ms, 100)
        self.assertEqual(self.messages()[-1], {"t": "ack", "cmd": "rate", "hz": 10.0})

    def test_rate_out_of_range(self):
        self.feed('{"cmd":"rate","hz":500}\n')
        msg = self.messages()[-1]
        self.assertEqual(msg["t"], "err")
        self.assertEqual(msg["cmd"], "rate")

    def test_rate_rejects_non_numbers(self):
        self.feed('{"cmd":"rate","hz":"5"}\n{"cmd":"rate","hz":true}\n{"cmd":"rate"}\n')
        self.assertEqual([m["msg"] for m in self.messages()], ["hz must be a number"] * 3)
        self.assertEqual(fw.hz, fw.DEFAULT_HZ)

    def test_led_command(self):
        self.feed('{"cmd":"led","on":true}\r\n')
        self.assertEqual(fw.led.value(), 1)
        self.feed('{"cmd":"led","on":false}\n')
        self.assertEqual(fw.led.value(), 0)
        self.feed('{"cmd":"led"}\n')  # no "on": toggle
        self.assertEqual(fw.led.value(), 1)

    def test_led_rejects_string_false(self):
        # bool("false") would be True - the firmware must refuse it instead.
        self.feed('{"cmd":"led","on":"false"}\n{"cmd":"led","on":1}\n')
        self.assertEqual(fw.led.value(), 0)
        self.assertEqual(
            self.messages(),
            [{"t": "err", "msg": "on must be true or false", "cmd": "led"}] * 2,
        )

    def test_blink_schedules_toggles(self):
        self.feed('{"cmd":"blink","n":2}\n')
        self.assertEqual(fw.blink_left, 4)
        now = fw.blink_next
        for i in range(4):
            fw.update_led(ticks_add(now, i * 1000))
        self.assertEqual(fw.blink_left, 0)
        self.assertEqual(fw.led.value(), 1 if fw.led_on else 0)

    def test_blink_validates_n(self):
        self.feed('{"cmd":"blink","n":0}\n{"cmd":"blink","n":"3"}\n{"cmd":"blink","n":2.5}\n{"cmd":"blink","n":true}\n')
        errs = self.messages("err")
        self.assertEqual(len(errs), 4)
        self.assertTrue(all(e["msg"] == "n must be an integer 1..20" for e in errs))
        self.assertEqual(fw.blink_left, 0)
        self.feed('{"cmd":"blink"}\n')
        self.assertEqual(self.messages()[-1], {"t": "ack", "cmd": "blink", "n": 3})

    def test_bad_input(self):
        self.feed('not json\n{"nope":1}\n{"cmd":"selfdestruct"}\n{"cmd":5}\n[1]\n')
        errs = [m["msg"] for m in self.messages()]
        self.assertEqual(errs, ["bad json", "missing cmd", "unknown cmd", "cmd must be a string", "missing cmd"])

    def test_command_split_across_reads(self):
        self.feed('{"cmd":"ra')
        self.assertEqual(self.messages(), [])
        self.feed('te","hz":5}\n')
        self.assertEqual(self.messages()[-1]["hz"], 5.0)

    def test_overlong_line_is_rejected(self):
        self.feed("x" * 400 + "\n" + '{"cmd":"ping"}\n')
        msgs = self.messages()
        self.assertEqual(msgs[0], {"t": "err", "msg": "line too long"})
        self.assertEqual(msgs[1]["cmd"], "ping")

    def test_hello_message(self):
        fw.send_hello()
        hello = self.messages()[-1]
        self.assertEqual(hello["t"], "hello")
        self.assertEqual(hello["v"], 1)
        self.assertEqual(hello["uid"], "e6605838832a4f21")
        self.assertEqual(hello["adc0"], "off")

    def test_one_write_per_message(self):
        fw.send({"t": "hb", "ms": 1, "seq": 2})
        fw.send_hello()
        self.assertEqual(self.out.writes, 2)
        self.assertTrue(self.out.getvalue().endswith("\n"))
        self.assertEqual(len(self.out.getvalue().splitlines()), 2)

    # ----------------------------------------------------------- scheduler
    def test_samples_at_the_configured_rate(self):
        self.run_for(10_001)
        tel = self.messages("tel")
        self.assertEqual(len(tel), 21)  # 2 Hz for 10 s, both ends included
        self.assertEqual([m["seq"] for m in tel], list(range(1, len(tel) + 1)))
        self.assertEqual(len(self.messages("hb")), 2)  # at 5 s and 10 s

    def test_rate_change_resets_the_schedule(self):
        self.feed('{"cmd":"rate","hz":0.2}\n')
        self.run_for(100)  # first sample goes out right away, the next is due in 5 s
        self.assertEqual(len(self.messages("tel")), 1)
        sys.stdin = io.StringIO('{"cmd":"rate","hz":20}\n')
        self.run_for(500)
        tel = self.messages("tel")
        # Without the reset the next sample would only come ~4.9 s later.
        self.assertGreaterEqual(len(tel), 10)
        gaps = [b["ms"] - a["ms"] for a, b in zip(tel[1:], tel[2:])]
        self.assertTrue(all(45 <= g <= 55 for g in gaps), gaps)

    def test_no_burst_after_a_stall(self):
        self.run_for(10)
        CLOCK.sleep_ms(30_000)  # e.g. a long blocking write
        self.run_for(10)
        self.assertEqual(len(self.messages("tel")), 2)
        self.assertEqual(len(self.messages("hb")), 1)

    def test_uptime_survives_ticks_wrap(self):
        # Start 10 s before ticks_ms() wraps and run for 7 days - past both the
        # wrap and the 2**29 ms (~6.2 days) where ticks_diff(now, start) would
        # turn negative.
        CLOCK.t = TICKS_PERIOD - 10_000
        fw.init_schedule(CLOCK.ticks_ms())
        start = CLOCK.t
        for _ in range(7 * 24 * 12):  # every 5 minutes
            CLOCK.sleep_ms(5 * 60 * 1000)
            fw.tick(CLOCK.ticks_ms())
            self.run_for(2)
        fw.advance_clock(CLOCK.ticks_ms())
        tel = self.messages("tel")
        ms = [m["ms"] for m in tel]
        self.assertEqual(ms, sorted(ms))
        self.assertGreaterEqual(min(ms), 0)
        self.assertEqual(fw.uptime_ms, CLOCK.t - start)
        self.assertGreater(ms[-1], 7 * DAY_MS - 1000)
        self.assertGreater(CLOCK.t, TICKS_PERIOD)  # ticks_ms() wrapped
        self.assertEqual(self.messages("hb")[-1]["ms"], ms[-1])

    # ------------------------------------------------------------- errors
    def test_main_survives_exceptions_and_rate_limits_errors(self):
        FakePoll.fail = OSError(5)
        fw.main(loops=1500)  # 1500 passes x 2 ms = 3 s of constant failure
        errs = self.messages("err")
        self.assertTrue(errs[0]["msg"].startswith("internal error: OSError"), errs[0])
        self.assertLessEqual(len(errs), 4)
        self.assertGreaterEqual(len(errs), 3)
        self.assertIn("suppressed", errs[1]["msg"])
        self.assertTrue(all("cmd" not in e for e in errs))
        # The fault clears: telemetry resumes without a restart.
        FakePoll.fail = None
        before = len(self.messages("tel"))
        fw.main(loops=600)
        self.assertGreater(len(self.messages("tel")), before)

    def test_sensor_memory_error_does_not_stop_the_loop(self):
        FakeADC.fail = MemoryError("memory allocation failed")
        fw.main(loops=600)  # ~1.2 s
        errs = self.messages("err")
        self.assertGreaterEqual(len(errs), 1)
        self.assertIn("MemoryError", errs[0]["msg"])
        FakeADC.fail = None
        fw.main(loops=600)
        self.assertGreater(len(self.messages("tel")), 0)

    def test_keyboard_interrupt_still_stops_main(self):
        FakePoll.fail = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            fw.main(loops=10)

    def test_watchdog_is_opt_in(self):
        FakeWDT.instances.clear()
        fw.main(loops=5)
        self.assertEqual(FakeWDT.instances, [])
        fw.WATCHDOG_MS = 99_999
        fw.main(loops=5)
        self.assertEqual(len(FakeWDT.instances), 1)
        self.assertEqual(FakeWDT.instances[0].timeout, fw.WATCHDOG_MAX_MS)
        self.assertEqual(FakeWDT.instances[0].feeds, 5)

    # --------------------------------------------------------------- ADC0
    def test_adc0_off_by_default(self):
        self.assertEqual(fw.ADC0_MODE, "off")
        self.run_for(10)
        self.assertIsNone(self.messages("tel")[0]["adc0"])

    def test_adc0_probe_is_opt_in_and_allocation_free(self):
        pad = fw.PAD_GPIO26
        machine.mem32[pad] = 0x80  # OD set, no pulls, like an ADC-configured pad

        def floating():
            v = machine.mem32[pad]
            return 60000 if v & fw.PAD_PUE else 1000 if v & fw.PAD_PDE else 30000

        FakeMem.probe = floating
        fw.adc0_mode = "auto"
        adc_before, pin_before = FakeADC.created, FakePin.created
        self.run_for(7000)  # three probes
        self.assertFalse(fw.adc0_connected)
        self.assertEqual(machine.mem32[pad], 0x80)  # pad restored
        self.assertEqual((FakeADC.created, FakePin.created), (adc_before, pin_before))
        self.assertIsNone(self.messages("tel")[-1]["adc0"])

        FakeMem.probe = lambda: 40000  # a potentiometer holds the voltage
        self.run_for(3100)
        self.assertTrue(fw.adc0_connected)
        self.assertAlmostEqual(self.messages("tel")[-1]["adc0"], 40000 / 65535, places=3)

    def test_adc0_modes_resolve(self):
        self.assertEqual(fw.resolve_adc0_mode("on"), "on")
        self.assertEqual(fw.resolve_adc0_mode("bogus"), "off")
        impl = sys.implementation
        machine_str = getattr(impl, "_machine", None)
        try:
            impl._machine = "Raspberry Pi Pico with RP2040"
            self.assertEqual(fw.resolve_adc0_mode("auto"), "auto")
            impl._machine = "Raspberry Pi Pico2 with RP2350"
            self.assertEqual(fw.resolve_adc0_mode("auto"), "on")
        finally:
            if machine_str is None:
                del impl._machine
            else:
                impl._machine = machine_str


if __name__ == "__main__":
    unittest.main()
