/**
 * Twin data-source abstraction.
 *
 * The transport the HMI uses to obtain `TwinState` is TBD by the engine worker
 * (file watch, HTTP polling, or WebSocket). To keep the frontend decoupled, we
 * hide the transport behind a `TwinDataSource` interface. `useTwinState`
 * subscribes to any source; the mock source is the default. A real source can
 * be dropped in by implementing the same interface — no UI code changes.
 */

import type { TwinState } from "./types";
import { EMPTY_TWIN_STATE } from "./types";
import { MockTwinEngine } from "./mock-engine";

export interface TwinDataSource {
  /** Start emitting snapshots; call `onSnapshot` on each new state. */
  start(onSnapshot: (state: TwinState) => void): () => void;
}

/** Default mock source used until the real twin is wired in. */
export class MockTwinDataSource implements TwinDataSource {
  start(onSnapshot: (state: TwinState) => void): () => void {
    const engine = new MockTwinEngine();
    let stopped = false;
    let timer: ReturnType<typeof setInterval>;

    const emit = () => {
      if (stopped) return;
      onSnapshot(engine.tick(Date.now()));
    };

    // Emit immediately so the UI doesn't sit on the empty state, then tick.
    emit();
    timer = setInterval(emit, 500);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

/**
 * Environment-overridable source factory.
 * Set NEXT_PUBLIC_TWIN_SOURCE=ws|poll|file later; defaults to mock.
 */
export function createTwinDataSource(): TwinDataSource {
  const kind = process.env.NEXT_PUBLIC_TWIN_SOURCE ?? "mock";
  switch (kind) {
    case "mock":
    default:
      return new MockTwinDataSource();
  }
}

export { EMPTY_TWIN_STATE };
