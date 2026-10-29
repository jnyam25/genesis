/**
 * Joins the virtual PLC and the Micro850 on Modbus TCP, and leaves SCADA to
 * watch both.
 *
 * Each controller is a Modbus server. This process is a client of both. A
 * command coil that is set on one side and clear on the other is copied
 * across, once, until the source coil returns to 0. That covers
 * Cmd.DigitalEStop through Cmd.Reset. Sim.* coils stay where they were written.
 *
 * The Micro850 is the status master. Every poll copies its published words
 * from LineState through FaultCode, and Station.RunPermit, onto the virtual
 * PLC. Heartbeats are left alone so each controller can show it is alive.
 * With VPLC_FOLLOW=1 the virtual PLC does not publish over those words.
 *
 *   PLC_HOST=192.168.10.10 npm run plc-link
 *
 * `npm run line` starts this with the virtual PLC and FUXA. FUXA's PLC link
 * view reads both servers. Set PLC_LINK_COMMANDS=0 to watch without copying coils.
 */

import { ModbusTcpClient } from "./modbus";
import { COIL, STATION, SYS, SYS_BLOCK } from "./tag-map";

export const COMMAND_COIL_QUANTITY = COIL.CMD_RESET + 1;

const COIL_NAMES = ["Cmd.DigitalEStop", "Cmd.ReleaseEStop", "Cmd.Jog", "Cmd.FirePusher", "Cmd.Start", "Cmd.Stop", "Cmd.Reset"];

export interface PlcWords {
  protocol: number;
  heartbeat: number;
  lineState: number;
  tankCount: number;
  estopMask: number;
  faultCode: number;
  runPermit: number;
}

export interface SideReading {
  words: PlcWords;
  /** Holding registers 0..19. */
  sys: number[];
  coils: boolean[];
}

export interface Relay {
  from: "virtual" | "micro";
  coil: number;
  name: string;
}

/** Coils set on `source` and clear on `dest` that have not already been copied for this press. */
export function coilsToForward(source: boolean[], dest: boolean[], alreadyForwarded: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < COMMAND_COIL_QUANTITY; i++) {
    if (source[i] && !dest[i] && !alreadyForwarded.has(i)) out.push(i);
  }
  return out;
}

/** Drop a forwarded coil once its source has returned to 0, so the next press is sent again. */
export function retainForwarded(source: boolean[], forwarded: ReadonlySet<number>): Set<number> {
  const next = new Set<number>();
  for (const address of forwarded) if (source[address]) next.add(address);
  return next;
}

/** Words the Micro850 publishes and the virtual PLC repeats. Heartbeats are not in this list. */
export const MIRROR_FROM = SYS.LINE_STATE;
export const MIRROR_LENGTH = SYS_BLOCK.length - MIRROR_FROM;

/** Status words that should agree once the mirror has run. Heartbeats are independent. */
export function linkDifferences(virtualPlc: PlcWords, micro: PlcWords): string[] {
  const out: string[] = [];
  if (virtualPlc.protocol !== micro.protocol) out.push(`protocol virtual ${virtualPlc.protocol} / Micro850 ${micro.protocol}`);
  if (virtualPlc.lineState !== micro.lineState) out.push(`line state virtual ${virtualPlc.lineState} / Micro850 ${micro.lineState}`);
  if (virtualPlc.tankCount !== micro.tankCount) out.push(`tank count virtual ${virtualPlc.tankCount} / Micro850 ${micro.tankCount}`);
  if (virtualPlc.estopMask !== micro.estopMask) out.push(`E-Stop mask virtual ${virtualPlc.estopMask} / Micro850 ${micro.estopMask}`);
  if (virtualPlc.faultCode !== micro.faultCode) out.push(`fault code virtual ${virtualPlc.faultCode} / Micro850 ${micro.faultCode}`);
  if (virtualPlc.runPermit !== micro.runPermit) out.push(`run permit virtual ${virtualPlc.runPermit} / Micro850 ${micro.runPermit}`);
  return out;
}

function wordsOf(sys: number[], runPermit: number): PlcWords {
  return {
    protocol: sys[SYS.PROTOCOL_VERSION],
    heartbeat: sys[SYS.PLC_HEARTBEAT],
    lineState: sys[SYS.LINE_STATE],
    tankCount: sys[SYS.TANK_COUNT],
    estopMask: sys[SYS.PHYSICAL_ESTOP_MASK],
    faultCode: sys[SYS.FAULT_CODE],
    runPermit,
  };
}

export interface PlcLinkOptions {
  /** Copy command coils. False watches both controllers and writes nothing. */
  commands?: boolean;
  /** Copy the Micro850 status block onto the virtual PLC. */
  mirror?: boolean;
}

/**
 * One poll of both servers. Callers own the clients and the forwarded-coil sets.
 * A failed read marks that side offline and skips any copy that needs it.
 */
export async function exchange(
  virtualClient: ModbusTcpClient,
  microClient: ModbusTcpClient,
  forwarded: { virtual: Set<number>; micro: Set<number> },
  commands: boolean,
  mirror = false,
): Promise<{ virtual: SideReading | null; micro: SideReading | null; relays: Relay[] }> {
  const [virtual, micro] = await Promise.all([readSide(virtualClient), readSide(microClient)]);
  const relays: Relay[] = [];
  if (virtual && micro && (commands || mirror)) {
    if (commands) await relay(virtualClient, microClient, virtual, micro, forwarded, relays);
    else {
      forwarded.virtual = retainForwarded(virtual.coils, forwarded.virtual);
      forwarded.micro = retainForwarded(micro.coils, forwarded.micro);
    }
    if (mirror) await mirrorMicroOntoVirtual(virtualClient, virtual, micro);
  } else {
    if (virtual) forwarded.virtual = retainForwarded(virtual.coils, forwarded.virtual);
    if (micro) forwarded.micro = retainForwarded(micro.coils, forwarded.micro);
  }
  return { virtual, micro, relays };
}

/** Micro850 status image onto the virtual PLC. Does not touch either heartbeat. */
async function mirrorMicroOntoVirtual(virtualClient: ModbusTcpClient, virtual: SideReading, micro: SideReading): Promise<void> {
  const next = micro.sys.slice(MIRROR_FROM, MIRROR_FROM + MIRROR_LENGTH);
  const current = virtual.sys.slice(MIRROR_FROM, MIRROR_FROM + MIRROR_LENGTH);
  if (next.some((word, i) => word !== current[i])) {
    await virtualClient.writeMultipleRegisters(MIRROR_FROM, next);
    for (let i = 0; i < next.length; i++) virtual.sys[MIRROR_FROM + i] = next[i];
    virtual.words = wordsOf(virtual.sys, virtual.words.runPermit);
  }
  if (micro.words.runPermit !== virtual.words.runPermit) {
    await virtualClient.writeSingleRegister(STATION.RUN_PERMIT, micro.words.runPermit);
    virtual.words = { ...virtual.words, runPermit: micro.words.runPermit };
  }
  for (let i = 0; i < COMMAND_COIL_QUANTITY; i++) {
    if (virtual.coils[i] === micro.coils[i]) continue;
    await virtualClient.writeSingleCoil(i, micro.coils[i]);
    virtual.coils[i] = micro.coils[i];
  }
}

async function relay(
  virtualClient: ModbusTcpClient,
  microClient: ModbusTcpClient,
  virtual: SideReading,
  micro: SideReading,
  forwarded: { virtual: Set<number>; micro: Set<number> },
  relays: Relay[],
): Promise<void> {
  for (let i = 0; i < COMMAND_COIL_QUANTITY; i++) {
    if (virtual.coils[i] && micro.coils[i]) {
      forwarded.virtual.add(i);
      forwarded.micro.add(i);
    }
  }
  const toMicro = coilsToForward(virtual.coils, micro.coils, forwarded.virtual);
  const toVirtual = coilsToForward(micro.coils, virtual.coils, forwarded.micro);
  for (const coil of toMicro) {
    await microClient.writeSingleCoil(coil, true);
    micro.coils[coil] = true;
    forwarded.virtual.add(coil);
    forwarded.micro.add(coil);
    relays.push({ from: "virtual", coil, name: COIL_NAMES[coil] });
  }
  for (const coil of toVirtual) {
    await virtualClient.writeSingleCoil(coil, true);
    virtual.coils[coil] = true;
    forwarded.micro.add(coil);
    forwarded.virtual.add(coil);
    relays.push({ from: "micro", coil, name: COIL_NAMES[coil] });
  }
  forwarded.virtual = retainForwarded(virtual.coils, forwarded.virtual);
  forwarded.micro = retainForwarded(micro.coils, forwarded.micro);
}

async function readSide(client: ModbusTcpClient): Promise<SideReading | null> {
  if (!client.isConnected) return null;
  try {
    const sys = await client.readHoldingRegisters(SYS_BLOCK.start, SYS_BLOCK.length);
    const [runPermit] = await client.readHoldingRegisters(STATION.RUN_PERMIT, 1);
    const coils = await client.readCoils(0, COMMAND_COIL_QUANTITY);
    return { words: wordsOf(sys, runPermit), sys, coils };
  } catch {
    return null;
  }
}

export class PlcLink {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private forwarded = { virtual: new Set<number>(), micro: new Set<number>() };
  private lastDifference = "";
  private lastVirtualBeat = -1;
  private lastMicroBeat = -1;
  private virtualBeatAt = Date.now();
  private microBeatAt = Date.now();

  constructor(
    private readonly virtualClient: ModbusTcpClient,
    private readonly microClient: ModbusTcpClient,
    private readonly pollMs: number,
    private readonly commands: boolean,
    private readonly mirror: boolean,
  ) {}

  start(): void {
    const tick = () => {
      if (this.stopped) return;
      void this.poll().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
      });
    };
    tick();
  }

  async poll(): Promise<void> {
    let result: { virtual: SideReading | null; micro: SideReading | null; relays: Relay[] };
    try {
      result = await exchange(this.virtualClient, this.microClient, this.forwarded, this.commands, this.mirror);
    } catch (err) {
      console.error(`[plc-link] ${err instanceof Error ? err.message : err}`);
      return;
    }
    const now = Date.now();
    if (result.virtual && result.virtual.words.heartbeat !== this.lastVirtualBeat) {
      this.lastVirtualBeat = result.virtual.words.heartbeat;
      this.virtualBeatAt = now;
    }
    if (result.micro && result.micro.words.heartbeat !== this.lastMicroBeat) {
      this.lastMicroBeat = result.micro.words.heartbeat;
      this.microBeatAt = now;
    }
    for (const relay of result.relays) {
      const dest = relay.from === "virtual" ? "Micro850" : "virtual PLC";
      console.log(`[plc-link] ${relay.from === "virtual" ? "virtual PLC" : "Micro850"} → ${dest} ${relay.name}`);
    }
    if (!result.virtual || !result.micro) {
      const who = !result.virtual && !result.micro ? "both controllers" : result.virtual ? "Micro850" : "virtual PLC";
      const note = `offline: ${who}`;
      if (note !== this.lastDifference) {
        this.lastDifference = note;
        console.error(`[plc-link] ${note}`);
      }
      return;
    }
    const stale: string[] = [];
    if (now - this.virtualBeatAt > 3000) stale.push("virtual PLC heartbeat stopped");
    if (now - this.microBeatAt > 3000) stale.push("Micro850 heartbeat stopped");
    const differences = [...linkDifferences(result.virtual.words, result.micro.words), ...stale];
    const text = differences.join("; ");
    if (text !== this.lastDifference) {
      this.lastDifference = text;
      if (text) console.error(`[plc-link] ${text}`);
      else console.log("[plc-link] virtual PLC matches the Micro850 (heartbeats stay independent)");
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

function client(host: string, port: number, unitId: number): ModbusTcpClient {
  const c = new ModbusTcpClient({ host, port, unitId, timeoutMs: 1000, reconnectMs: 2000 });
  c.on("error", () => {});
  c.connect();
  return c;
}

if (require.main === module) {
  const microHost = process.env.PLC_HOST;
  if (!microHost) {
    console.error("[plc-link] PLC_HOST is required (the Micro850). The virtual PLC is 127.0.0.1:VPLC_PORT.");
    process.exit(1);
  }
  const microPort = Number(process.env.PLC_PORT ?? 502);
  const virtualHost = process.env.VPLC_HOST ?? "127.0.0.1";
  const virtualPort = Number(process.env.VPLC_PORT ?? 5020);
  const unitId = Number(process.env.PLC_UNIT_ID ?? 1);
  const pollMs = Number(process.env.PLC_LINK_POLL_MS ?? 250);
  const commands = process.env.PLC_LINK_COMMANDS !== "0";
  const mirror = process.env.PLC_LINK_MIRROR !== "0";
  const virtualClient = client(virtualHost, virtualPort, Number(process.env.VPLC_UNIT_ID ?? unitId));
  const microClient = client(microHost, microPort, unitId);
  const link = new PlcLink(virtualClient, microClient, pollMs, commands, mirror);
  console.log(
    `[plc-link] virtual PLC ${virtualHost}:${virtualPort} ↔ Micro850 ${microHost}:${microPort}` +
      (commands ? "\n           command coils are copied both ways." : "\n           command coils are not copied (PLC_LINK_COMMANDS=0).") +
      (mirror ? "\n           Micro850 status words are copied onto the virtual PLC. Heartbeats stay independent." : "\n           status words are not copied (PLC_LINK_MIRROR=0).") +
      "\n           FUXA's PLC link view reads both. Leave field power off until the station programs are downloaded.",
  );
  link.start();
  const shutdown = () => {
    link.stop();
    virtualClient.close();
    microClient.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
