"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useRef, useMemo } from "react";
import * as THREE from "three";
import { useContainerPositions } from "@/lib/twin/useContainerPositions";
import { containerColor } from "@/components/schematic/line-schematic";
import type { Container, Tank, TwinState } from "@/lib/twin/types";
import { stationForStatus, type StationPosition } from "@/lib/twin/layout";

const BELT_Y = 0;
const BELT_HALF_H = 0.22;
const TANK_RADIUS = 0.34;
const TANK_HEIGHT = 1.2;
const CONTAINER_R = 0.18;
const CONTAINER_H = 0.32;

export function LineScene({ state }: { state: TwinState }) {
  return (
    <div className="h-[520px] w-full rounded-lg border border-border/60 bg-gradient-to-b from-slate-950 to-slate-900">
      <Canvas camera={{ position: [6, 5, 8], fov: 50 }} dpr={[1, 2]}>
        <ambientLight intensity={0.55} />
        <directionalLight position={[6, 8, 4]} intensity={1.1} castShadow />
        <directionalLight position={[-6, 4, -4]} intensity={0.35} />
        <SceneContents state={state} />
        <OrbitControls
          enablePan
          minDistance={3}
          maxDistance={20}
          maxPolarAngle={Math.PI / 2.05}
          target={[6, 0, 0]}
        />
        <gridHelper args={[40, 40, "#1e293b", "#0f172a"]} position={[0, -0.6, 0]} />
      </Canvas>
    </div>
  );
}

function SceneContents({ state }: { state: TwinState }) {
  const { layout, positions } = useContainerPositions(state);
  const station = (kind: StationPosition["kind"]) => layout.stations.find((s) => s.kind === kind)!;
  const labelStation = station("label");
  const capStation = station("cap");
  const gateStation = station("gate");
  const sortStation = station("sort");
  const laneBStation = layout.stations.find((s) => s.kind === "output" && s.lane === 1)!;

  const activeStationIds = new Set<string>();
  for (const c of state.containers) activeStationIds.add(stationForStatus(c, layout).id);
  const rejecting = state.containers.some((c) => c.status === "rejected" || c.status === "scan-rejected");
  const sortingToB = state.containers.some((c) => c.status === "sort" && c.lane === 1);

  const stationText = (s: StationPosition): { label?: string; sub?: string } => {
    if (s.kind === "nozzle") return { sub: s.id.replace("nozzle-", "") };
    const lane = s.kind === "output" && s.lane !== undefined ? state.sortLanes?.[s.lane] : undefined;
    return lane ? { label: lane.name, sub: String(lane.count) } : {};
  };

  const branchStartX = sortStation.x;
  const branchEndX = laneBStation.x - 0.5;
  const branchLen = Math.hypot(branchEndX - branchStartX, laneBStation.y);
  const branchAngle = -Math.atan2(laneBStation.y, branchEndX - branchStartX);

  return (
    <group>
      {/* Conveyor belt */}
      <mesh position={[(layout.spanX[0] + layout.spanX[1]) / 2, BELT_Y, 0]} receiveShadow>
        <boxGeometry args={[layout.spanX[1] - layout.spanX[0], BELT_HALF_H * 2, 1.1]} />
        <meshStandardMaterial color="#1f2937" metalness={0.3} roughness={0.7} />
      </mesh>
      {/* Belt edge stripes */}
      {Array.from({ length: Math.floor((layout.spanX[1] - layout.spanX[0]) * 2) }).map((_, i) => (
        <mesh key={i} position={[layout.spanX[0] + i / 2 + 0.25, BELT_Y + BELT_HALF_H + 0.01, 0]}>
          <boxGeometry args={[0.04, 0.02, 1.0]} />
          <meshStandardMaterial color="#0b1220" />
        </mesh>
      ))}

      {/* Reject lane (off the reject diverter) */}
      <mesh position={[gateStation.x, BELT_Y, layout.rejectY * 0.5 - 0.1]}>
        <boxGeometry args={[0.5, BELT_HALF_H * 2, Math.abs(layout.rejectY)]} />
        <meshStandardMaterial color="#1c0f12" metalness={0.2} roughness={0.8} />
      </mesh>
      {/* Lane B branch (sort diverter actuated), then its straight run */}
      <mesh
        position={[(branchStartX + branchEndX) / 2, BELT_Y - 0.005, laneBStation.y / 2]}
        rotation={[0, branchAngle, 0]}
      >
        <boxGeometry args={[branchLen, BELT_HALF_H * 2, 0.8]} />
        <meshStandardMaterial color="#1f2937" metalness={0.3} roughness={0.7} />
      </mesh>
      <mesh position={[(branchEndX + layout.spanX[1]) / 2, BELT_Y - 0.005, laneBStation.y]}>
        <boxGeometry args={[layout.spanX[1] - branchEndX, BELT_HALF_H * 2, 0.8]} />
        <meshStandardMaterial color="#1f2937" metalness={0.3} roughness={0.7} />
      </mesh>

      {/* Stations */}
      {layout.stations.map((s) => (
        <Station3D
          key={s.id}
          station={s}
          active={s.kind === "gate" ? rejecting : activeStationIds.has(s.id)}
          color={s.kind === "gate" && rejecting ? "#ef4444" : STATION_COLORS[s.kind]}
          {...stationText(s)}
        />
      ))}

      {/* Labeler roll (spins while labeling) */}
      <LabelRoller x={labelStation.x} active={activeStationIds.has(labelStation.id)} />

      {/* Robotic arm: lifts a lid off the stack, places it on the container and presses it down */}
      <CapArm x={capStation.x} active={activeStationIds.has(capStation.id)} />

      {/* Reject diverter (extends when a container is being rejected) */}
      <RejectDiverter x={gateStation.x} active={rejecting} />

      {/* Sort diverter (swings toward Lane B for large bottles) */}
      <SortDiverter x={sortStation.x} toLaneB={sortingToB} />

      {/* Tanks */}
      {state.tanks.map((tank, i) => {
        const nozzle = layout.stations.find((s) => s.kind === "nozzle" && s.tankId === tank.id);
        if (!nozzle) return null;
        return (
          <Tank3D
            key={tank.id}
            tank={tank}
            index={i}
            x={nozzle.x}
            y={layout.tankY}
          />
        );
      })}

      {/* Containers */}
      {positions.map((p) => {
        const c = state.containers.find((x) => x.id === p.id);
        if (!c) return null;
        const color = containerColor(c, state.tanks);
        return (
          <Container3D key={p.id} container={c} x={p.x} y={p.y} color={color} />
        );
      })}
    </group>
  );
}

function Station3D({
  station, active, color, label, sub,
}: {
  station: StationPosition;
  active: boolean;
  color: string;
  label?: string;
  sub?: string;
}) {
  const labelY = station.kind === "cap" ? 1.25 : 0.45;
  return (
    <group position={[station.x, 0, station.y]}>
      <mesh position={[0, -0.18, 0]}>
        <boxGeometry args={[0.5, 0.12, 0.9]} />
        <meshStandardMaterial
          color={active ? "#14532d" : "#0f172a"}
          emissive={active ? color : "#000000"}
          emissiveIntensity={active ? 0.4 : 0}
          metalness={0.3}
          roughness={0.6}
        />
      </mesh>
      <Html position={[0, labelY, 0]} center distanceFactor={8} occlude={false}>
        <div className="pointer-events-none select-none whitespace-nowrap rounded-md border border-border/70 bg-background/90 px-2 py-0.5 text-[11px] font-medium text-foreground shadow-md">
          {label ?? station.label}
          {sub && (
            <span className="ml-1 font-mono text-[9px] text-muted-foreground">
              {sub}
            </span>
          )}
        </div>
      </Html>
    </group>
  );
}

const STATION_COLORS: Record<StationPosition["kind"], string> = {
  label: "#8b5cf6",
  scan: "#0ea5e9",
  nozzle: "#64748b",
  cap: "#14b8a6",
  qc: "#10b981",
  gate: "#f59e0b",
  sort: "#f59e0b",
  output: "#10b981",
  reject: "#ef4444",
};

/** Tween a value toward a target in useFrame (frame-rate independent). */
function approach(current: number, target: number, dt: number): number {
  return current + (target - current) * Math.min(1, dt * 6);
}

function LabelRoller({ x, active }: { x: number; active: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current && active) ref.current.rotation.y += dt * 6;
  });
  return (
    <group position={[x, 0.35, -0.45]}>
      <mesh ref={ref}>
        <cylinderGeometry args={[0.14, 0.14, 0.3, 16]} />
        <meshStandardMaterial color="#8b5cf6" emissive={active ? "#8b5cf6" : "#000000"} emissiveIntensity={active ? 0.6 : 0} metalness={0.3} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** Arm base beside the belt; the boom swings from the lid stack to over the belt. */
const ARM_BASE_Z = -0.62;
const ARM_REACH = 0.62;
const LID_STACK_ANGLE = 1.9;

function CapArm({ x, active }: { x: number; active: boolean }) {
  const swing = useRef<THREE.Group>(null);
  const lift = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!swing.current || !lift.current) return;
    // Idle: holding the next lid over the stack. Capping: over the container, lowered to seat the lid.
    swing.current.rotation.y = approach(swing.current.rotation.y, active ? 0 : LID_STACK_ANGLE, dt);
    lift.current.position.y = approach(lift.current.position.y, active ? 0.6 : 0.85, dt);
  });
  return (
    <group position={[x, 0, ARM_BASE_Z]}>
      {/* Base and column */}
      <mesh position={[0, -0.05, 0]}>
        <cylinderGeometry args={[0.16, 0.18, 0.1, 20]} />
        <meshStandardMaterial color="#334155" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.45, 0]}>
        <boxGeometry args={[0.1, 0.9, 0.1]} />
        <meshStandardMaterial color="#334155" metalness={0.5} roughness={0.5} />
      </mesh>
      {/* Lid stack (magazine) beside the belt */}
      <mesh position={[Math.sin(LID_STACK_ANGLE) * ARM_REACH, 0.12, Math.cos(LID_STACK_ANGLE) * ARM_REACH]}>
        <cylinderGeometry args={[CONTAINER_R, CONTAINER_R, 0.3, 20]} />
        <meshStandardMaterial color="#cbd5e1" metalness={0.3} roughness={0.6} />
      </mesh>
      <group ref={swing} rotation={[0, LID_STACK_ANGLE, 0]}>
        <group ref={lift} position={[0, 0.85, 0]}>
          <mesh position={[0, 0, ARM_REACH / 2]}>
            <boxGeometry args={[0.08, 0.06, ARM_REACH]} />
            <meshStandardMaterial color="#14b8a6" emissive="#14b8a6" emissiveIntensity={active ? 0.5 : 0} metalness={0.4} roughness={0.5} />
          </mesh>
          {/* Gripper with the lid */}
          <mesh position={[0, -0.06, ARM_REACH]}>
            <boxGeometry args={[0.22, 0.05, 0.06]} />
            <meshStandardMaterial color="#0f766e" metalness={0.4} roughness={0.5} />
          </mesh>
          <mesh position={[0, -0.12, ARM_REACH]}>
            <cylinderGeometry args={[CONTAINER_R, CONTAINER_R, 0.04, 20]} />
            <meshStandardMaterial color="#e2e8f0" metalness={0.3} roughness={0.5} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

function SortDiverter({ x, toLaneB }: { x: number; toLaneB: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!ref.current) return;
    ref.current.rotation.y = approach(ref.current.rotation.y, toLaneB ? -0.6 : 0, dt);
  });
  return (
    <group ref={ref} position={[x - 0.45, 0.3, -0.45]}>
      <mesh position={[0.45, 0, 0]}>
        <boxGeometry args={[0.9, 0.16, 0.05]} />
        <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={toLaneB ? 0.4 : 0} metalness={0.4} roughness={0.5} />
      </mesh>
    </group>
  );
}

function RejectDiverter({ x, active }: { x: number; active: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (!ref.current) return;
    const target = active ? -0.5 : 0;
    ref.current.position.z += (target - ref.current.position.z) * Math.min(1, dt * 6);
  });
  return (
    <group ref={ref} position={[x, 0.2, 0]}>
      <mesh>
        <boxGeometry args={[0.12, 0.18, 0.18]} />
        <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={active ? 0.4 : 0} metalness={0.4} roughness={0.5} />
      </mesh>
    </group>
  );
}

function Tank3D({ tank, index, x, y }: { tank: Tank; index: number; x: number; y: number }) {
  const ratio = Math.max(0, Math.min(1, tank.levelMl / tank.capacityMl));
  const low = ratio < 0.15;
  const crit = ratio < 0.3 && !low;
  const color = useMemo(() => new THREE.Color(tank.colorCode), [tank.colorCode]);
  const fillH = TANK_HEIGHT * ratio;

  return (
    <group position={[x, y, 0]}>
      {/* Tank shell */}
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[TANK_RADIUS, TANK_RADIUS, TANK_HEIGHT, 24]} />
        <meshStandardMaterial color="#0b1220" metalness={0.4} roughness={0.5} transparent opacity={0.25} />
      </mesh>
      {/* Fill */}
      <mesh position={[0, -TANK_HEIGHT / 2 + fillH / 2, 0]}>
        <cylinderGeometry args={[TANK_RADIUS * 0.92, TANK_RADIUS * 0.92, Math.max(0.01, fillH), 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.25} transparent opacity={0.85} />
      </mesh>
      {/* Pipe to nozzle */}
      <mesh position={[0, -TANK_HEIGHT / 2 - 0.3, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.6, 12]} />
        <meshStandardMaterial color="#334155" metalness={0.5} roughness={0.5} />
      </mesh>
      {/* Low/critical ring */}
      {(low || crit) && (
        <mesh position={[0, TANK_HEIGHT / 2 + 0.05, 0]}>
          <torusGeometry args={[TANK_RADIUS + 0.04, 0.03, 8, 24]} />
          <meshStandardMaterial color={low ? "#ef4444" : "#f59e0b"} emissive={low ? "#ef4444" : "#f59e0b"} emissiveIntensity={0.6} />
        </mesh>
      )}
      <Html position={[0, TANK_HEIGHT / 2 + 0.4, 0]} center distanceFactor={9} occlude={false}>
        <div className="pointer-events-none select-none whitespace-nowrap rounded-md border border-border/70 bg-background/90 px-2 py-0.5 text-[11px] font-medium text-foreground shadow-md">
          Tank {index + 1} · {tank.name}
          <span className="ml-1 font-mono text-[9px] text-muted-foreground">{Math.round(ratio * 100)}%</span>
        </div>
      </Html>
    </group>
  );
}

function Container3D({
  container, x, y, color,
}: {
  container: Container;
  x: number;
  y: number;
  color: string;
}) {
  const z = y;
  const fillRatio = container.targetMl > 0 ? container.fillMl / container.targetMl : 0;
  const c = useMemo(() => new THREE.Color(color), [color]);
  return (
    <group position={[x, BELT_Y + BELT_HALF_H + CONTAINER_H / 2, z]}>
      <mesh castShadow>
        <cylinderGeometry args={[CONTAINER_R, CONTAINER_R * 0.85, CONTAINER_H, 20]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.2} roughness={0.6} transparent opacity={0.35} />
      </mesh>
      {/* Liquid */}
      <mesh position={[0, -CONTAINER_H / 2 + (CONTAINER_H * fillRatio) / 2, 0]}>
        <cylinderGeometry args={[CONTAINER_R * 0.8, CONTAINER_R * 0.7, Math.max(0.01, CONTAINER_H * fillRatio), 20]} />
        <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.2} />
      </mesh>
      <Html position={[0, CONTAINER_H / 2 + 0.18, 0]} center distanceFactor={11} occlude={false}>
        <div className="pointer-events-none select-none whitespace-nowrap rounded border border-border/60 bg-background/85 px-1 py-px font-mono text-[9px] text-foreground">
          {container.id.replace("C-", "")}
        </div>
      </Html>
    </group>
  );
}
