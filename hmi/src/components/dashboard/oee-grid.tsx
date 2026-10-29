"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { oeeBg, oeeColor, ratio } from "@/lib/format";
import type { Oee } from "@/lib/twin/types";

const METRICS: { key: keyof Oee; label: string }[] = [
  { key: "overall", label: "OEE" },
  { key: "availability", label: "Availability" },
  { key: "performance", label: "Performance" },
  { key: "quality", label: "Quality" },
];

export function OeeGrid({ oee }: { oee: Oee }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {METRICS.map((m) => {
        const v = oee[m.key];
        const highlight = m.key === "overall";
        return (
          <Card
            key={m.key}
            className={highlight ? "border-primary/40 bg-primary/5" : ""}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {m.label}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div
                className={`font-mono text-3xl font-semibold tabular-nums ${oeeColor(v)}`}
              >
                {ratio(v)}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${oeeBg(v)} transition-all duration-500`}
                  style={{ width: `${Math.min(100, v * 100)}%` }}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
