"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useRef, useMemo } from "react";
import * as THREE from "three";
import { useContainerPositions } from "@/lib/twin/useContainerPositions";
import { containerColor } from "@/components/schematic/line-schematic";
import type { Container, Tank, TwinState } from "@/lib/twin/types";
import type { LineLayout, StationPosition } from "@/lib/twin/layout";

const BELT_Y = 0;
const BELT_HALF_H = 0.22;
const TANK_RADIUS = 0.34;
const TANK_HEIGHT = 1.2;
const CONTAINER_R = 0.18;
const CONTAINER_H = 0.32;

export function LineScene({ state }: { state: TwinState }) {
  return (
    <div className="h-[520px] w-full rounded-lg border border-border/60 bg-gradient-to-b from-slate-950 to-slate-900">
      <Canvas camera={{ position: [4, 4.5, 6], fov: 50 }} dpr={[1, 2]}>
        <ambientLight intensity={0.55} />
        <directionalLight position={[6, 8, 4]} intensity={1.1} castShadow />
        <directionalLight position={[-6, 4, -4]} intensity={0.35} />
        <SceneContents state={state} />
        <OrbitControls
          enablePan
          minDistance={3}
          maxDistance={20}
          maxPolarAngle={Math.PI / 2.05}
          target={[3, 0, 0]}
        />
        <gridHelper args={[40, 40, "#1e293b", "#0f172a"]} position={[0, -0.6, 0]} />
      </Canvas>
    </div>
  );
}

function SceneContents({ state }: { state: TwinState }) {
  const { layout, positions } = useContainerPositions(state);
  const qcStation = layout.stations.find((s) => s.kind === "qc")!;
  const mixStation = layout.stations.find((s) => s.kind === "mix")!;
  const outputStation = layout.stations.find((s) => s.kind === "output")!;
  const rejectStation = layout.stations.find((s) => s.kind === "reject")!;
  const scanStation = layout.stations.find((s) => s.kind === "scan")!;

  const activeStationIds = new Set<string>();
  for (const c of state.containers) {
    const m = /^fill-(\d+)$/.exec(c.status);
    if (m) activeStationIds.add(`nozzle-tank-${m[1]}`);
    else activeStationIds.add(c.status);
  }
  const mixActive = state.containers.some((c) => c.status === "mix");
  const qcFlagged = state.containers.some((c) => c.status === "rejected");
  const pushing = state.containers.some((c) => c.status === "rejected");

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

      {/* Reject lane */}
      <mesh position={[qcStation.x, BELT_Y, layout.rejectY * 0.5 - 0.1]}>
        <boxGeometry args={[0.5, BELT_HALF_H * 2, Math.abs(layout.rejectY)]} />
        <meshStandardMaterial color="#1c0f12" metalness={0.2} roughness={0.8} />
      </mesh>

      {/* Stations */}
      <Station3D station={scanStation} active={activeStationIds.has("scan")} color="#0ea5e9" />
      {layout.stations.filter((s) => s.kind === "nozzle").map((s) => (
        <Station3D key={s.id} station={s} active={activeStationIds.has(s.id)} color="#64748b" />
      ))}
      <Station3D station={mixStation} active={mixActive} color="#8b5cf6" />
      <Station3D station={qcStation} active={activeStationIds.has("qc")} color={qcFlagged ? "#ef4444" : "#10b981"} />
      <Station3D station={outputStation} active={activeStationIds.has("output")} color="#10b981" />
      <Station3D station={rejectStation} active={activeStationIds.has("rejected")} color="#ef4444" />

      {/* Mixer (spins when active) */}
      <Mixer x={mixStation.x} active={mixActive} />

      {/* Pusher (extends when a container is being rejected) */}
      <Pusher x={qcStation.x} active={pushing} />

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
  station, active, color,
}: {
  station: StationPosition;
  active: boolean;
  color: string;
}) {
  const z = station.kind === "reject" ? station.y : 0;
  return (
    <group position={[station.x, 0, z]}>
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
      <Html position={[0, 0.45, 0]} center distanceFactor={8} occlude={false}>
        <div className="pointer-events-none select-none whitespace-nowrap rounded-md border border-border/70 bg-background/90 px-2 py-0.5 text-[11px] font-medium text-foreground shadow-md">
          {station.label}
          {station.kind === "nozzle" && (
            <span className="ml-1 font-mono text-[9px] text-muted-foreground">
              {station.id.replace("nozzle-", "")}
            </span>
          )}
        </div>
      </Html>
    </group>
  );
}

function Mixer({ x, active }: { x: number; active: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, dt) => {
    if (ref.current && active) ref.current.rotation.y += dt * 6;
  });
  return (
    <group position={[x, 0.6, 0]}>
      <mesh ref={ref}>
        <cylinderGeometry args={[0.22, 0.22, 0.08, 6]} />
        <meshStandardMaterial color="#8b5cf6" emissive={active ? "#8b5cf6" : "#000000"} emissiveIntensity={active ? 0.6 : 0} metalness={0.5} roughness={0.4} />
      </mesh>
    </group>
  );
}

function Pusher({ x, active }: { x: number; active: boolean }) {
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
