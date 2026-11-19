# Raspberry Pi: bridge and HMI

The Pi runs two services:

| Service | What it runs | Listens on |
| --- | --- | --- |
| `genesis-twin` | `twin/dist/run.js` with `GENESIS_MODE=plc`: polls the PLC, serves `/hmi/*`, `/snapshot`, `/health` | `127.0.0.1:43124` |
| `genesis-hmi` | `next start` for the operator HMI (built with `NEXT_PUBLIC_TWIN_SOURCE=http`) | `0.0.0.0:43123` |

Template files are in [`deploy/raspberry-pi/`](../../deploy/raspberry-pi/).

## 1. Hardware and OS

| Item | Recommendation |
| --- | --- |
| Board | Raspberry Pi 5 (4 GB+) or Pi 4 (4 GB+). Building the HMI needs memory |
| Storage | Industrial-grade microSD or, better, a USB/NVMe SSD. Paint lines are dusty and power cuts happen |
| OS | **Raspberry Pi OS Lite, 64-bit** (or Desktop, 64-bit, for a local kiosk screen). Next.js needs a 64-bit OS |
| Network | `eth0` on the control network with a static IP ([communication.md §1](communication.md#1-network)); Wi-Fi or a second NIC for operators if needed |
| Power | Official supply. Consider a small UPS HAT so a power blip doesn't corrupt storage |
| Display (optional) | Touchscreen for a local HMI in kiosk mode (§6) |

## 2. Install Node.js and the project

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl ca-certificates
```

Install Node.js 22 LTS. Either use the NodeSource repository (see nodesource.com for the current setup script) or nvm for the service user. Then check it:

```bash
node -v
```

Create a service user and copy the project to `/opt/genesis` (git clone, or copy from the USB drive **without** `node_modules`; see [INSTALL.md](../../INSTALL.md)):

```bash
sudo useradd --system --create-home --home-dir /opt/genesis --shell /usr/sbin/nologin genesis
sudo cp -r genesis/. /opt/genesis/
sudo chown -R genesis:genesis /opt/genesis
```

Install and build as that user. The HMI build bakes in the `http` data source.

```bash
cd /opt/genesis
sudo -u genesis npm install
sudo -u genesis npm run build
sudo -u genesis npm test
```

The build takes several minutes on a Pi. `npm run build` at the repo root already sets `NEXT_PUBLIC_TWIN_SOURCE=http`.

## 3. Configure

```bash
sudo mkdir -p /etc/genesis
sudo cp /opt/genesis/deploy/raspberry-pi/genesis.env.example /etc/genesis/genesis.env
sudo nano /etc/genesis/genesis.env
```

Set at least `PLC_HOST`. All variables are listed in [../configuration.md](../configuration.md#environment-variables).

**Before connecting to the real PLC**, you can point the service at a virtual PLC on a PC (`PLC_HOST=<PC IP>`, `PLC_PORT=5020`) to check the Pi side on its own.

## 4. Services

```bash
sudo cp /opt/genesis/deploy/raspberry-pi/genesis-twin.service /etc/systemd/system/
sudo cp /opt/genesis/deploy/raspberry-pi/genesis-hmi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now genesis-twin genesis-hmi
```

The units keep the rest of the disk read-only. They create `/opt/genesis/twin/runtime` and `/opt/genesis/hmi/.next` and allow writes only there, so the first live PLC reading can be saved after a reboot. Copy the unit files again after pulling an update, then `sudo systemctl daemon-reload`.

Check them:

```bash
systemctl status genesis-twin genesis-hmi
```

```bash
curl -s http://127.0.0.1:43124/health
```

```bash
journalctl -u genesis-twin -f
```

`/health` should show `"mode": "plc"` and `"online": true`. Open `http://<pi-ip>:43123` from an operator device.

**Updating:**

```bash
sudo systemctl stop genesis-hmi genesis-twin
cd /opt/genesis && sudo -u genesis git pull   # or copy the new files in
sudo -u genesis npm install && sudo -u genesis npm run build && sudo -u genesis npm test
sudo systemctl start genesis-twin genesis-hmi
```

## 5. Firewall

Allow only what's needed on the operator side. For example, with `ufw`:

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw allow in on eth0 to any port 22 proto tcp     # SSH from the control network only
sudo ufw allow 43123/tcp                                # HMI
sudo ufw allow in on wlan0 to any port 5502 proto tcp   # SCADA door, operator Wi-Fi only
sudo ufw allow in on wg0 to any port 5502 proto tcp     # SCADA door, WireGuard only
sudo ufw enable
```

Keep the twin service bound to `127.0.0.1` (the default `GENESIS_HOST`). The HMI reaches it locally; nothing else needs to. Do not allow port 5502 on `eth0`. That port is the remote SCADA door, and the control network already has the PLC.

## 6. Optional: kiosk screen

On Raspberry Pi OS Desktop (64-bit), the local touchscreen can show only the operator HMI. The template [`deploy/raspberry-pi/genesis-kiosk.desktop`](../../deploy/raspberry-pi/genesis-kiosk.desktop) waits until `http://localhost:43123` answers, then opens Chromium full screen. The twin and the HMI keep running as services. Closing the browser does not stop them.

Run the copy as the user who logs into the desktop, not as the `genesis` service account. That account has no login shell.

### Turn kiosk mode on

```bash
mkdir -p ~/.config/autostart
cp /opt/genesis/deploy/raspberry-pi/genesis-kiosk.desktop ~/.config/autostart/
```

Log out and back in, or reboot. The browser opens on the next desktop login and comes back after every reboot. On an older image, if the screen stays on the desktop, edit the copied file and change `chromium` to `chromium-browser`.

To open it once, without autostart, from a terminal on the desktop:

```bash
chromium --kiosk --noerrdialogs --disable-infobars --incognito http://localhost:43123
```

Disable screen blanking in the Raspberry Pi configuration tool so the panel does not go dark during a run.

### Leave the full-screen browser

The HMI stays up. These only dismiss Chromium:

| What you want | What to do |
| --- | --- |
| Back to the desktop, this session | **Alt+F4**. Autostart opens the browser again at the next login. |
| A text login on this Pi | **Ctrl+Alt+F2**, then log in. **Ctrl+Alt+F1** returns to the desktop. On an older image the desktop is **Ctrl+Alt+F7**. |
| Stop it opening at login | From a normal login or over SSH: `rm ~/.config/autostart/genesis-kiosk.desktop`, then **Alt+F4** or `pkill -f "chromium.*--kiosk"`. |

### Run commands while the screen stays on the HMI

Use SSH from the engineering laptop. The firewall in §5 already allows port 22 from the control network (`eth0`). The operator screen is untouched.

```bash
ssh <desktop-user>@<pi-ip>
systemctl status genesis-twin genesis-hmi
curl -s http://127.0.0.1:43124/health
journalctl -u genesis-twin -u genesis-hmi -f
```

Service restarts from that session use the same commands as §7. A restart of `genesis-hmi` reloads the page the kiosk is already showing. You do not leave kiosk mode to do it.

From the Pi's own keyboard, **Ctrl+Alt+F2** is the other way in. Log in, run the command, then **Ctrl+Alt+F1** to return to the HMI. The browser is still full screen when you come back.

## 7. Operations

| Task | Command |
| --- | --- |
| Live logs | `journalctl -u genesis-twin -u genesis-hmi -u genesis-scada-gateway -f` |
| PLC link state | `curl -s http://127.0.0.1:43124/health` |
| Last snapshot on disk | `cat /opt/genesis/twin/runtime/snapshot.json` |
| Restart after config change | `sudo systemctl restart genesis-twin` |
| Rebuild after changing `NEXT_PUBLIC_*` | `npm run build`, then `sudo systemctl restart genesis-hmi` |

## 8. Remote SCADA

A wired or wireless FUXA that is not on the control network connects to the Pi, not to the PLC. Set `SCADA_GATEWAY_HOST` in `/etc/genesis/genesis.env` to the Pi's operator address, its WireGuard address, or both. Build the twin (`npm run build` in `twin/`), then:

```bash
sudo cp deploy/raspberry-pi/genesis-scada-gateway.service /etc/systemd/system/
sudo systemctl enable --now genesis-scada-gateway
```

The service exits if `SCADA_GATEWAY_HOST` is empty, so leave it disabled until that line is set. How the two SCADA PCs reach the door is in [communication.md §5](communication.md#5-scada-off-the-control-network).
