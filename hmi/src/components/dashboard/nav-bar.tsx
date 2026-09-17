"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, SlidersHorizontal, Bell, Gauge } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTwin } from "@/lib/twin/twin-context";
import { clockTime } from "@/lib/format";

const LINKS = [
  { href: "/", label: "Dashboard", icon: LayoutGrid },
  { href: "/manual", label: "Manual / Jog", icon: SlidersHorizontal },
  { href: "/alarms", label: "Alarms", icon: Bell },
];

export function NavBar() {
  const pathname = usePathname();
  const { state, stale, loading } = useTwin();
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

      <div className="flex items-center gap-2">
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
