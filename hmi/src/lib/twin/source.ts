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

import type { TwinCommands, TwinState } from "./types";
import { EMPTY_TWIN_STATE } from "./types";
import { MockTwinEngine } from "./mock-engine";

export interface TwinDataSource {
  /** Start emitting snapshots; call `onSnapshot` on each new state. */
  start(onSnapshot: (state: TwinState) => void): () => void;
  /** Operator commands, if the source supports write-back. */
  commands?: TwinCommands;
}

/** Default mock source used until the real twin is wired in. */
export class MockTwinDataSource implements TwinDataSource {
  private engine = new MockTwinEngine();
  commands: TwinCommands;

  constructor() {
    this.commands = {
      jogBelt: () => this.engine.jogBelt(),
      firePusher: () => this.engine.firePusher(),
      addTank: () => this.engine.addTank(),
      removeTank: (id: string) => this.engine.removeTank(id),
      eStop: () => this.engine.eStop(),
      clearEStop: () => this.engine.clearEStop(),
    };
  }

  start(onSnapshot: (state: TwinState) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setInterval>;

    const emit = () => {
      if (stopped) return;
      onSnapshot(this.engine.tick(Date.now()));
    };

    emit();
    timer = setInterval(emit, 500);

    return () => {
      stopped = true;
      clearInterval(timer);
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
 *   NEXT_PUBLIC_TWIN_SOURCE=ws       + NEXT_PUBLIC_TWIN_URL=ws://host:port
 */
export function createTwinDataSource(): TwinDataSource {
  const kind = process.env.NEXT_PUBLIC_TWIN_SOURCE ?? "mock";
  switch (kind) {
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
