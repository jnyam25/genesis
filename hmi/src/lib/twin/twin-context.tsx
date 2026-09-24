"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useTwinState } from "./useTwinState";
import { createTwinDataSource, type TwinDataSource } from "./source";
import type { TwinCommands, TwinEvent, TwinState } from "./types";

interface TwinContextValue {
  state: TwinState;
  events: TwinEvent[];
  loading: boolean;
  stale: boolean;
  commands: TwinCommands | undefined;
}

const TwinContext = createContext<TwinContextValue | null>(null);

/**
 * One twin subscription shared across all routes. Creating the source once at
 * the provider level means a single mock engine / single WebSocket connection
 * backs the whole app; the Manual/Jog screen's commands mutate that same
 * engine so every view stays in sync.
 */
export function TwinProvider({ children }: { children: ReactNode }) {
  // Lazy state initializer: created once per provider, stable across renders.
  const [source] = useState<TwinDataSource>(createTwinDataSource);

  const { state, events, loading, stale } = useTwinState(source);
  const value = useMemo<TwinContextValue>(
    () => ({ state, events, loading, stale, commands: source.commands }),
    [state, events, loading, stale, source],
  );

  return <TwinContext.Provider value={value}>{children}</TwinContext.Provider>;
}

export function useTwin(): TwinContextValue {
  const ctx = useContext(TwinContext);
  if (!ctx) throw new Error("useTwin must be used within a TwinProvider");
  return ctx;
}
