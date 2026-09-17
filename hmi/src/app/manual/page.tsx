"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Play,
  ArrowLeftRight,
  PlusCircle,
  MinusCircle,
  OctagonX,
  ShieldCheck,
  Gauge,
  FlaskConical,
} from "lucide-react";
import { useTwin } from "@/lib/twin/twin-context";
import { pct } from "@/lib/format";

export default function ManualPage() {
  const { state, commands } = useTwin();
  const [busy, setBusy] = useState<string | null>(null);

  const run = (key: string, fn: () => void) => {
    setBusy(key);
    fn();
    setTimeout(() => setBusy(null), 350);
  };

  const halted = state.oee.availability === 0;

  return (
    <main className="mx-auto w-full max-w-[1100px] flex-1 px-3 py-4 sm:px-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Manual / Jog</h2>
        <p className="text-sm text-muted-foreground">
          Maintenance & override controls. These command the live twin source
          through the same data-source seam — in the mock they mutate the engine
          directly; against a real PLC they proxy to the controller.
        </p>
      </div>

      {halted && (
        <Alert variant="destructive">
          <AlertTitle>Line halted</AlertTitle>
          <AlertDescription>
            Availability is 0 — an E-Stop or changeover is active. Clear it to
            resume.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4" /> Motion
            </CardTitle>
            <CardDescription>Conveyor & reject pusher</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => run("jog", () => commands?.jogBelt())}
              disabled={busy === "jog" || halted}
            >
              <Play className="h-4 w-4" /> Jog belt
            </Button>
            <Button
              variant="secondary"
              onClick={() => run("pusher", () => commands?.firePusher())}
              disabled={busy === "pusher"}
            >
              <ArrowLeftRight className="h-4 w-4" /> Fire pusher
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <OctagonX className="h-4 w-4" /> Safety
            </CardTitle>
            <CardDescription>E-Stop interlock</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              onClick={() => run("estop", () => commands?.eStop())}
              disabled={busy === "estop" || halted}
            >
              <OctagonX className="h-4 w-4" /> E-Stop
            </Button>
            <Button
              variant="default"
              onClick={() => run("clear", () => commands?.clearEStop())}
              disabled={busy === "clear" || !halted}
            >
              <ShieldCheck className="h-4 w-4" /> Clear E-Stop
            </Button>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4" /> Tank Modules
              </CardTitle>
              <CardDescription>
                Add or remove a tank module — the line re-balances dynamically
                across dashboard, schematic, and 3D with no code change.
              </CardDescription>
            </div>
            <Button
              variant="default"
              onClick={() => run("add", () => commands?.addTank())}
              disabled={busy === "add"}
            >
              <PlusCircle className="h-4 w-4" /> Add tank
            </Button>
          </CardHeader>
          <CardContent>
            {state.tanks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tanks online.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {state.tanks.map((t, i) => {
                  const ratio = t.levelMl / t.capacityMl;
                  const low = ratio < 0.3;
                  return (
                    <li
                      key={t.id}
                      className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-4 w-4 rounded-sm border border-white/20"
                          style={{ backgroundColor: t.colorCode }}
                        />
                        <div>
                          <div className="text-sm font-medium">
                            Tank {i + 1} · {t.name}
                          </div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {t.levelMl.toLocaleString()}/{t.capacityMl.toLocaleString()} ml · {pct(ratio)}
                          </div>
                        </div>
                        {low && (
                          <Badge variant="secondary" className="text-[10px]">
                            LOW
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => commands?.removeTank(t.id)}
                        disabled={state.tanks.length <= 1}
                      >
                        <MinusCircle className="h-4 w-4" /> Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
