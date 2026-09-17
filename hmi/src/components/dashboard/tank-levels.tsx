"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { pct } from "@/lib/format";
import type { Tank } from "@/lib/twin/types";

function levelState(t: Tank): "ok" | "low" | "critical" {
  const r = t.levelMl / t.capacityMl;
  if (r < 0.15) return "critical";
  if (r < 0.3) return "low";
  return "ok";
}

export function TankLevels({ tanks }: { tanks: Tank[] }) {
  if (tanks.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Tank Levels</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No tanks reported by the twin.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Tank Levels</CardTitle>
        <Badge variant="secondary" className="font-mono text-xs">
          {tanks.length} tank{tanks.length === 1 ? "" : "s"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {tanks.map((t) => {
          const ratio = t.levelMl / t.capacityMl;
          const state = levelState(t);
          return (
            <div key={t.id} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-sm border border-white/20"
                    style={{ backgroundColor: t.colorCode }}
                  />
                  <span className="font-medium">{t.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {t.id}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {state !== "ok" && (
                    <Badge
                      variant={state === "critical" ? "destructive" : "secondary"}
                      className="text-[10px]"
                    >
                      {state === "critical" ? "CRITICAL" : "LOW"}
                    </Badge>
                  )}
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {t.levelMl.toLocaleString()} / {t.capacityMl.toLocaleString()} ml
                  </span>
                </div>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-md bg-muted ring-1 ring-border/60">
                <div
                  className="h-full rounded-md transition-all duration-500"
                  style={{
                    width: `${Math.min(100, ratio * 100)}%`,
                    backgroundColor: t.colorCode,
                  }}
                />
              </div>
              <div className="text-right font-mono text-[11px] text-muted-foreground">
                {pct(ratio)} full
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
