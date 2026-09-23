"""Host-side tests for firmware/main.py.

MicroPython-only modules (machine, uselect, time.ticks_*) are replaced by
small fakes so the pure logic - smoothing, the temperature formula, command
handling and the stdin line reader - can run under CPython:

    python -m unittest discover -s firmware/tests

These tests do NOT replace testing on a real Pico.
"""

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


class FakeADC:
    values = {4: 14000, 26: 32768}

    def __init__(self, ch):
        self.ch = 0 if ch == 26 else ch
        self.key = ch

    def read_u16(self):
        return FakeADC.values[self.key]


class FakePin:
    OUT, IN, PULL_UP, PULL_DOWN = 1, 0, 1, 2

    def __init__(self, pin_id, mode=None, pull=None):
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


class FakePoll:
    def register(self, *args):
        pass

    def poll(self, timeout):
        stdin = sys.stdin
        return stdin.tell() < len(stdin.getvalue())


def install_fakes():
    machine = types.ModuleType("machine")
    machine.ADC = FakeADC
    machine.Pin = FakePin
    machine.unique_id = lambda: b"\xe6\x60\x58\x38\x83\x2a\x4f\x21"
    uselect = types.ModuleType("uselect")
    uselect.POLLIN = 1
    uselect.poll = FakePoll
    sys.modules["machine"] = machine
    sys.modules["uselect"] = uselect
    time.ticks_ms = lambda: int(time.monotonic() * 1000)
    time.ticks_diff = lambda a, b: a - b
    time.ticks_add = lambda a, b: a + b
    time.sleep_ms = lambda ms: None


install_fakes()
fw = importlib.import_module("main")


class FirmwareTest(unittest.TestCase):
    def setUp(self):
        self.out = io.StringIO()
        self._stdout, self._stdin = sys.stdout, sys.stdin
        sys.stdout = self.out

    def tearDown(self):
        sys.stdout, sys.stdin = self._stdout, self._stdin

    def messages(self):
        return [json.loads(l) for l in self.out.getvalue().splitlines() if l]

    def feed(self, text):
        sys.stdin = io.StringIO(text)
        fw.poll_stdin()

    def test_moving_average(self):
        avg = fw.MovingAverage(3)
        self.assertEqual(avg.add(3), 3)
        self.assertEqual(avg.add(6), 4.5)
        self.assertEqual(avg.add(9), 6)
        self.assertEqual(avg.add(12), 9)  # window slides: 6, 9, 12

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
        FakeADC.values[4] = 14000

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

    def test_led_command(self):
        self.feed('{"cmd":"led","on":true}\r\n')
        self.assertEqual(fw.led.value(), 1)
        self.feed('{"cmd":"led","on":false}\n')
        self.assertEqual(fw.led.value(), 0)

    def test_blink_schedules_toggles(self):
        self.feed('{"cmd":"blink","n":2}\n')
        self.assertEqual(fw.blink_left, 4)
        now = fw.blink_next
        for i in range(4):
            fw.update_led(now + i * 1000)
        self.assertEqual(fw.blink_left, 0)
        self.assertEqual(fw.led.value(), 1 if fw.led_on else 0)

    def test_bad_input(self):
        self.feed('not json\n{"nope":1}\n{"cmd":"selfdestruct"}\n')
        errs = [m["msg"] for m in self.messages()]
        self.assertEqual(errs, ["bad json", "missing cmd", "unknown cmd"])

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


if __name__ == "__main__":
    unittest.main()
