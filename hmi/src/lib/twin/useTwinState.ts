"use client";

import { useEffect, useRef, useState } from "react";
import { createTwinDataSource, type TwinDataSource } from "./source";
import { EMPTY_TWIN_STATE, type TwinEvent, type TwinState } from "./types";

interface UseTwinStateResult {
  state: TwinState;
  events: TwinEvent[];
  /** True until the first snapshot has arrived. */
  loading: boolean;
  /** True if no snapshot has arrived within the stale window. */
  stale: boolean;
}

const STALE_MS = 3000;

/**
 * Subscribe to the twin data source and return the latest snapshot plus a
 * rolling event log (built client-side from `lastEvent` changes).
 *
 * The transport is decided by `createTwinDataSource()`; swapping to a
 * WebSocket/polling source later does not change any consumer of this hook.
 */
export function useTwinState(source?: TwinDataSource): UseTwinStateResult {
  const [state, setState] = useState<TwinState>(EMPTY_TWIN_STATE);
  const [events, setEvents] = useState<TwinEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const lastEventId = useRef<string | null>(null);
  const lastSnapshotAt = useRef<number>(0);

  useEffect(() => {
    const ds = source ?? createTwinDataSource();
    let stopped = false;

    const stop = ds.start((snapshot) => {
      if (stopped) return;
      lastSnapshotAt.current = Date.now();
      setLoading(false);
      setStale(false);
      setState(snapshot);
      if (snapshot.lastEvent && snapshot.lastEvent.id !== lastEventId.current) {
        lastEventId.current = snapshot.lastEvent.id;
        setEvents((prev) =>
          [snapshot.lastEvent!, ...prev].slice(0, 60),
        );
      }
    });

    // Stale watchdog: if no snapshot for STALE_MS, flag the feed as stale.
    const watchdog = setInterval(() => {
      if (lastSnapshotAt.current && Date.now() - lastSnapshotAt.current > STALE_MS) {
        setStale(true);
      }
    }, 1000);

    return () => {
      stopped = true;
      stop();
      clearInterval(watchdog);
    };
  }, [source]);

  return { state, events, loading, stale };
}
