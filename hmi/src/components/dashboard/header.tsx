"use client";

import { Badge } from "@/components/ui/badge";
import { clockTime } from "@/lib/format";
import type { TwinState } from "@/lib/twin/types";

export function Header({
  state,
  stale,
  loading,
}: {
  state: TwinState;
  stale: boolean;
  loading: boolean;
}) {
  const connected = state.connected && !stale && !loading;
  return (
    <header className="flex flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground font-mono text-sm font-bold">
          CP
        </div>
        <div>
          <h1 className="text-base font-semibold leading-tight">
            Captsone Paint Mixing — Operator HMI
          </h1>
          <p className="text-xs text-muted-foreground">
            Digital twin · Line A
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          variant={connected ? "default" : "destructive"}
          className="gap-1.5"
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected
                ? "bg-emerald-300 animate-pulse"
                : "bg-rose-300"
            }`}
          />
          {loading
            ? "Connecting"
            : stale
              ? "Feed stale"
              : "Live"}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {state.timestamp ? clockTime(state.timestamp) : "--:--:--"}
        </span>
      </div>
    </header>
  );
}
