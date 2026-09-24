"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle2, XCircle, Gauge, Package } from "lucide-react";
import type { Counts, SortLane } from "@/lib/twin/types";

export function CountsCard({
  counts,
  throughputCpm,
  sortLanes,
}: {
  counts: Counts;
  throughputCpm: number;
  sortLanes?: SortLane[];
}) {
  const acceptRate =
    counts.total > 0 ? counts.accepted / counts.total : 1;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Accepted
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="font-mono text-3xl font-semibold tabular-nums text-emerald-400">
            {counts.accepted}
          </div>
          {sortLanes && sortLanes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              {sortLanes.map((lane) => (
                <li key={lane.id} className="flex justify-between gap-2">
                  <span className="truncate">{lane.name}</span>
                  <span className="font-mono tabular-nums text-foreground">{lane.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <XCircle className="h-4 w-4 text-rose-400" />
            Rejected
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="font-mono text-3xl font-semibold tabular-nums text-rose-400">
            {counts.rejected}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Package className="h-4 w-4 text-sky-400" />
            Total
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="font-mono text-3xl font-semibold tabular-nums">
            {counts.total}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {Math.round(acceptRate * 100)}% accept rate
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Gauge className="h-4 w-4 text-amber-400" />
            Throughput
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="font-mono text-3xl font-semibold tabular-nums">
            {throughputCpm}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            containers / min
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
