"use client";

import { useContainerPositions } from "@/lib/twin/useContainerPositions";
import type { Container, Tank, TwinState } from "@/lib/twin/types";
import type { LineLayout, StationPosition } from "@/lib/twin/layout";

function parseHex(h: string): { r: number; g: number; b: number } {
  const s = h.replace("#", "");
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}
function toHex(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
}
function blend(hexes: string[]): string {
  let r = 0, g = 0, b = 0;
  for (const h of hexes) {
    const c = parseHex(h);
    r += c.r; g += c.g; b += c.b;
  }
  const n = hexes.length;
  return `#${toHex(r / n)}${toHex(g / n)}${toHex(b / n)}`;
}
function mixedColor(tanks: Tank[]): string {
  return tanks.length ? blend(tanks.map((t) => t.colorCode)) : "#9ca3af";
}
export function containerColor(c: Container, tanks: Tank[]): string {
  if (c.status === "scan" || c.status === "idle") return "#cbd5e1";
  if (c.status === "rejected") return "#7f1d1d";
  const m = /^fill-(\d+)$/.exec(c.status);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    return tanks[idx]?.colorCode ?? "#9ca3af";
  }
  return mixedColor(tanks);
}

const SCALE = 95;
const MARGIN = 48;

function svgX(lineX: number, layout: LineLayout): number {
  return MARGIN + (lineX - layout.spanX[0]) * SCALE;
}
function svgY(lineY: number, layout: LineLayout): number {
  const originY = MARGIN + layout.tankY * SCALE;
  return originY - lineY * SCALE;
}

function statusMatchesStation(status: Container["status"], s: StationPosition): boolean {
  if (status === s.kind) return true;
  const m = /^fill-(\d+)$/.exec(status);
  if (m && s.kind === "nozzle") {
    return s.id === `nozzle-tank-${m[1]}`;
  }
  return false;
}

export function LineSchematic({ state }: { state: TwinState }) {
  const { layout, positions } = useContainerPositions(state);
  const tanks = state.tanks;

  const width = MARGIN * 2 + (layout.spanX[1] - layout.spanX[0]) * SCALE;
  const height = MARGIN * 2 + (layout.tankY + Math.abs(layout.rejectY)) * SCALE;

  const activeStationIds = new Set<string>();
  for (const c of state.containers) {
    const st = layout.stations.find((s) => statusMatchesStation(c.status, s));
    if (st) activeStationIds.add(st.id);
  }
  const qcFlagged = state.containers.some((c) => c.status === "rejected");
  const qcStation = layout.stations.find((s) => s.kind === "qc")!;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full min-w-[760px]"
        role="img"
        aria-label="2D schematic of the Captsone paint mixing line"
      >
        <defs>
          <linearGradient id="belt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1f2937" />
            <stop offset="50%" stopColor="#111827" />
            <stop offset="100%" stopColor="#1f2937" />
          </linearGradient>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
          </marker>
        </defs>

        {/* Main conveyor belt */}
        <rect
          x={svgX(layout.spanX[0], layout)}
          y={svgY(layout.beltHalfHeight, layout)}
          width={(layout.spanX[1] - layout.spanX[0]) * SCALE}
          height={layout.beltHalfHeight * 2 * SCALE}
          rx={8}
          fill="url(#belt)"
          stroke="#334155"
        />
        {Array.from({ length: Math.floor((layout.spanX[1] - layout.spanX[0]) * 4) }).map((_, i) => (
          <line
            key={i}
            x1={svgX(layout.spanX[0] + i / 4, layout)}
            y1={svgY(layout.beltHalfHeight, layout)}
            x2={svgX(layout.spanX[0] + i / 4, layout)}
            y2={svgY(-layout.beltHalfHeight, layout)}
            stroke="#0b1220"
            strokeWidth={1}
            opacity={0.5}
          />
        ))}

        {/* Reject lane */}
        <rect
          x={svgX(qcStation.x, layout) - 14}
          y={svgY(0, layout)}
          width={28}
          height={Math.abs(layout.rejectY) * SCALE}
          rx={6}
          fill="#1c0f12"
          stroke="#7f1d1d"
        />
        {/* Pusher */}
        <g>
          <rect
            x={svgX(qcStation.x, layout) - 18}
            y={svgY(-0.4, layout)}
            width={36}
            height={10}
            rx={3}
            fill="#f59e0b"
          />
          <text
            x={svgX(qcStation.x, layout)}
            y={svgY(-0.55, layout)}
            textAnchor="middle"
            className="fill-amber-300 font-mono"
            fontSize={9}
          >
            PUSHER
          </text>
        </g>

        {/* Flow direction arrow */}
        <line
          x1={svgX(layout.spanX[1] - 0.2, layout)}
          y1={svgY(0, layout)}
          x2={svgX(layout.spanX[1], layout)}
          y2={svgY(0, layout)}
          stroke="#64748b"
          strokeWidth={2}
          markerEnd="url(#arrow)"
        />

        {layout.stations.map((s) => (
          <StationGlyph
            key={s.id}
            station={s}
            layout={layout}
            active={activeStationIds.has(s.id)}
            qcFlagged={s.kind === "qc" && qcFlagged}
          />
        ))}

        {tanks.map((tank, i) => {
          const nozzle = layout.stations.find((s) => s.kind === "nozzle" && s.tankId === tank.id);
          if (!nozzle) return null;
          return (
            <TankGlyph
              key={tank.id}
              tank={tank}
              index={i}
              x={svgX(nozzle.x, layout)}
              yTop={svgY(layout.tankY + 0.9, layout)}
              yBottom={svgY(layout.tankY - 0.9, layout)}
              nozzleX={svgX(nozzle.x, layout)}
              nozzleY={svgY(layout.beltHalfHeight, layout)}
            />
          );
        })}

        {positions.map((p) => {
          const c = state.containers.find((x) => x.id === p.id);
          if (!c) return null;
          const color = containerColor(c, tanks);
          const fillRatio = c.targetMl > 0 ? c.fillMl / c.targetMl : 0;
          const cx = svgX(p.x, layout);
          const cy = svgY(p.y, layout);
          return (
            <g key={p.id}>
              <circle cx={cx} cy={cy} r={13} fill={color} stroke="#0b1220" strokeWidth={1.5} />
              <circle
                cx={cx}
                cy={cy}
                r={13}
                fill="none"
                stroke="#e2e8f0"
                strokeWidth={1.5}
                strokeDasharray={`${fillRatio * 82} 82`}
                transform={`rotate(-90 ${cx} ${cy})`}
                opacity={0.8}
              />
              <text x={cx} y={cy + 3} textAnchor="middle" className="fill-black/70 font-mono" fontSize={7}>
                {p.id.replace("C-", "")}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StationGlyph({
  station, layout, active, qcFlagged,
}: {
  station: StationPosition;
  layout: LineLayout;
  active: boolean;
  qcFlagged: boolean;
}) {
  const cx = svgX(station.x, layout);
  const cy = svgY(station.y, layout);
  const isReject = station.kind === "reject";
  const isNozzle = station.kind === "nozzle";
  const isScan = station.kind === "scan";
  const color = qcFlagged ? "#7f1d1d" : active ? "#22c55e" : "#475569";

  return (
    <g>
      {!isReject ? (
        <rect
          x={cx - 26}
          y={cy - 16}
          width={52}
          height={32}
          rx={6}
          fill={active ? "#14532d" : "#0f172a"}
          stroke={color}
          strokeWidth={active ? 2.5 : 1.5}
        />
      ) : (
        <rect
          x={cx - 30}
          y={cy - 14}
          width={60}
          height={28}
          rx={6}
          fill="#1c0f12"
          stroke="#7f1d1d"
          strokeWidth={1.5}
        />
      )}

      {isScan && <text x={cx} y={cy + 4} textAnchor="middle" fontSize={14} className="fill-sky-300">⌖</text>}
      {isNozzle && <text x={cx} y={cy + 5} textAnchor="middle" fontSize={14} className="fill-slate-200">▼</text>}
      {station.kind === "mix" && <text x={cx} y={cy + 5} textAnchor="middle" fontSize={15} className="fill-violet-300">⟳</text>}
      {station.kind === "qc" && (
        <text x={cx} y={cy + 5} textAnchor="middle" fontSize={13} className={qcFlagged ? "fill-rose-400" : "fill-emerald-300"}>✓</text>
      )}
      {station.kind === "output" && <text x={cx} y={cy + 5} textAnchor="middle" fontSize={14} className="fill-emerald-300">▶</text>}
      {isReject && <text x={cx} y={cy + 5} textAnchor="middle" fontSize={14} className="fill-rose-400">✕</text>}

      <LabelCallout
        x={cx}
        y={isReject ? cy + 30 : cy - 26}
        text={station.label}
        sub={isNozzle ? station.id.replace("nozzle-", "") : undefined}
      />
    </g>
  );
}

function LabelCallout({ x, y, text, sub }: { x: number; y: number; text: string; sub?: string }) {
  return (
    <g>
      <text x={x} y={y} textAnchor="middle" className="fill-slate-200 font-sans" fontSize={11} fontWeight={600}>
        {text}
      </text>
      {sub && (
        <text x={x} y={y + 12} textAnchor="middle" className="fill-slate-400 font-mono" fontSize={9}>
          {sub}
        </text>
      )}
    </g>
  );
}

function TankGlyph({
  tank, index, x, yTop, yBottom, nozzleX, nozzleY,
}: {
  tank: Tank;
  index: number;
  x: number;
  yTop: number;
  yBottom: number;
  nozzleX: number;
  nozzleY: number;
}) {
  const ratio = Math.max(0, Math.min(1, tank.levelMl / tank.capacityMl));
  const tankHeight = yBottom - yTop;
  const fillH = tankHeight * ratio;
  const low = ratio < 0.15;
  const crit = ratio < 0.3 && !low;

  return (
    <g>
      <line x1={x} y1={yBottom} x2={nozzleX} y2={nozzleY} stroke="#334155" strokeWidth={3} />
      <rect x={x - 22} y={yTop} width={44} height={tankHeight} rx={6} fill="#0b1220" stroke="#334155" strokeWidth={1.5} />
      <rect
        x={x - 20}
        y={yBottom - fillH}
        width={40}
        height={fillH}
        rx={4}
        fill={tank.colorCode}
        opacity={0.9}
      />
      <rect x={x - 22} y={yTop} width={44} height={tankHeight} rx={6} fill="none" stroke={crit ? "#f59e0b" : low ? "#ef4444" : "#334155"} strokeWidth={low || crit ? 2 : 1.5} />
      <text x={x} y={yTop - 8} textAnchor="middle" className="fill-slate-100 font-sans" fontSize={11} fontWeight={600}>
        {tank.name}
      </text>
      <text x={x} y={yTop - 20} textAnchor="middle" className="fill-slate-400 font-mono" fontSize={9}>
        TANK {index + 1}
      </text>
      <text x={x} y={yBottom + 14} textAnchor="middle" className="fill-slate-300 font-mono" fontSize={9}>
        {Math.round(ratio * 100)}%
      </text>
    </g>
  );
}
