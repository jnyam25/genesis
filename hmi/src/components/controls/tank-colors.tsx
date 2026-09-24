"use client";

import { useState } from "react";
import { Check, Palette, Pencil, PlusCircle, RotateCcw, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PRESET_COLORS, isHexColor, validateTankColor } from "@/lib/twin/tank-colors";
import { TANK_NAME_MAX_LENGTH, type CommandResult, type TankColor, type TankSlot, type TwinCommands } from "@/lib/twin/types";

/** The Controls page's command runner (shows feedback, tracks busy state). */
export type RunCommand = (key: string, label: string, fn: (() => CommandResult) | undefined) => Promise<void>;

const INPUT =
  "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive";

/** Name, color picker, hex field and preset swatches for one tank. */
function ColorFields({ value, onChange, idPrefix }: { value: TankColor; onChange: (v: TankColor) => void; idPrefix: string }) {
  const [hex, setHex] = useState(value.colorCode);
  const setColor = (colorCode: string) => {
    setHex(colorCode);
    onChange({ ...value, colorCode: colorCode.toUpperCase() });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="Pick a color"
          value={isHexColor(value.colorCode) ? value.colorCode.toLowerCase() : "#000000"}
          onChange={(e) => setColor(e.target.value)}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
        />
        <input
          id={`${idPrefix}-name`}
          aria-label="Tank name"
          value={value.name}
          maxLength={TANK_NAME_MAX_LENGTH}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          aria-invalid={value.name.trim().length === 0}
          placeholder="Tank name"
          className={INPUT}
        />
        <input
          aria-label="Hex color"
          value={hex}
          onChange={(e) => {
            const next = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
            setHex(next);
            if (isHexColor(next)) onChange({ ...value, colorCode: next.toUpperCase() });
          }}
          aria-invalid={!isHexColor(hex)}
          maxLength={7}
          className={`${INPUT} w-24 shrink-0 font-mono uppercase`}
        />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preset colors">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={`Use ${c}`}
            onClick={() => setColor(c)}
            className={`h-7 w-7 rounded-full border-2 ${value.colorCode.toUpperCase() === c ? "border-white" : "border-white/20"}`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
    </div>
  );
}

/** Add-tank form: the next free slot, prefilled with its saved name/color. */
export function AddTankForm({
  slot,
  commands,
  run,
  onDone,
}: {
  slot: TankSlot;
  commands: TwinCommands;
  run: RunCommand;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<TankColor>({ name: slot.name, colorCode: slot.colorCode });
  const valid = "patch" in validateTankColor(draft);
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="text-sm font-medium">
        Add tank <span className="font-mono text-muted-foreground">{slot.id}</span>
      </div>
      <ColorFields value={draft} onChange={setDraft} idPrefix={`add-${slot.id}`} />
      <div className="flex gap-2">
        <Button
          disabled={!valid}
          onClick={async () => {
            await run("add", `Add tank ${draft.name.trim()}`, () => commands.addTank(draft));
            onDone();
          }}
        >
          <PlusCircle className="h-4 w-4" /> Add to line
        </Button>
        <Button variant="ghost" onClick={onDone}>
          <X className="h-4 w-4" /> Cancel
        </Button>
      </div>
    </div>
  );
}

/** Rename/recolor every tank slot, including spare ones. */
export function TankColorsCard({ slots, commands, run }: { slots: TankSlot[]; commands: TwinCommands | undefined; run: RunCommand }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<TankColor>({ name: "", colorCode: "#000000" });
  const anyCustom = slots.some((s) => s.custom);

  const startEdit = (s: TankSlot) => {
    setDraft({ name: s.name, colorCode: s.colorCode });
    setEditing(s.id);
  };

  return (
    <Card className="md:col-span-2">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-4 w-4" /> Tank colors
          </CardTitle>
          <CardDescription>
            Name and color each tank slot, including spare slots for tanks you add later. Changes show on every screen
            right away and are saved. They only change what the HMI displays, so they&apos;re allowed at any time.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!commands || !anyCustom}
          onClick={() => run("colors-reset-all", "Reset all tank colors", commands ? () => commands.resetTankColor() : undefined)}
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset all
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {slots.map((s) => {
            const isEditing = editing === s.id;
            const valid = "patch" in validateTankColor(draft);
            return (
              <li key={s.id} className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
                {isEditing ? (
                  <div className="space-y-2">
                    <div className="font-mono text-xs text-muted-foreground">{s.id}</div>
                    <ColorFields value={draft} onChange={setDraft} idPrefix={`edit-${s.id}`} />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={!commands || !valid}
                        onClick={async () => {
                          await run(`color-${s.id}`, `${s.id} saved as ${draft.name.trim()}`, commands ? () => commands.setTankColor(s.id, draft) : undefined);
                          setEditing(null);
                        }}
                      >
                        <Check className="h-3.5 w-3.5" /> Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        <X className="h-3.5 w-3.5" /> Cancel
                      </Button>
                      {s.custom && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await run(`color-reset-${s.id}`, `${s.id} reset to default`, commands ? () => commands.resetTankColor(s.id) : undefined);
                            setEditing(null);
                          }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> Default
                        </Button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-6 w-6 shrink-0 rounded-md border border-white/20" style={{ backgroundColor: s.colorCode }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{s.name}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {s.id} · {s.colorCode}
                      </div>
                    </div>
                    <Badge variant={s.enabled ? "default" : "outline"} className="text-[10px]">
                      {s.enabled ? "ON LINE" : "SPARE"}
                    </Badge>
                    {s.custom && (
                      <Badge variant="secondary" className="text-[10px]">
                        EDITED
                      </Badge>
                    )}
                    <Button size="sm" variant="ghost" disabled={!commands} onClick={() => startEdit(s)} aria-label={`Edit ${s.id}`}>
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
