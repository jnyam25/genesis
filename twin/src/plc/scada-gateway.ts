/**
 * Modbus TCP door for a SCADA station that is not on the control network.
 *
 * The PLC, the ESP32 nodes, and the control switch stay on their own LAN.
 * A wired or wireless FUXA connects to this process on the Raspberry Pi.
 * Reads are forwarded to the PLC. Writes are forwarded only for the command
 * coils Cmd.DigitalEStop through Cmd.Reset. Holding-register writes and the
 * Sim.* coils are refused here, before they reach the PLC. The PLC still
 * applies LOCAL/REMOTE and E-Stop rules to every command that does arrive.
 *
 * Bind SCADA_GATEWAY_HOST to the Pi's operator-network address, its WireGuard
 * address, or both (comma-separated). Do not bind 0.0.0.0: that would publish
 * the door on the control network. On the SCADA PC, the tunnel's AllowedIPs
 * is the gateway address only, so that PC has no route to the PLC or the ESP32s.
 *
 *   SCADA_GATEWAY_HOST=10.44.0.1 PLC_HOST=192.168.10.10 PLC_PORT=502 npm run scada-gateway
 *
 * Remote FUXA then uses PLC_HOST=<gateway address> PLC_PORT=5502 and
 * FUXA_COMMANDS=1. See docs/prototype/communication.md.
 */

import * as net from "net";
import { EventEmitter } from "events";
import { COIL } from "./tag-map";
import { EXCEPTION, FC, FrameReader, ModbusException, ModbusTcpClient, frame } from "./modbus";

const ANY_INTERFACE = new Set(["0.0.0.0", "::", "::0"]);

export interface ScadaGatewayOptions {
  /** Addresses to listen on. One socket each. Never 0.0.0.0 unless allowAnyInterface is set. */
  listenHosts: string[];
  listenPort: number;
  upstream: ModbusTcpClient;
  /** Unit id this door answers. 0 and 255 are also accepted, matching the Modbus server. */
  unitId?: number;
  /** Permit binding every interface. Leave unset on a machine that can see the PLC. */
  allowAnyInterface?: boolean;
}

export interface RefusedWrite {
  functionCode: number;
  address: number;
}

/** True when every coil in the write is one of Cmd.* (addresses 0 through Cmd.Reset). */
export function commandCoilSpan(address: number, quantity: number): boolean {
  return quantity >= 1 && address >= 0 && address <= COIL.CMD_RESET && quantity <= COIL.CMD_RESET - address + 1;
}

/**
 * One upstream Modbus client, shared by every remote SCADA connection.
 * The PLC therefore sees a single extra client no matter how many screens connect.
 */
export class ScadaGateway extends EventEmitter {
  private servers: net.Server[] = [];
  private sockets = new Set<net.Socket>();
  private readonly hosts: string[];
  private readonly listenPort: number;
  private readonly unitId: number;

  constructor(private readonly opts: ScadaGatewayOptions) {
    super();
    this.hosts = opts.listenHosts.map((h) => h.trim()).filter((h) => h.length > 0);
    this.listenPort = opts.listenPort;
    this.unitId = opts.unitId ?? 1;
  }

  async listen(): Promise<void> {
    if (this.hosts.length === 0) throw new Error("SCADA_GATEWAY_HOST is empty");
    if (this.hosts.length > 1 && this.listenPort === 0) {
      throw new Error("SCADA_GATEWAY_PORT is required when binding more than one address");
    }
    for (const host of this.hosts) {
      if (ANY_INTERFACE.has(host) && !this.opts.allowAnyInterface) {
        throw new Error(
          `refusing to bind ${host}. Set SCADA_GATEWAY_HOST to the operator or WireGuard address. ` +
            "SCADA_GATEWAY_ALLOW_ANY=1 overrides this, and publishes the command door on every interface.",
        );
      }
    }
    const opened: net.Server[] = [];
    try {
      for (const host of this.hosts) {
        const server = net.createServer((socket) => this.onConnection(socket));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.listenPort, host, () => {
            server.off("error", reject);
            resolve();
          });
        });
        opened.push(server);
      }
    } catch (err) {
      await Promise.all(opened.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      throw err;
    }
    this.servers = opened;
  }

  /** Port of the first listener. Useful when listenPort was 0. */
  get port(): number {
    const address = this.servers[0]?.address();
    return address && typeof address === "object" ? address.port : this.listenPort;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(() => undefined);
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const reader = new FrameReader();
    socket.on("data", (chunk) =>
      reader.push(chunk, (f) => {
        void this.reply(socket, f);
      }),
    );
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async reply(socket: net.Socket, f: Buffer): Promise<void> {
    const tid = f.readUInt16BE(0);
    const protocol = f.readUInt16BE(2);
    const unitId = f.readUInt8(6);
    if (protocol !== 0) return;
    if (unitId !== this.unitId && unitId !== 0 && unitId !== 255) return;
    const pdu = await this.decide(f.subarray(7));
    if (!pdu || socket.destroyed) return;
    socket.write(frame(tid, unitId, pdu));
  }

  private async decide(pdu: Buffer): Promise<Buffer | null> {
    if (pdu.length < 1) return null;
    const fc = pdu[0];
    const exception = (code: number) => Buffer.from([fc | 0x80, code]);
    try {
      if (fc === FC.WRITE_SINGLE_REGISTER || fc === FC.WRITE_MULTIPLE_REGISTERS) {
        this.emit("refused", { functionCode: fc, address: pdu.length >= 3 ? pdu.readUInt16BE(1) : -1 } satisfies RefusedWrite);
        return exception(EXCEPTION.ILLEGAL_FUNCTION);
      }
      if (fc === FC.WRITE_SINGLE_COIL || fc === FC.WRITE_MULTIPLE_COILS) {
        const verdict = this.commandWrite(pdu, fc);
        if (verdict !== null) {
          if (verdict === EXCEPTION.ILLEGAL_DATA_ADDRESS) {
            this.emit("refused", { functionCode: fc, address: pdu.length >= 3 ? pdu.readUInt16BE(1) : -1 } satisfies RefusedWrite);
          }
          return exception(verdict);
        }
      } else if (fc !== FC.READ_COILS && fc !== FC.READ_HOLDING_REGISTERS) {
        return exception(EXCEPTION.ILLEGAL_FUNCTION);
      }
      return await this.opts.upstream.exchange(pdu);
    } catch (err) {
      if (err instanceof ModbusException) return exception(err.exceptionCode);
      return exception(EXCEPTION.SERVER_DEVICE_FAILURE);
    }
  }

  /** null means the write may be forwarded. Otherwise an exception code. */
  private commandWrite(pdu: Buffer, fc: number): number | null {
    if (pdu.length < 5) return EXCEPTION.ILLEGAL_DATA_VALUE;
    const address = pdu.readUInt16BE(1);
    if (fc === FC.WRITE_SINGLE_COIL) {
      const raw = pdu.readUInt16BE(3);
      if (raw !== 0xff00 && raw !== 0x0000) return EXCEPTION.ILLEGAL_DATA_VALUE;
      return commandCoilSpan(address, 1) ? null : EXCEPTION.ILLEGAL_DATA_ADDRESS;
    }
    const quantity = pdu.readUInt16BE(3);
    if (quantity < 1 || quantity > 2000) return EXCEPTION.ILLEGAL_DATA_VALUE;
    return commandCoilSpan(address, quantity) ? null : EXCEPTION.ILLEGAL_DATA_ADDRESS;
  }
}

function listenHostsFromEnv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

if (require.main === module) {
  const listenHosts = listenHostsFromEnv(process.env.SCADA_GATEWAY_HOST);
  const listenPort = Number(process.env.SCADA_GATEWAY_PORT ?? 5502);
  const plcHost = process.env.PLC_HOST;
  const plcPort = Number(process.env.PLC_PORT ?? 502);
  const unitId = Number(process.env.PLC_UNIT_ID ?? 1);
  if (listenHosts.length === 0 || !plcHost) {
    console.error(
      "[scada-gateway] needs SCADA_GATEWAY_HOST and PLC_HOST.\n" +
        '                 PowerShell: $env:SCADA_GATEWAY_HOST="10.44.0.1"; $env:PLC_HOST="192.168.10.10"; npm run scada-gateway\n' +
        "                 bash:       SCADA_GATEWAY_HOST=10.44.0.1 PLC_HOST=192.168.10.10 npm run scada-gateway\n" +
        "                 Comma-separate hosts to serve the operator LAN and WireGuard together.",
    );
    process.exit(1);
  }
  const upstream = new ModbusTcpClient({ host: plcHost, port: plcPort, unitId, timeoutMs: 1000, reconnectMs: 2000 });
  upstream.on("error", () => {});
  upstream.connect();
  const gateway = new ScadaGateway({
    listenHosts,
    listenPort,
    upstream,
    unitId,
    allowAnyInterface: process.env.SCADA_GATEWAY_ALLOW_ANY === "1",
  });
  gateway.on("refused", (write: RefusedWrite) => {
    console.error(`[scada-gateway] refused function 0x${write.functionCode.toString(16)} at address ${write.address}`);
  });
  gateway
    .listen()
    .then(() => {
      console.log(`[scada-gateway] remote SCADA Modbus on ${listenHosts.join(", ")}:${listenPort} (unit ${unitId})`);
      console.log(`[scada-gateway] upstream PLC ${plcHost}:${plcPort}`);
      console.log("[scada-gateway] writes forwarded: Cmd.DigitalEStop, ReleaseEStop, Jog, FirePusher, Start, Stop, Reset");
    })
    .catch((err: Error) => {
      console.error(`[scada-gateway] ${err.message}`);
      process.exit(1);
    });
  const stop = () => {
    upstream.close();
    void gateway.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
