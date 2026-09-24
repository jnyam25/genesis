/**
 * Minimal, dependency-free Modbus TCP client and server.
 *
 * Supports the function codes the Captsone register map needs:
 *   0x01 Read Coils            0x03 Read Holding Registers
 *   0x05 Write Single Coil     0x06 Write Single Register
 *   0x0F Write Multiple Coils  0x10 Write Multiple Registers
 *
 * Frames: MBAP header (transaction id, protocol id 0, length, unit id) + PDU.
 * Modbus TCP has no authentication or encryption — run it only on an isolated
 * control network (see docs/prototype/communication.md).
 */

import * as net from "net";
import { EventEmitter } from "events";

export const FC = {
  READ_COILS: 0x01,
  READ_HOLDING_REGISTERS: 0x03,
  WRITE_SINGLE_COIL: 0x05,
  WRITE_SINGLE_REGISTER: 0x06,
  WRITE_MULTIPLE_COILS: 0x0f,
  WRITE_MULTIPLE_REGISTERS: 0x10,
} as const;

export const EXCEPTION = {
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_DATA_ADDRESS: 0x02,
  ILLEGAL_DATA_VALUE: 0x03,
  SERVER_DEVICE_FAILURE: 0x04,
} as const;

const MBAP_LEN = 7;
const MAX_READ_REGISTERS = 125;
const MAX_READ_COILS = 2000;

export class ModbusException extends Error {
  constructor(
    public readonly functionCode: number,
    public readonly exceptionCode: number,
  ) {
    super(`Modbus exception ${exceptionCode} for function 0x${functionCode.toString(16)}`);
    this.name = "ModbusException";
  }
}

/** Splits a TCP byte stream into complete MBAP frames. */
class FrameReader {
  private buf = Buffer.alloc(0);

  push(chunk: Buffer, onFrame: (frame: Buffer) => void): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= MBAP_LEN) {
      const length = this.buf.readUInt16BE(4); // unit id + PDU
      if (length < 2 || length > 254) {
        // Corrupt stream: drop everything and let the peer resync.
        this.buf = Buffer.alloc(0);
        return;
      }
      const total = 6 + length;
      if (this.buf.length < total) return;
      onFrame(this.buf.subarray(0, total));
      this.buf = this.buf.subarray(total);
    }
  }
}

function frame(transactionId: number, unitId: number, pdu: Buffer): Buffer {
  const header = Buffer.alloc(MBAP_LEN);
  header.writeUInt16BE(transactionId, 0);
  header.writeUInt16BE(0, 2);
  header.writeUInt16BE(pdu.length + 1, 4);
  header.writeUInt8(unitId, 6);
  return Buffer.concat([header, pdu]);
}

function packBits(bits: boolean[]): Buffer {
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) out[i >> 3] |= 1 << (i % 8);
  });
  return out;
}

function unpackBits(bytes: Buffer, count: number): boolean[] {
  return Array.from({ length: count }, (_, i) => ((bytes[i >> 3] >> (i % 8)) & 1) === 1);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ModbusClientOptions {
  host: string;
  port?: number;
  unitId?: number;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Delay before reconnecting after a drop (ms). */
  reconnectMs?: number;
}

interface Pending {
  resolve: (pdu: Buffer) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  functionCode: number;
}

/**
 * Auto-reconnecting Modbus TCP client. Requests made while disconnected fail
 * immediately (callers poll, so the next poll simply retries).
 *
 * Events: "connect", "close", "error" (Error).
 */
export class ModbusTcpClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private nextTid = 1;
  private pending = new Map<number, Pending>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<ModbusClientOptions>;

  constructor(options: ModbusClientOptions) {
    super();
    this.opts = { port: 502, unitId: 1, timeoutMs: 1000, reconnectMs: 2000, ...options };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.destroy();
    this.failAll(new Error("client closed"));
  }

  private open(): void {
    const reader = new FrameReader();
    const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("connect", () => {
      this.connected = true;
      this.emit("connect");
    });
    socket.on("data", (chunk) => reader.push(chunk, (f) => this.onFrame(f)));
    socket.on("error", (err) => {
      // "close" follows; report once here.
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
    socket.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.failAll(new Error("connection closed"));
      if (wasConnected) this.emit("close");
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.open(), this.opts.reconnectMs);
      }
    });
  }

  private failAll(err: Error): void {
    for (const [tid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(tid);
    }
  }

  private onFrame(f: Buffer): void {
    const tid = f.readUInt16BE(0);
    const p = this.pending.get(tid);
    if (!p) return;
    this.pending.delete(tid);
    clearTimeout(p.timer);
    const pdu = f.subarray(MBAP_LEN);
    const fc = pdu[0];
    if (fc === (p.functionCode | 0x80)) {
      p.reject(new ModbusException(p.functionCode, pdu[1]));
    } else if (fc !== p.functionCode) {
      p.reject(new Error(`unexpected function code 0x${fc.toString(16)}`));
    } else {
      p.resolve(pdu);
    }
  }

  private request(pdu: Buffer): Promise<Buffer> {
    if (!this.connected || !this.socket) return Promise.reject(new Error("not connected"));
    const tid = this.nextTid;
    this.nextTid = (this.nextTid % 0xffff) + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tid);
        reject(new Error(`timeout after ${this.opts.timeoutMs} ms (function 0x${pdu[0].toString(16)})`));
      }, this.opts.timeoutMs);
      this.pending.set(tid, { resolve, reject, timer, functionCode: pdu[0] });
      this.socket!.write(frame(tid, this.opts.unitId, pdu));
    });
  }

  async readHoldingRegisters(address: number, quantity: number): Promise<number[]> {
    if (quantity < 1 || quantity > MAX_READ_REGISTERS) throw new RangeError(`quantity must be 1..${MAX_READ_REGISTERS}`);
    const req = Buffer.alloc(5);
    req.writeUInt8(FC.READ_HOLDING_REGISTERS, 0);
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(quantity, 3);
    const res = await this.request(req);
    const byteCount = res[1];
    if (byteCount !== quantity * 2) throw new Error(`expected ${quantity * 2} bytes, got ${byteCount}`);
    return Array.from({ length: quantity }, (_, i) => res.readUInt16BE(2 + i * 2));
  }

  async readCoils(address: number, quantity: number): Promise<boolean[]> {
    if (quantity < 1 || quantity > MAX_READ_COILS) throw new RangeError(`quantity must be 1..${MAX_READ_COILS}`);
    const req = Buffer.alloc(5);
    req.writeUInt8(FC.READ_COILS, 0);
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(quantity, 3);
    const res = await this.request(req);
    return unpackBits(res.subarray(2, 2 + res[1]), quantity);
  }

  async writeSingleCoil(address: number, value: boolean): Promise<void> {
    const req = Buffer.alloc(5);
    req.writeUInt8(FC.WRITE_SINGLE_COIL, 0);
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
    await this.request(req);
  }

  async writeSingleRegister(address: number, value: number): Promise<void> {
    const req = Buffer.alloc(5);
    req.writeUInt8(FC.WRITE_SINGLE_REGISTER, 0);
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(value & 0xffff, 3);
    await this.request(req);
  }

  async writeMultipleRegisters(address: number, values: number[]): Promise<void> {
    const req = Buffer.alloc(6 + values.length * 2);
    req.writeUInt8(FC.WRITE_MULTIPLE_REGISTERS, 0);
    req.writeUInt16BE(address, 1);
    req.writeUInt16BE(values.length, 3);
    req.writeUInt8(values.length * 2, 5);
    values.forEach((v, i) => req.writeUInt16BE(v & 0xffff, 6 + i * 2));
    await this.request(req);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ModbusServerOptions {
  holdingRegisters: number;
  coils: number;
  /** Respond only to this unit id (0/255 are always accepted). Omit to accept any. */
  unitId?: number;
}

export interface WriteEvent {
  kind: "coil" | "register";
  address: number;
  values: number[];
}

/**
 * In-memory Modbus TCP server. The application reads/writes `registers` and
 * `coils` directly; client writes are applied and then reported via the
 * "write" event (WriteEvent).
 */
export class ModbusTcpServer extends EventEmitter {
  readonly registers: Uint16Array;
  readonly coils: Uint8Array;
  private server: net.Server;
  private sockets = new Set<net.Socket>();

  constructor(private readonly opts: ModbusServerOptions) {
    super();
    this.registers = new Uint16Array(opts.holdingRegisters);
    this.coils = new Uint8Array(opts.coils);
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  listen(port: number, host = "0.0.0.0"): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get address(): net.AddressInfo | null {
    const a = this.server.address();
    return a && typeof a === "object" ? a : null;
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    const reader = new FrameReader();
    socket.on("data", (chunk) =>
      reader.push(chunk, (f) => {
        const response = this.handle(f);
        if (response) socket.write(response);
      }),
    );
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
  }

  private handle(f: Buffer): Buffer | null {
    const tid = f.readUInt16BE(0);
    const protocol = f.readUInt16BE(2);
    const unitId = f.readUInt8(6);
    if (protocol !== 0) return null;
    if (this.opts.unitId !== undefined && unitId !== this.opts.unitId && unitId !== 0 && unitId !== 255) return null;
    const pdu = f.subarray(MBAP_LEN);
    const fc = pdu[0];
    const fail = (code: number) => frame(tid, unitId, Buffer.from([fc | 0x80, code]));
    const inRange = (addr: number, qty: number, size: number) => qty >= 1 && addr + qty <= size;

    try {
      switch (fc) {
        case FC.READ_HOLDING_REGISTERS: {
          const addr = pdu.readUInt16BE(1);
          const qty = pdu.readUInt16BE(3);
          if (qty < 1 || qty > MAX_READ_REGISTERS) return fail(EXCEPTION.ILLEGAL_DATA_VALUE);
          if (!inRange(addr, qty, this.registers.length)) return fail(EXCEPTION.ILLEGAL_DATA_ADDRESS);
          const out = Buffer.alloc(2 + qty * 2);
          out[0] = fc;
          out[1] = qty * 2;
          for (let i = 0; i < qty; i++) out.writeUInt16BE(this.registers[addr + i], 2 + i * 2);
          return frame(tid, unitId, out);
        }
        case FC.READ_COILS: {
          const addr = pdu.readUInt16BE(1);
          const qty = pdu.readUInt16BE(3);
          if (qty < 1 || qty > MAX_READ_COILS) return fail(EXCEPTION.ILLEGAL_DATA_VALUE);
          if (!inRange(addr, qty, this.coils.length)) return fail(EXCEPTION.ILLEGAL_DATA_ADDRESS);
          const bits = packBits(Array.from({ length: qty }, (_, i) => this.coils[addr + i] === 1));
          return frame(tid, unitId, Buffer.concat([Buffer.from([fc, bits.length]), bits]));
        }
        case FC.WRITE_SINGLE_COIL: {
          const addr = pdu.readUInt16BE(1);
          const raw = pdu.readUInt16BE(3);
          if (raw !== 0xff00 && raw !== 0x0000) return fail(EXCEPTION.ILLEGAL_DATA_VALUE);
          if (!inRange(addr, 1, this.coils.length)) return fail(EXCEPTION.ILLEGAL_DATA_ADDRESS);
          this.coils[addr] = raw === 0xff00 ? 1 : 0;
          this.emit("write", { kind: "coil", address: addr, values: [this.coils[addr]] } satisfies WriteEvent);
          return frame(tid, unitId, pdu.subarray(0, 5));
        }
        case FC.WRITE_SINGLE_REGISTER: {
          const addr = pdu.readUInt16BE(1);
          if (!inRange(addr, 1, this.registers.length)) return fail(EXCEPTION.ILLEGAL_DATA_ADDRESS);
          this.registers[addr] = pdu.readUInt16BE(3);
          this.emit("write", { kind: "register", address: addr, values: [this.registers[addr]] } satisfies WriteEvent);
          return frame(tid, unitId, pdu.subarray(0, 5));
        }
        case FC.WRITE_MULTIPLE_COILS: {
          const addr = pdu.readUInt16BE(1);
          const qty = pdu.readUInt16BE(3);
          if (!inRange(addr, qty, this.coils.length)) return fail(EXCEPTION.ILLEGAL_DATA_ADDRESS);
          const bits = unpackBits(pdu.subarray(6, 6 + pdu[5]), qty);
          bits.forEach((b, i) => (this.coils[addr + i] = b ? 1 : 0));
          this.emit("write", { kind: "coil", address: addr, values: bits.map(Number) } satisfies WriteEvent);
          return frame(tid, unitId, pdu.subarray(0, 5));
        }
        case FC.WRITE_MULTIPLE_REGISTERS: {
          const addr = pdu.readUInt16BE(1);
          const qty = pdu.readUInt16BE(3);
          if (qty < 1 || pdu[5] !== qty * 2) return fail(EXCEPTION.ILLEGAL_DATA_VALUE);
          if (!inRange(addr, qty, this.registers.length)) return fail(EXCEPTION.ILLEGAL_DATA_ADDRESS);
          const values: number[] = [];
          for (let i = 0; i < qty; i++) {
            this.registers[addr + i] = pdu.readUInt16BE(6 + i * 2);
            values.push(this.registers[addr + i]);
          }
          this.emit("write", { kind: "register", address: addr, values } satisfies WriteEvent);
          return frame(tid, unitId, pdu.subarray(0, 5));
        }
        default:
          return fail(EXCEPTION.ILLEGAL_FUNCTION);
      }
    } catch {
      return fail(EXCEPTION.SERVER_DEVICE_FAILURE);
    }
  }
}
