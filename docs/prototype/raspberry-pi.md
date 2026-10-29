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

On Raspberry Pi OS Desktop (64-bit), autostart a full-screen browser for the local operator panel:

```bash
mkdir -p ~/.config/autostart
cp /opt/genesis/deploy/raspberry-pi/genesis-kiosk.desktop ~/.config/autostart/
```

The template launches Chromium in kiosk mode on `http://localhost:43123` and retries until the HMI is up. Disable screen blanking in the Raspberry Pi configuration tool.

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
