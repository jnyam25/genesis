# Installing Captsone on another computer

This repo has two runnable Node projects, and the root `package.json` drives both:

| Folder | What it is | Default URL |
| --- | --- | --- |
| `twin/` | Digital-twin engine (TypeScript, Node, no framework) | http://127.0.0.1:43124/ |
| `hmi/` | Operator HMI (Next.js 16, React 19, Tailwind 4, three.js) | http://localhost:43123 |

When you start them from the root, the HMI shows the **live twin**. The browser only talks to the HMI, and the HMI's server forwards requests to the twin.

## 1. Prerequisites

- **Node.js 20.9 or newer.** The LTS release (22.x) is recommended; `.nvmrc` pins 22.
  - Download: https://nodejs.org. npm comes with Node.
  - With nvm / nvm-windows / fnm: `nvm install` then `nvm use` in the repo root.
- **An internet connection for the first install.** npm downloads the packages, and the HMI downloads its Google font (Geist) the first time it builds.
- Any editor or IDE (VS Code, WebStorm, Cursor, …). No IDE-specific setup is needed.
- Git is optional.

Check your versions:

```bash
node -v
```

```bash
npm -v
```

## 2. Copying the project (USB drive, zip, network share)

1. **Don't copy `node_modules/`, `.next/`, or `dist/`.** They're large, and parts of them are compiled for one OS and CPU (the Next.js SWC compiler, Tailwind's oxide engine, lightningcss). If they end up on a different machine, the app fails with errors like "Cannot find module @next/swc-…".
   - On the source computer, run `npm run clean` before copying, or skip those folders when you copy.
   - If they get copied anyway, it's fine: `npm install` in step 3 replaces them.
2. **Copy the project onto the computer's own drive** (for example `C:\dev\genesis` or `~/dev/genesis`) and run it from there, not from the USB stick. USB drives formatted FAT32 or exFAT don't support the symlinks npm creates on macOS and Linux, and they're much slower.
3. Keep every `package-lock.json`: the root one, `twin/package-lock.json`, and `hmi/package-lock.json`. They pin the exact dependency versions.
4. If you copy with Explorer or Finder, include hidden files (`.gitignore`, `.nvmrc`, `.gitattributes`, `hmi/.env.example`).

## 3. Install

From the repo root:

```bash
npm install
```

This installs both sub-projects too: a `postinstall` step runs `npm ci` in `twin/` and then in `hmi/`. To rerun only that step, use `npm run setup`.

Then check the environment (Node version, installs, native binaries, free ports):

```bash
npm run doctor
```

## 4. Run

**Development** (twin and HMI together, output prefixed `[twin]` / `[hmi]`, Ctrl+C stops both):

```bash
npm run dev
```

Open http://localhost:43123. The Controls screen sends real commands to the twin: digital E-Stop, start/stop, reset, jog, reject pusher, add/remove tank. On the simulated line it also has a simulated local control panel and physical E-Stop buttons.

**Production** (build once, then start):

```bash
npm run build
```

```bash
npm start
```

**Other ways to run:**

| Command | What it does |
| --- | --- |
| `npm run dev:mock` | Twin + HMI, but the HMI uses its built-in simulated line instead of the twin |
| `npm run dev:plc-sim` | Virtual PLC (Modbus TCP on port 5020) + twin in PLC-bridge mode + HMI: the physical-prototype architecture, in software ([docs/prototype/](docs/prototype/README.md)) |
| `npm run virtual-plc` | Virtual PLC only, e.g. for testing ESP32 firmware or a Modbus tool against it |
| `npm run dev:hmi` | HMI only, on its built-in mock feed (no twin needed) |
| `npm run dev:twin` | Twin only (its own mini dashboard is at http://127.0.0.1:43124/) |
| `npm run build:mock` | Production build with the HMI on the mock feed |

## Root scripts

| Command | What it does |
| --- | --- |
| `npm install` | Installs root + `twin/` + `hmi/` |
| `npm run setup` | Reinstalls `twin/` + `hmi/` (clean `npm ci`) |
| `npm run doctor` | Diagnoses the environment |
| `npm run dev` / `dev:mock` / `dev:twin` / `dev:hmi` | Development servers (see above) |
| `npm run dev:plc-sim` / `virtual-plc` | Virtual PLC stack (see above) |
| `npm run build` / `build:mock` | Builds twin (`tsc`) + HMI (`next build`) |
| `npm test` | Twin test suite (engine, Modbus, virtual PLC ↔ bridge) |
| `npm run tag-map` | Regenerates the register tables in `docs/prototype/io-map.md` from `twin/src/plc/tag-map.ts` |
| `npm start` | Runs the production builds of both |
| `npm run typecheck` | Typechecks both projects |
| `npm run lint` | Lints the HMI |
| `npm run clean` | Deletes `node_modules`, `.next`, `dist`, `runtime` (do this before copying) |

## Configuration

Full reference: [docs/configuration.md](docs/configuration.md).

| Setting | Where | Default |
| --- | --- | --- |
| Twin HTTP port | env `CAPTSONE_PORT` | `43124` |
| Twin bind address | env `CAPTSONE_HOST` (use `0.0.0.0` to expose it on the LAN) | `127.0.0.1` |
| Twin mode | env `CAPTSONE_MODE`: `sim`, or `plc` with `PLC_HOST` / `PLC_PORT` / `PLC_UNIT_ID` | `sim` |
| Virtual PLC port | env `VPLC_PORT` | `5020` |
| HMI port | `-p` flag in `hmi/package.json` scripts | `43123` |
| HMI data source | env `NEXT_PUBLIC_TWIN_SOURCE` or `hmi/.env.local` (`mock`, `http`, `ws`) | `http` from the root scripts, `mock` when running `hmi/` alone |
| Where the HMI finds the twin | env `TWIN_HTTP_URL` (read at runtime) | `http://127.0.0.1:<twin port>` |

`NEXT_PUBLIC_TWIN_SOURCE` is baked in when the app is built. After changing it, restart `npm run dev` or rebuild. See `hmi/.env.example`.

Setting an environment variable for one command:

- macOS / Linux: `CAPTSONE_PORT=5000 npm run dev`
- Windows PowerShell: `$env:CAPTSONE_PORT=5000; npm run dev`
- Windows cmd: `set CAPTSONE_PORT=5000 && npm run dev`

**Opening the HMI from another device on the network:** use `http://<this-computer's-IP>:43123`. Next.js dev and start already listen on all interfaces. The twin can stay on `127.0.0.1`, because only the HMI server talks to it. You may need to allow port 43123 through the firewall.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find module '@next/swc-…'`, `lightningcss…node`, or `@tailwindcss/oxide` errors | `node_modules` came from another OS or CPU. Run `npm run clean`, then `npm install`. |
| `EADDRINUSE` / "port … is already in use" | Another instance is running, or another app has the port. Stop it, or change the port (see Configuration). `npm run doctor` shows which port. |
| HMI shows "Connecting…" or "Feed stale" | The twin isn't running or can't be reached. Use `npm run dev` (not `dev:hmi`), and check `http://localhost:43123/api/twin/state`: a 502 response includes the reason. |
| HMI shows Red/Green/Blue tanks instead of the twin's White/Red/Blue | It's on the mock feed. Check `NEXT_PUBLIC_TWIN_SOURCE` in your shell or `hmi/.env.local`, and rebuild if you're using `npm start`. |
| `dev:plc-sim`: "port 5020 is already in use" | Another virtual PLC is running; stop it or set `VPLC_PORT` |
| `/health` shows `online: false` in PLC mode | See [docs/prototype/troubleshooting.md](docs/prototype/troubleshooting.md) |
| `npm ci` says the lockfile is out of sync | The install script falls back to `npm install` automatically. Commit the updated lockfile. |
| `EPERM` / symlink errors during install | You're installing on a FAT32/exFAT USB drive. Copy the project to the computer's own disk. |
| `Failed to fetch font 'Geist'` during build or dev | You're offline. Connect once so Next.js can download and cache the font. |
| npm warns that install scripts were blocked (`unrs-resolver`) | Harmless on npm 11+. That package is optional; lint and build still work. |
| Node version error | Install Node 20.9+ (LTS 22 recommended), then rerun `npm install`. |
