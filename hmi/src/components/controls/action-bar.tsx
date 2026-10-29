"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, Play, RotateCcw, Square, Unlock } from "lucide-react";
import { useTwin } from "@/lib/twin/twin-context";
import { refusal, type SafetyCommand } from "@/lib/twin/safety";
import type { CommandResult } from "@/lib/twin/types";

/** Start, stop, jog, reject, and reset. Shown on every screen. */
export function ActionBar() {
  const { state, commands, loading } = useTwin();
  const safety = state.safety;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  if (loading || !commands || !safety) return null;

  const why = (command: SafetyCommand) => refusal(safety, command, "remote");

  const run = async (key: string, label: string, fn: () => CommandResult) => {
    setBusy(key);
    try {
      setNote((await fn()) ?? label);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-3 pt-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Action
          label="Start"
          icon={<Play className="h-4 w-4" />}
          className="bg-emerald-800 text-white hover:bg-emerald-700"
          disabled={!!why("start") || safety.running || busy === "start"}
          title={why("start") ?? undefined}
          onClick={() => run("start", "Start", commands.start)}
        />
        <Action
          label="Stop"
          icon={<Square className="h-4 w-4" />}
          className="bg-zinc-900 text-white hover:bg-zinc-800"
          disabled={busy === "stop"}
          onClick={() => run("stop", "Stop", commands.stop)}
        />
        <Action
          label="Jog"
          icon={<Play className="h-4 w-4" />}
          className="bg-sky-900 text-white hover:bg-sky-800"
          disabled={!!why("jog") || busy === "jog"}
          title={why("jog") ?? undefined}
          onClick={() => run("jog", "Jog", commands.jogBelt)}
        />
        <Action
          label="Reject"
          icon={<ArrowLeftRight className="h-4 w-4" />}
          className="bg-amber-800 text-white hover:bg-amber-700"
          disabled={!!why("firePusher") || busy === "reject"}
          title={why("firePusher") ?? undefined}
          onClick={() => run("reject", "Reject", commands.firePusher)}
        />
        <Action
          label="Reset"
          icon={<RotateCcw className="h-4 w-4" />}
          className="bg-blue-900 text-white hover:bg-blue-800"
          disabled={!safety.resetRequired || !!why("reset") || busy === "reset"}
          title={why("reset") ?? undefined}
          onClick={() => run("reset", "Reset", commands.reset)}
        />
        {safety.digitalEStop && (
          <Action
            label="Release"
            icon={<Unlock className="h-4 w-4" />}
            className="bg-red-700 text-white hover:bg-red-600"
            disabled={!!why("releaseEStop") || busy === "release"}
            title={why("releaseEStop") ?? undefined}
            onClick={() => run("release", "Release", commands.releaseEStop)}
          />
        )}
        <span className={`ml-auto font-mono text-xs font-bold tracking-wide ${safety.running ? "text-emerald-800" : "text-foreground"}`}>
          {safety.running ? "RUNNING" : "STOPPED"}
        </span>
      </div>
      {note && <p className="mt-1 font-mono text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function Action({
  label,
  icon,
  className,
  disabled,
  title,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  className: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-11 min-w-24 items-center justify-center gap-2 rounded-md px-4 text-sm font-bold tracking-wide disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-800 disabled:opacity-100 ${className}`}
    >
      {icon}
      {label}
    </button>
  );
}
