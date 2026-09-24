# Raspberry Pi: bridge and HMI

The Pi runs two services:

| Service | What it runs | Listens on |
| --- | --- | --- |
| `captsone-twin` | `twin/dist/run.js` with `CAPTSONE_MODE=plc`: polls the PLC, serves `/hmi/*`, `/snapshot`, `/health` | `127.0.0.1:43124` |
| `captsone-hmi` | `next start` for the operator HMI (built with `NEXT_PUBLIC_TWIN_SOURCE=http`) | `0.0.0.0:43123` |

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

Create a service user and copy the project to `/opt/captsone` (git clone, or copy from the USB drive **without** `node_modules`; see [INSTALL.md](../../INSTALL.md)):

```bash
sudo useradd --system --create-home --home-dir /opt/captsone --shell /usr/sbin/nologin captsone
sudo cp -r genesis/. /opt/captsone/
sudo chown -R captsone:captsone /opt/captsone
```

Install and build as that user. The HMI build bakes in the `http` data source.

```bash
cd /opt/captsone
sudo -u captsone npm install
sudo -u captsone npm run build
sudo -u captsone npm test
```

The build takes several minutes on a Pi. `npm run build` at the repo root already sets `NEXT_PUBLIC_TWIN_SOURCE=http`.

## 3. Configure

```bash
sudo mkdir -p /etc/captsone
sudo cp /opt/captsone/deploy/raspberry-pi/captsone.env.example /etc/captsone/captsone.env
sudo nano /etc/captsone/captsone.env
```

Set at least `PLC_HOST`. All variables are listed in [../configuration.md](../configuration.md#environment-variables).

**Before connecting to the real PLC**, you can point the service at a virtual PLC on a PC (`PLC_HOST=<PC IP>`, `PLC_PORT=5020`) to check the Pi side on its own.

## 4. Services

```bash
sudo cp /opt/captsone/deploy/raspberry-pi/captsone-twin.service /etc/systemd/system/
sudo cp /opt/captsone/deploy/raspberry-pi/captsone-hmi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now captsone-twin captsone-hmi
```

Check them:

```bash
systemctl status captsone-twin captsone-hmi
```

```bash
curl -s http://127.0.0.1:43124/health
```

```bash
journalctl -u captsone-twin -f
```

`/health` should show `"mode": "plc"` and `"online": true`. Open `http://<pi-ip>:43123` from an operator device.

**Updating:**

```bash
sudo systemctl stop captsone-hmi captsone-twin
cd /opt/captsone && sudo -u captsone git pull   # or copy the new files in
sudo -u captsone npm install && sudo -u captsone npm run build && sudo -u captsone npm test
sudo systemctl start captsone-twin captsone-hmi
```

## 5. Firewall

Allow only what's needed on the operator side. For example, with `ufw`:

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw allow in on eth0 to any port 22 proto tcp     # SSH from the control network only
sudo ufw allow 43123/tcp                                # HMI
sudo ufw enable
```

Keep the twin service bound to `127.0.0.1` (the default `CAPTSONE_HOST`). The HMI reaches it locally; nothing else needs to.

## 6. Optional: kiosk screen

On Raspberry Pi OS Desktop (64-bit), autostart a full-screen browser for the local operator panel:

```bash
mkdir -p ~/.config/autostart
cp /opt/captsone/deploy/raspberry-pi/captsone-kiosk.desktop ~/.config/autostart/
```

The template launches Chromium in kiosk mode on `http://localhost:43123` and retries until the HMI is up. Disable screen blanking in the Raspberry Pi configuration tool.

## 7. Operations

| Task | Command |
| --- | --- |
| Live logs | `journalctl -u captsone-twin -u captsone-hmi -f` |
| PLC link state | `curl -s http://127.0.0.1:43124/health` |
| Last snapshot on disk | `cat /opt/captsone/twin/runtime/snapshot.json` |
| Restart after config change | `sudo systemctl restart captsone-twin` |
| Rebuild after changing `NEXT_PUBLIC_*` | `npm run build`, then `sudo systemctl restart captsone-hmi` |
