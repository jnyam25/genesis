/**
 * Twin data-source abstraction.
 *
 * The transport the HMI uses to obtain `TwinState` is TBD by the engine worker
 * (file watch, HTTP polling, OPC UA, MQTT, or WebSocket). To keep the frontend
 * decoupled, we hide the transport behind a `TwinDataSource` interface.
 * `useTwinState` subscribes to any source; the mock source is the default.
 *
 * A real source can be dropped in by implementing the same interface — no UI
 * code changes. `commands` is optional: real transports proxy operator
 * commands back to the PLC; the mock implements them locally so the Manual/Jog
 * screen is functional standalone.
 */

import type { TankColor, TwinCommands, TwinState } from "./types";
import { EMPTY_TWIN_STATE } from "./types";
import { MockTwinEngine } from "./mock-engine";

export interface TwinDataSource {
  /** Start emitting snapshots; call `onSnapshot` on each new state. */
  start(onSnapshot: (state: TwinState) => void): () => void;
  /** Operator commands, if the source supports write-back. */
  commands?: TwinCommands;
}

const MOCK_COLORS_KEY = "captsone.mock.tankColors";

function loadMockColors(): Record<string, Partial<TankColor>> {
  if (typeof window === "undefined") return {};
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(MOCK_COLORS_KEY) ?? "{}");
    return data && typeof data === "object" ? (data as Record<string, Partial<TankColor>>) : {};
  } catch {
    return {};
  }
}

function saveMockColors(edited: Record<string, TankColor>): void {
  try {
    window.localStorage.setItem(MOCK_COLORS_KEY, JSON.stringify(edited));
  } catch {
    /* storage unavailable (private mode): edits last for this session only */
  }
}

/** Default mock source used until the real twin is wired in. Tank color edits persist in localStorage. */
export class MockTwinDataSource implements TwinDataSource {
  private engine = new MockTwinEngine(loadMockColors(), saveMockColors);
  commands: TwinCommands;

  constructor() {
    const e = this.engine;
    const result = (fn: () => string | null) => Promise.resolve(fn());
    this.commands = {
      eStop: () => result(() => e.eStop()),
      releaseEStop: () => result(() => e.releaseEStop()),
      reset: () => result(() => e.reset("remote")),
      start: () => result(() => e.start("remote")),
      stop: () => result(() => e.stop("remote")),
      jogBelt: () => result(() => e.jogBelt("remote")),
      firePusher: () => result(() => e.firePusher()),
      addTank: (color) => result(() => e.addTank(color)),
      removeTank: (id: string) => result(() => e.removeTank(id)),
      setTankColor: (id, color) => result(() => e.setTankColor(id, color)),
      resetTankColor: (id) => result(() => e.resetTankColor(id)),
      sim: {
        setControlMode: (mode) => result(() => e.setControlMode(mode)),
        pressLocalButton: (button) =>
          result(() => {
            switch (button) {
              case "start":
                return e.start("local");
              case "stop":
                return e.stop("local");
              case "reset":
                return e.reset("local");
              case "jog":
                return e.jogBelt("local");
            }
          }),
        setPhysicalEStop: (id, pressed) => result(() => e.setPhysicalEStop(id, pressed)),
      },
    };
  }

  start(onSnapshot: (state: TwinState) => void): () => void {
    let stopped = false;

    const emit = () => {
      if (stopped) return;
      onSnapshot(this.engine.tick(Date.now()));
    };

    emit();
    const timer = setInterval(emit, 500);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

/**
 * Live twin over HTTP. Polls `${baseUrl}/state` (already in the `TwinState`
 * shape) and POSTs operator commands to `${baseUrl}/command`.
 *
 * `baseUrl` defaults to the HMI's own `/api/twin` proxy routes, which forward
 * to the twin's `/hmi/*` endpoints (see `twin-proxy.ts`). Polls are never
 * overlapped; failed polls are simply skipped so the stale watchdog in
 * `useTwinState` surfaces an unreachable twin.
 */
export class HttpTwinDataSource implements TwinDataSource {
  commands: TwinCommands;

  constructor(
    private baseUrl = "/api/twin",
    private intervalMs = 500,
  ) {
    /** POST a command; resolves to null on success or the refusal/error message. */
    const send = async (command: string, extra?: Record<string, unknown>): Promise<string | null> => {
      try {
        const res = await fetch(`${this.baseUrl}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command, ...extra }),
        });
        if (res.ok) return null;
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        return body?.error ?? `command ${command} failed (HTTP ${res.status})`;
      } catch (err) {
        return `command ${command} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    this.commands = {
      eStop: () => send("eStop"),
      releaseEStop: () => send("releaseEStop"),
      reset: () => send("reset"),
      start: () => send("start"),
      stop: () => send("stop"),
      jogBelt: () => send("jogBelt"),
      firePusher: () => send("firePusher"),
      addTank: (color) => send("addTank", { ...color }),
      removeTank: (tankId: string) => send("removeTank", { tankId }),
      setTankColor: (tankId, color) => send("setTankColor", { tankId, ...color }),
      resetTankColor: (tankId) => send("resetTankColor", tankId === undefined ? {} : { tankId }),
      // Only accepted when the twin reports a simulated line (safety.simulated).
      sim: {
        setControlMode: (mode) => send("simControlMode", { mode }),
        pressLocalButton: (button) => send("simLocalButton", { button }),
        setPhysicalEStop: (buttonId, pressed) => send("simPhysicalEStop", { buttonId, pressed }),
      },
    };
  }

  start(onSnapshot: (state: TwinState) => void): () => void {
    if (typeof window === "undefined") return () => {};
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: AbortController | null = null;

    const poll = async () => {
      inflight = new AbortController();
      try {
        const res = await fetch(`${this.baseUrl}/state`, { cache: "no-store", signal: inflight.signal });
        if (res.ok) {
          const data = (await res.json()) as TwinState;
          if (!stopped) onSnapshot({ ...data, connected: true });
        }
      } catch {
        /* twin unreachable or aborted — the stale watchdog will flag it */
      } finally {
        inflight = null;
        if (!stopped) timer = setTimeout(poll, this.intervalMs);
      }
    };
    poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      inflight?.abort();
    };
  }
}

/**
 * Skeleton for a real PLC→HMI bridge over WebSocket (or MQTT/OPC UA wrapped to
 * the same shape). The engine worker will publish the twin snapshot JSON; this
 * source just subscribes. Not wired by default — selected via env when the
 * endpoint is available.
 */
export class WebSocketTwinDataSource implements TwinDataSource {
  commands?: TwinCommands;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  start(onSnapshot: (state: TwinState) => void): () => void {
    if (typeof WebSocket === "undefined") {
      // SSR / no WebSocket — leave the empty state; the stale watchdog will flag it.
      return () => {};
    }
    let stopped = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(this.url);
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as TwinState;
          onSnapshot({ ...data, connected: true });
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (!stopped) reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }
}

/**
 * Environment-overridable source factory.
 *   NEXT_PUBLIC_TWIN_SOURCE=mock     (default)
 *   NEXT_PUBLIC_TWIN_SOURCE=http     live twin via the /api/twin proxy
 *                                    (+ optional NEXT_PUBLIC_TWIN_URL base URL)
 *   NEXT_PUBLIC_TWIN_SOURCE=ws       + NEXT_PUBLIC_TWIN_URL=ws://host:port
 */
export function createTwinDataSource(): TwinDataSource {
  const kind = process.env.NEXT_PUBLIC_TWIN_SOURCE ?? "mock";
  switch (kind) {
    case "http":
      return new HttpTwinDataSource(process.env.NEXT_PUBLIC_TWIN_URL || "/api/twin");
    case "ws": {
      const url = process.env.NEXT_PUBLIC_TWIN_URL ?? "ws://localhost:43123/twin";
      return new WebSocketTwinDataSource(url);
    }
    case "mock":
    default:
      return new MockTwinDataSource();
  }
}

export { EMPTY_TWIN_STATE };
