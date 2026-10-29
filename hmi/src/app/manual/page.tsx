"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Play,
  Square,
  ArrowLeftRight,
  PlusCircle,
  MinusCircle,
  OctagonX,
  ShieldCheck,
  RotateCcw,
  Gauge,
  FlaskConical,
  KeyRound,
  Unlock,
  CircleDot,
  MonitorCog,
} from "lucide-react";
import { useTwin } from "@/lib/twin/twin-context";
import { refusal, type SafetyCommand } from "@/lib/twin/safety";
import type { CommandResult } from "@/lib/twin/types";
import { ml, pct, tankIsLow } from "@/lib/format";
import { AddTankForm, TankColorsCard } from "@/components/controls/tank-colors";

interface Feedback {
  ok: boolean;
  message: string;
  at: number;
}

export default function ControlsPage() {
  const { state, commands } = useTwin();
  const safety = state.safety;
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [addingTank, setAddingTank] = useState(false);
  const nextFreeSlot = state.tankSlots?.find((s) => !s.enabled);

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 6000);
    return () => clearTimeout(t);
  }, [feedback]);

  const run = async (key: string, label: string, fn: (() => CommandResult) | undefined) => {
    if (!fn) return;
    setBusy(key);
    try {
      const error = await fn();
      setFeedback(error ? { ok: false, message: error, at: Date.now() } : { ok: true, message: `${label} sent`, at: Date.now() });
    } finally {
      setBusy(null);
    }
  };

  /** Why a remote command is unavailable right now (null = allowed). */
  const why = (command: SafetyCommand) => refusal(safety, command, "remote");
  const localWhy = (command: SafetyCommand) => refusal(safety, command, "local");

  return (
    <main className="mx-auto w-full max-w-[1100px] flex-1 space-y-4 px-3 py-4 sm:px-6">
      {feedback && (
        <Alert variant={feedback.ok ? "default" : "destructive"}>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      )}

      {/* ---------------- Emergency stop ---------------- */}
      <Card className={safety?.eStopActive ? "border-2 border-red-500" : ""}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <OctagonX className="h-4 w-4 text-red-500" /> E-Stop
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => run("estop", "Digital E-Stop", commands?.eStop)}
              disabled={!commands || safety?.digitalEStop || busy === "estop"}
              className="flex h-20 w-full items-center justify-center gap-3 rounded-xl border-4 border-red-950 bg-red-800 text-xl font-black tracking-widest text-white shadow-lg transition-colors hover:bg-red-700 active:bg-red-950 disabled:cursor-not-allowed disabled:opacity-80"
            >
              <OctagonX className="h-8 w-8" />
              {safety?.digitalEStop ? "LATCHED" : "E-STOP"}
            </button>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => run("release", "Release digital E-Stop", commands?.releaseEStop)}
                disabled={!commands || !!why("releaseEStop") || busy === "release"}
                title={why("releaseEStop") ?? undefined}
              >
                <Unlock className="h-4 w-4" /> Release
              </Button>
              <Button
                variant="default"
                onClick={() => run("reset", "Safety reset", commands?.reset)}
                disabled={!commands || !safety?.resetRequired || !!why("reset") || busy === "reset"}
                title={why("reset") ?? undefined}
              >
                <RotateCcw className="h-4 w-4" /> Reset
              </Button>
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <StatusRow label="Safety" ok={!!safety?.safetyCircuitOk} okText="CLOSED" badText="OPEN" />
            <StatusRow label="Digital" ok={!safety?.digitalEStop} okText="OFF" badText="LATCHED" />
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Physical</div>
              <ul className="space-y-1">
                {(safety?.eStopButtons ?? []).map((b) => (
                  <li key={b.id} className="flex items-center gap-2">
                    <CircleDot className={`h-4 w-4 ${b.pressed ? "animate-pulse text-red-500" : "text-emerald-500"}`} />
                    <span className="flex-1">{b.name}</span>
                    <span className={`font-mono text-xs ${b.pressed ? "font-bold text-red-800" : "text-muted-foreground"}`}>
                      {b.pressed ? "PRESSED" : "OK"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* ---------------- Run control ---------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Play className="h-4 w-4" /> Run control
              </span>
              {safety && (
                <Badge variant={safety.running ? "default" : "secondary"}>{safety.running ? "RUNNING" : "STOPPED"}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                onClick={() => run("start", "Start", commands?.start)}
                disabled={!commands || !!why("start") || !!safety?.running || busy === "start"}
                title={why("start") ?? undefined}
              >
                <Play className="h-4 w-4" /> Start
              </Button>
              <Button
                className="bg-zinc-900 text-white hover:bg-zinc-800"
                onClick={() => run("stop", "Stop", commands?.stop)}
                disabled={!commands || busy === "stop"}
              >
                <Square className="h-4 w-4" /> Stop
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ---------------- Motion ---------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4" /> Motion
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => run("jog", "Jog", commands?.jogBelt)}
                disabled={!commands || !!why("jog") || busy === "jog"}
                title={why("jog") ?? undefined}
              >
                <Play className="h-4 w-4" /> Jog
              </Button>
              <Button
                variant="secondary"
                onClick={() => run("pusher", "Fire reject diverter", commands?.firePusher)}
                disabled={!commands || !!why("firePusher") || busy === "pusher"}
                title={why("firePusher") ?? undefined}
              >
                <ArrowLeftRight className="h-4 w-4" /> Reject
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ---------------- Tanks ---------------- */}
        <Card className="md:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4" /> Tank Modules
              </CardTitle>
            </div>
            <Button
              variant="default"
              onClick={() => (nextFreeSlot ? setAddingTank(true) : run("add", "Add tank", commands ? () => commands.addTank() : undefined))}
              disabled={!commands || !!why("tankChange") || busy === "add" || addingTank || (state.tankSlots !== undefined && !nextFreeSlot)}
              title={state.tankSlots !== undefined && !nextFreeSlot ? "All tank slots are on the line" : undefined}
            >
              <PlusCircle className="h-4 w-4" /> Add tank
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {addingTank && nextFreeSlot && commands && (
              <AddTankForm key={nextFreeSlot.id} slot={nextFreeSlot} commands={commands} run={run} onDone={() => setAddingTank(false)} />
            )}
            {state.tanks.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {state.tanks.map((t, i) => {
                  const ratio = t.levelMl / t.capacityMl;
                  const low = tankIsLow(t);
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
                            {ml(t.levelMl)}/{t.capacityMl} ml · {pct(ratio)}
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
                        onClick={() => run(`remove-${t.id}`, `Remove ${t.name}`, commands ? () => commands.removeTank(t.id) : undefined)}
                        disabled={!commands || state.tanks.length <= 1 || !!why("tankChange")}
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

        {/* ---------------- Tank colors ---------------- */}
        {state.tankSlots && <TankColorsCard slots={state.tankSlots} commands={commands} run={run} />}

        {/* ---------------- Simulated local control panel ---------------- */}
        {safety?.simulated && commands?.sim && (
          <Card className="border-dashed md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MonitorCog className="h-4 w-4" /> Local control panel &amp; field E-Stops
                <Badge variant="outline" className="text-[10px]">SIMULATION</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Key switch</div>
                <div className="flex gap-2">
                  {(["remote", "local"] as const).map((mode) => (
                    <Button
                      key={mode}
                      variant={safety.controlMode === mode ? "default" : "outline"}
                      size="sm"
                      onClick={() => run(`mode-${mode}`, `Key switch ${mode.toUpperCase()}`, () => commands.sim!.setControlMode(mode))}
                    >
                      <KeyRound className="h-3.5 w-3.5" /> {mode.toUpperCase()}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Panel</div>
                <div className="flex flex-wrap gap-2">
                  <PanelButton color="bg-emerald-800 hover:bg-emerald-700" label="START" icon={<Play className="h-3.5 w-3.5" />} reason={localWhy("start")} onClick={() => run("local-start", "Local START", () => commands.sim!.pressLocalButton("start"))} />
                  <PanelButton color="bg-zinc-700 hover:bg-zinc-600" label="STOP" icon={<Square className="h-3.5 w-3.5" />} reason={null} onClick={() => run("local-stop", "Local STOP", () => commands.sim!.pressLocalButton("stop"))} />
                  <PanelButton color="bg-blue-900 hover:bg-blue-800" label="RESET" icon={<ShieldCheck className="h-3.5 w-3.5" />} reason={localWhy("reset")} onClick={() => run("local-reset", "Local RESET", () => commands.sim!.pressLocalButton("reset"))} />
                  <PanelButton color="bg-amber-800 hover:bg-amber-700" label="JOG" icon={<Play className="h-3.5 w-3.5" />} reason={localWhy("jog")} onClick={() => run("local-jog", "Local JOG", () => commands.sim!.pressLocalButton("jog"))} />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">E-Stop</div>
                <ul className="space-y-1.5">
                  {safety.eStopButtons.map((b) => (
                    <li key={b.id} className="flex items-center justify-between gap-2">
                      <span className="text-sm">{b.name}</span>
                      <button
                        type="button"
                        onClick={() => run(`pe-${b.id}`, `${b.pressed ? "Release" : "Press"} E-Stop at ${b.name}`, () => commands.sim!.setPhysicalEStop(b.id, !b.pressed))}
                        className={`h-8 rounded-full border-2 px-3 text-xs font-bold ${
                          b.pressed
                            ? "border-red-300 bg-red-700 text-white shadow-inner"
                            : "border-red-800 bg-red-600 text-white hover:bg-red-500"
                        }`}
                      >
                        {b.pressed ? "RELEASE" : "PRESS"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}

function StatusRow({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`font-mono text-xs font-semibold ${ok ? "text-emerald-800" : "text-red-800"}`}>{ok ? okText : badText}</span>
    </div>
  );
}

function PanelButton({
  color,
  label,
  icon,
  reason,
  onClick,
}: {
  color: string;
  label: string;
  icon: React.ReactNode;
  reason: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={reason ?? undefined}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-bold text-white ${color} ${reason ? "opacity-60" : ""}`}
    >
      {icon} {label}
    </button>
  );
}
