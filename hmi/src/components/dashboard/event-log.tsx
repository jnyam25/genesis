"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { clockTime } from "@/lib/format";
import type { TwinEvent } from "@/lib/twin/types";

const SEVERITY_STYLE: Record<TwinEvent["severity"], string> = {
  info: "text-sky-400",
  success: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-rose-400",
};

const SEVERITY_DOT: Record<TwinEvent["severity"], string> = {
  info: "bg-sky-400",
  success: "bg-emerald-400",
  warn: "bg-amber-400",
  error: "bg-rose-400",
};

export function EventLog({ events }: { events: TwinEvent[] }) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Event Log</CardTitle>
        <span className="font-mono text-xs text-muted-foreground">
          {events.length} recent
        </span>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Waiting for events from the twin…
          </p>
        ) : (
          <ScrollArea className="h-[260px] lg:h-[320px] pr-3">
            <ol className="space-y-1.5">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
                >
                  <span
                    className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[e.severity]}`}
                  />
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                    {clockTime(e.at)}
                  </span>
                  <span className={`text-sm ${SEVERITY_STYLE[e.severity]}`}>
                    {e.message}
                  </span>
                </li>
              ))}
            </ol>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
