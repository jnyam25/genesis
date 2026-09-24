"use client";

import { useContainerPositions } from "@/lib/twin/useContainerPositions";
import type { Container, Tank, TwinState } from "@/lib/twin/types";
import { stationForStatus, type LineLayout, type StationPosition } from "@/lib/twin/layout";

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
  if (c.status === "scan-rejected") return "#fb923c";
  if (c.status === "rejected") return "#7f1d1d";
  const m = /^fill-(\d+)$/.exec(c.status);
  if (m) {
    const idx = parseInt(m[1], 10) - 1;
    return tanks[idx]?.colorCode ?? "#9ca3af";
  }
  if (c.fillMl <= 0) return "#cbd5e1";
  return mixedColor(tanks);
}

const LANE_LETTER = ["A", "B"];

const SCALE = 95;
const MARGIN = 48;
/** Tank body half-height (line units) around `layout.tankY`. */
const TANK_HALF_HEIGHT = 0.9;
/** Room above the tank bodies for the "TANK n" and name labels (px). */
const TANK_LABEL_SPACE = 34;
const TOP_PAD = TANK_HALF_HEIGHT * SCALE + TANK_LABEL_SPACE;

function svgX(lineX: number, layout: LineLayout): number {
  return MARGIN + (lineX - layout.spanX[0]) * SCALE;
}
function svgY(lineY: number, layout: LineLayout): number {
  const originY = TOP_PAD + layout.tankY * SCALE;
  return originY - lineY * SCALE;
}

export function LineSchematic({ state }: { state: TwinState }) {
  const { layout, positions } = useContainerPositions(state);
  const tanks = state.tanks;

  const width = MARGIN * 2 + (layout.spanX[1] - layout.spanX[0]) * SCALE;
  const height = TOP_PAD + MARGIN + (layout.tankY + Math.abs(layout.rejectY)) * SCALE;

  const activeStationIds = new Set<string>();
  for (const c of state.containers) activeStationIds.add(stationForStatus(c, layout).id);
  const rejecting = state.containers.some((c) => c.status === "rejected" || c.status === "scan-rejected");
  const sortingLane = state.containers.find((c) => c.status === "sort")?.lane;
  const gateStation = layout.stations.find((s) => s.kind === "gate")!;
  const sortStation = layout.stations.find((s) => s.kind === "sort")!;
  const laneBStation = layout.stations.find((s) => s.kind === "output" && s.lane === 1)!;

  const stationText = (s: StationPosition): { label?: string; sub?: string } => {
    if (s.kind === "nozzle") return { sub: s.id.replace("nozzle-", "") };
    if (s.kind === "sort" && sortingLane !== undefined) return { sub: `→ Lane ${LANE_LETTER[sortingLane] ?? sortingLane}` };
    if (s.kind === "output" && s.lane !== undefined) {
      const lane = state.sortLanes?.[s.lane];
      if (lane) return { label: lane.name, sub: `${lane.count} accepted` };
    }
    return {};
  };

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

        {/* Lane B branch (sort diverter actuated); drawn under the main belt */}
        {[layout.beltHalfHeight * 2 * SCALE + 2, layout.beltHalfHeight * 2 * SCALE].map((w, i) => (
          <polyline
            key={i}
            points={[
              [sortStation.x, 0],
              [laneBStation.x - 0.5, laneBStation.y],
              [layout.spanX[1], laneBStation.y],
            ]
              .map(([x, y]) => `${svgX(x, layout)},${svgY(y, layout)}`)
              .join(" ")}
            fill="none"
            stroke={i === 0 ? "#334155" : "#111827"}
            strokeWidth={w}
            strokeLinejoin="round"
          />
        ))}

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

        {/* Reject lane (off the reject diverter) */}
        <rect
          x={svgX(gateStation.x, layout) - 14}
          y={svgY(0, layout)}
          width={28}
          height={Math.abs(layout.rejectY) * SCALE}
          rx={6}
          fill="#1c0f12"
          stroke="#7f1d1d"
        />
        {/* Reject diverter */}
        <g>
          <rect
            x={svgX(gateStation.x, layout) - 18}
            y={svgY(-0.4, layout)}
            width={36}
            height={10}
            rx={3}
            fill="#f59e0b"
            opacity={rejecting ? 1 : 0.7}
          />
          <text
            x={svgX(gateStation.x, layout)}
            y={svgY(-0.55, layout)}
            textAnchor="middle"
            className="fill-amber-300 font-mono"
            fontSize={9}
          >
            DIVERTER
          </text>
        </g>

        {/* Flow direction arrows (Lane A and Lane B) */}
        {[0, laneBStation.y].map((y) => (
          <line
            key={y}
            x1={svgX(layout.spanX[1] - 0.2, layout)}
            y1={svgY(y, layout)}
            x2={svgX(layout.spanX[1], layout)}
            y2={svgY(y, layout)}
            stroke="#64748b"
            strokeWidth={2}
            markerEnd="url(#arrow)"
          />
        ))}

        {layout.stations.map((s) => (
          <StationGlyph
            key={s.id}
            station={s}
            layout={layout}
            active={activeStationIds.has(s.id)}
            flagged={s.kind === "gate" && rejecting}
            {...stationText(s)}
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
              yTop={svgY(layout.tankY + TANK_HALF_HEIGHT, layout)}
              yBottom={svgY(layout.tankY - TANK_HALF_HEIGHT, layout)}
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
              {c.status === "scan-rejected" && (
                <text x={cx} y={cy - 17} textAnchor="middle" className="fill-orange-300 font-mono" fontSize={7}>
                  BAD BARCODE
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StationGlyph({
  station, layout, active, flagged, label, sub,
}: {
  station: StationPosition;
  layout: LineLayout;
  active: boolean;
  flagged: boolean;
  label?: string;
  sub?: string;
}) {
  const cx = svgX(station.x, layout);
  const cy = svgY(station.y, layout);
  const isLane = station.kind === "reject";
  const color = flagged
    ? "#7f1d1d"
    : active
      ? "#22c55e"
      : "#475569";

  return (
    <g>
      {!isLane ? (
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
          strokeWidth={active ? 2.5 : 1.5}
        />
      )}

      <text x={cx} y={cy + 5} textAnchor="middle" fontSize={GLYPHS[station.kind].size} className={flagged ? "fill-rose-400" : GLYPHS[station.kind].className}>
        {station.kind === "output" ? `${LANE_LETTER[station.lane ?? 0]} ▶` : GLYPHS[station.kind].glyph}
      </text>

      <LabelCallout
        x={cx}
        y={isLane ? cy + 30 : cy - 26}
        text={label ?? station.label}
        sub={sub}
      />
    </g>
  );
}

const GLYPHS: Record<StationPosition["kind"], { glyph: string; size: number; className: string }> = {
  label: { glyph: "✎", size: 14, className: "fill-violet-300" },
  scan: { glyph: "⌖", size: 14, className: "fill-sky-300" },
  nozzle: { glyph: "▼", size: 14, className: "fill-slate-200" },
  cap: { glyph: "◓", size: 14, className: "fill-teal-300" },
  press: { glyph: "⇊", size: 14, className: "fill-indigo-300" },
  qc: { glyph: "✓", size: 13, className: "fill-emerald-300" },
  gate: { glyph: "↧", size: 14, className: "fill-amber-300" },
  sort: { glyph: "⇉", size: 14, className: "fill-amber-300" },
  output: { glyph: "▶", size: 12, className: "fill-emerald-300" },
  reject: { glyph: "✕", size: 14, className: "fill-rose-400" },
};

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
