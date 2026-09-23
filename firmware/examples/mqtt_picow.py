"""
PicoPulse - OPTIONAL Pico W MQTT example.

!! UNTESTED ON HARDWARE. This is a separate, minimal example and is NOT part
!! of the USB dashboard flow. It needs a Raspberry Pi Pico W (the plain Pico
!! has no WiFi) and the umqtt.simple library:
!!     mpremote mip install umqtt.simple

It publishes the same "tel" message format as main.py (docs/PROTOCOL.md) to
an MQTT topic, so any MQTT client (e.g. mosquitto_sub) can watch it:
    mosquitto_sub -h test.mosquitto.org -t "picopulse/<uid>/tel"

Fill in the settings below before copying it to the board as main.py.
Do not commit real WiFi credentials.
"""

import json
import time
import machine
import network
from umqtt.simple import MQTTClient

WIFI_SSID = "your-ssid"
WIFI_PASSWORD = "your-password"
MQTT_BROKER = "test.mosquitto.org"   # public test broker, no auth, no privacy
MQTT_PORT = 1883
PERIOD_S = 2

UID = "".join("{:02x}".format(b) for b in machine.unique_id())
TOPIC = "picopulse/{}/tel".format(UID).encode()

temp_adc = machine.ADC(4)
led = machine.Pin("LED", machine.Pin.OUT)


def read_temp_c():
    volts = temp_adc.read_u16() * 3.3 / 65535
    return 27 - (volts - 0.706) / 0.001721


def connect_wifi(timeout_s=20):
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(WIFI_SSID, WIFI_PASSWORD)
    start = time.time()
    while not wlan.isconnected():
        if time.time() - start > timeout_s:
            raise RuntimeError("WiFi connection timed out")
        led.toggle()
        time.sleep(0.25)
    led.value(1)
    return wlan


def main():
    connect_wifi()
    client = MQTTClient("picopulse-" + UID, MQTT_BROKER, port=MQTT_PORT)
    client.connect()
    seq = 0
    start = time.ticks_ms()
    while True:
        seq += 1
        msg = {
            "t": "tel",
            "seq": seq,
            "ms": time.ticks_diff(time.ticks_ms(), start),
            "temp": round(read_temp_c(), 2),
            "adc0": None,
        }
        try:
            client.publish(TOPIC, json.dumps(msg))
        except OSError:
            # Broker dropped us: reconnect and keep going.
            time.sleep(2)
            client.connect()
        time.sleep(PERIOD_S)


main()
