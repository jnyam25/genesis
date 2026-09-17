"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { oeeBg, oeeColor, pct1 } from "@/lib/format";
import type { Oee } from "@/lib/twin/types";

interface Metric {
  key: keyof Oee;
  label: string;
  hint: string;
}

const METRICS: Metric[] = [
  {
    key: "overall",
    label: "OEE",
    hint: "Availability × Performance × Quality",
  },
  {
    key: "availability",
    label: "Availability",
    hint: "Run time / planned time",
  },
  {
    key: "performance",
    label: "Performance",
    hint: "Throughput / ideal throughput",
  },
  {
    key: "quality",
    label: "Quality",
    hint: "Accepted / total produced",
  },
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
                {pct1(v)}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${oeeBg(v)} transition-all duration-500`}
                  style={{ width: `${Math.min(100, v * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {m.hint}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
