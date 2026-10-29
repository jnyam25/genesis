"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, Bell, ShieldAlert } from "lucide-react";
import { useTwin } from "@/lib/twin/twin-context";
import { clockTime, ml, tankIsLow } from "@/lib/format";
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
      message: "No data",
    });
  }
  const safety = state.safety;
  if (safety) {
    for (const b of safety.eStopButtons.filter((x) => x.pressed)) {
      active.push({
        id: `estop-physical-${b.id}`,
        severity: "error",
        source: "Safety · physical E-Stop",
        message: `E-STOP · ${b.name}`,
      });
    }
    if (safety.digitalEStop) {
      active.push({
        id: "estop-digital",
        severity: "error",
        source: "Safety · digital E-Stop",
        message: "E-STOP · Digital",
      });
    }
    if (!safety.eStopActive && safety.resetRequired) {
      active.push({
        id: "reset-required",
        severity: "warn",
        source: "Safety",
        message: "Reset required",
      });
    }
    if (safety.controlMode === "local") {
      active.push({
        id: "local-mode",
        severity: "info",
        source: "Control mode",
        message: "LOCAL",
      });
    }
  } else if (state.oee.availability === 0 && state.connected) {
    active.push({
      id: "line-halted",
      severity: "error",
      source: "Line",
        message: "Stopped",
    });
  }
  for (const t of state.tanks) {
    if (tankIsLow(t)) {
      active.push({
        id: `tank-${t.id}-low`,
        severity: "warn",
        source: `Tank ${t.name}`,
        message: `${t.name} · ${ml(t.levelMl)} ml`,
      });
    }
  }

  const history = events.filter(
    (e) => e.severity === "error" || e.severity === "warn",
  );

  const iconFor = (s: ActiveAlarm["severity"]) =>
    s === "error" ? (
      <ShieldAlert className="h-4 w-4 text-rose-800" />
    ) : (
      <AlertTriangle className="h-4 w-4 text-amber-800" />
    );

  return (
    <main className="mx-auto w-full max-w-[1100px] flex-1 px-3 py-4 sm:px-6 space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-4 w-4" /> Active Alarms
            </CardTitle>
          </div>
          <Badge variant={active.length ? "destructive" : "secondary"}>
            {active.length}
          </Badge>
        </CardHeader>
        <CardContent>
          {active.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-800">
              <ShieldAlert className="h-4 w-4 opacity-0" />
              Clear
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
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              —
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
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-800" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
                    )}
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {clockTime(e.at)}
                    </span>
                    <span
                      className={`text-sm ${
                        e.severity === "error" ? "text-rose-800" : "text-amber-900"
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

    </main>
  );
}
