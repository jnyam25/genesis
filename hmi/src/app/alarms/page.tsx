"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, Bell, ShieldAlert, WifiOff } from "lucide-react";
import { useTwin } from "@/lib/twin/twin-context";
import { clockTime } from "@/lib/format";
import type { TwinEvent } from "@/lib/twin/types";

interface ActiveAlarm {
  id: string;
  severity: TwinEvent["severity"];
  source: string;
  message: string;
}

export default function AlarmsPage() {
  const { state, events, stale, loading } = useTwin();

  const active: ActiveAlarm[] = [];
  if (!loading && stale) {
    active.push({
      id: "feed-stale",
      severity: "error",
      source: "Data source",
      message: "Twin feed stale — no snapshot within freshness window",
    });
  }
  const safety = state.safety;
  if (safety) {
    for (const b of safety.eStopButtons.filter((x) => x.pressed)) {
      active.push({
        id: `estop-physical-${b.id}`,
        severity: "error",
        source: "Safety · physical E-Stop",
        message: `PHYSICAL E-STOP pressed at ${b.name} — line shut down`,
      });
    }
    if (safety.digitalEStop) {
      active.push({
        id: "estop-digital",
        severity: "error",
        source: "Safety · digital E-Stop",
        message: "DIGITAL E-STOP active (from HMI) — safety circuit open, line shut down",
      });
    }
    if (!safety.eStopActive && safety.resetRequired) {
      active.push({
        id: "reset-required",
        severity: "warn",
        source: "Safety",
        message: safety.remoteResetAllowed
          ? "Safety reset required — reset, then START"
          : "Safety reset required at the local control panel, then START",
      });
    }
    if (safety.controlMode === "local") {
      active.push({
        id: "local-mode",
        severity: "info",
        source: "Control mode",
        message: "LOCAL control — HMI is view-only (Digital E-Stop and Stop available)",
      });
    }
  } else if (state.oee.availability === 0 && state.connected) {
    active.push({
      id: "line-halted",
      severity: "error",
      source: "Line",
      message: "Line halted (availability 0)",
    });
  }
  for (const t of state.tanks) {
    const ratio = t.levelMl / t.capacityMl;
    if (ratio < 0.15) {
      active.push({
        id: `tank-${t.id}-crit`,
        severity: "error",
        source: `Tank ${t.name}`,
        message: `Tank ${t.name} CRITICAL — ${Math.round(ratio * 100)}% remaining`,
      });
    } else if (ratio < 0.3) {
      active.push({
        id: `tank-${t.id}-low`,
        severity: "warn",
        source: `Tank ${t.name}`,
        message: `Tank ${t.name} low — ${Math.round(ratio * 100)}% remaining`,
      });
    }
  }

  const history = events.filter(
    (e) => e.severity === "error" || e.severity === "warn",
  );

  const iconFor = (s: ActiveAlarm["severity"]) =>
    s === "error" ? (
      <ShieldAlert className="h-4 w-4 text-rose-400" />
    ) : (
      <AlertTriangle className="h-4 w-4 text-amber-400" />
    );

  return (
    <main className="mx-auto w-full max-w-[1100px] flex-1 px-3 py-4 sm:px-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Alarms</h2>
        <p className="text-sm text-muted-foreground">
          Active faults derived from the live twin snapshot, plus the rolling
          warn/error history.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-4 w-4" /> Active Alarms
            </CardTitle>
            <CardDescription>
              {active.length === 0
                ? "No active alarms — line nominal"
                : `${active.length} active`}
            </CardDescription>
          </div>
          <Badge variant={active.length ? "destructive" : "secondary"}>
            {active.length}
          </Badge>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-400">
              <ShieldAlert className="h-4 w-4 opacity-0" />
              All clear — no tanks low, feed live, line running.
            </div>
          ) : (
            <ul className="space-y-2">
              {active.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2"
                >
                  {iconFor(a.severity)}
                  <div className="flex-1">
                    <div className="text-sm font-medium">{a.message}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      {a.source}
                    </div>
                  </div>
                  <Badge
                    variant={a.severity === "error" ? "destructive" : "secondary"}
                    className="text-[10px]"
                  >
                    {a.severity.toUpperCase()}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Alarm History
          </CardTitle>
          <CardDescription>Recent warn / error events</CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No warn/error events yet.
            </p>
          ) : (
            <ScrollArea className="h-[320px] pr-3">
              <ol className="space-y-1.5">
                {history.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
                  >
                    {e.severity === "error" ? (
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    )}
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {clockTime(e.at)}
                    </span>
                    <span
                      className={`text-sm ${
                        e.severity === "error" ? "text-rose-300" : "text-amber-300"
                      }`}
                    >
                      {e.message}
                    </span>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <WifiOff className="h-3 w-3" /> Alarms are derived client-side from the
        snapshot; a real PLC can also push dedicated alarm tags through the same
        source.
      </p>
    </main>
  );
}
