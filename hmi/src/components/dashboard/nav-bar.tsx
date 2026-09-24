"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, SlidersHorizontal, Bell, Gauge, KeyRound, OctagonX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTwin } from "@/lib/twin/twin-context";
import { clockTime } from "@/lib/format";

const LINKS = [
  { href: "/", label: "Dashboard", icon: LayoutGrid },
  { href: "/manual", label: "Controls", icon: SlidersHorizontal },
  { href: "/alarms", label: "Alarms", icon: Bell },
];

export function NavBar() {
  const pathname = usePathname();
  const { state, stale, loading, commands } = useTwin();
  const connected = state.connected && !stale && !loading;
  const safety = state.safety;

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
          <p className="text-xs text-muted-foreground">Digital twin · Line A</p>
        </div>
      </div>

      <nav className="flex items-center gap-1 rounded-lg bg-muted p-1">
        {LINKS.map((l) => {
          const active = pathname === l.href;
          const Icon = l.icon;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{l.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        {safety && (
          <Badge variant="outline" className="gap-1 font-mono text-[10px] tracking-wide" title="Local/Remote key switch on the machine panel">
            <KeyRound className="h-3 w-3" />
            {safety.controlMode === "local" ? "LOCAL" : "REMOTE"}
          </Badge>
        )}
        {commands && (
          <button
            type="button"
            onClick={() => void commands.eStop()}
            disabled={safety?.digitalEStop}
            title="Digital E-Stop — opens the safety circuit and shuts down the physical line. Always available."
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border-2 px-3 text-xs font-extrabold tracking-wider transition-colors ${
              safety?.eStopActive
                ? "animate-pulse border-red-400 bg-red-600 text-white"
                : "border-red-700 bg-red-600 text-white hover:bg-red-500 active:bg-red-700"
            } disabled:cursor-not-allowed`}
          >
            <OctagonX className="h-4 w-4" />
            {safety?.eStopActive ? "E-STOP ACTIVE" : "E-STOP"}
          </button>
        )}
        <Badge variant={connected ? "default" : "destructive"} className="gap-1.5">
          <Gauge className="h-3 w-3" />
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected ? "bg-emerald-300 animate-pulse" : "bg-rose-300"
            }`}
          />
          {loading ? "Connecting" : stale ? "Feed stale" : "Live"}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {state.timestamp ? clockTime(state.timestamp) : "--:--:--"}
        </span>
      </div>
    </header>
  );
}
