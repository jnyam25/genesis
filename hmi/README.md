# Captsone HMI

Operator HMI for the Captsone Industrial Paint Mixing System. It has a live OEE dashboard, a 2D line schematic, a 3D scene, a Controls screen (digital E-Stop, start/stop/reset, jog, tanks, simulated local panel), a global E-Stop/local-mode safety banner, and an Alarms screen.

Stack: Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4, shadcn/ui (Base UI), and react-three-fiber.

## Run

The usual way is from the repo root, which installs and runs the twin as well and connects the HMI to it. See [`../INSTALL.md`](../INSTALL.md).

To work on the HMI by itself, on its built-in mock feed:

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:43123.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server on port 43123 |
| `npm run build` | Production build |
| `npm start` | Serves the production build on port 43123 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Next.js core-web-vitals + TypeScript rules) |

## Data source

Set with `NEXT_PUBLIC_TWIN_SOURCE`. Copy `.env.example` to `.env.local` to change it.

| Value | Source |
| --- | --- |
| `mock` (default) | Built-in simulated line (`src/lib/twin/mock-engine.ts`) |
| `http` | Live twin. The browser polls `/api/twin/state` and posts `/api/twin/command`, and those route handlers forward to the twin at `TWIN_HTTP_URL` (default `http://127.0.0.1:43124`). |
| `ws` | Skeleton WebSocket bridge (`NEXT_PUBLIC_TWIN_URL`) |

See [`../docs/frontend-design.md`](../docs/frontend-design.md) for the architecture.
