# Captsone ESP32 firmware

| Folder | Board | Job |
| --- | --- | --- |
| [`scanner-node/`](scanner-node/src/main.cpp) | ESP32 #1 (DevKit) | Label applicator + barcode scanner. Forwards the raw barcode text; the PLC validates it |
| [`station-node/`](station-node/src/main.cpp) | ESP32 #2 (the xArm's controller, or a DevKit on the servo bus) | Robotic arm program (lift a lid from the magazine, place and press it onto the container) + sort height sensor |
| [`lib/captsone_node/`](lib/captsone_node/src/captsone_node.h) | shared | Wi-Fi, Modbus TCP link to the PLC, PLC supervision, NVS settings, serial console, watchdog |

The Micro850 PLC makes every decision; the nodes execute its requests and report back. The protocol, settings, teach procedure and bench tests are in [docs/prototype/esp32.md](../docs/prototype/esp32.md).

## Build and flash

Install [PlatformIO](https://platformio.org/install) (free: the VS Code extension or `pip install platformio`), then:

```bash
cd firmware/scanner-node      # or station-node
pio run -t upload             # build and flash over USB
pio device monitor            # serial console, 115200 baud: type `help`
```

The first build downloads the ESP32 toolchain (a few minutes). If it fails with `HTTPClientError` and `CERTIFICATE_VERIFY_FAILED`, antivirus or a proxy is re-signing HTTPS: point `REQUESTS_CA_BUNDLE` at a PEM bundle that includes the Windows root certificates.

First boot: `set wifi_ssid …`, `set wifi_pass …`, `set plc_ip …` (and `set plc_port 5020` for the virtual PLC), then `reboot`. On the station node, check the servo-bus pins for your board (`bus_rx`, `bus_tx`, `bus_txen`, `bus_rxen`, `bus_echo`) and teach the poses before the first run; until then it reports an arm fault and the PLC won't start the line.

## Register map

`lib/captsone_node/src/captsone_registers.h` is generated from `twin/src/plc/tag-map.ts`. After changing the map, run `npm run tag-map` at the repo root and rebuild both nodes. `npm test` fails if the header is out of date.
