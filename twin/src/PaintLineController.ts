/**
 * PaintLineController — the prototwin Component that drives the Captsone line.
 *
 * Typechecked against the ambient `prototwin` declaration (`prototwin.d.ts`);
 * intended to run inside the ProtoTwin Simulate/Connect script editor (the
 * `prototwin` module is injected by the simulator, not by npm). The runnable
 * Node demo in `run.ts` drives the SAME control model via `core.ts`.
 *
 * Refinements (see docs/engine-design.md):
 *  (a) refill-then-ACCEPT: on low tank level, refill and continue, never reject.
 *  (b) barcode read from `scanSensor.io.barcodeData`, fed by BarcodeMockSensor.
 *  (c) every `Wait.value` sensor wait races `Wait.seconds(timeout)`; timeout
 *      wins force-reject the container and release the station.
 *  (d) `dispenseVariance` is a tunable `@Units(UnitType.Percentage)` property.
 *
 * Dynamic tanks (static-handle constraint): handles are created dynamically in
 * `initialize()` from `config.tanks` and stored in arrays. `this.handle(Type)`
 * is a regular method callable any number of times; handles stay lifetime-
 * managed. MAX_TANKS is a documented ceiling only. Adding a tank = append to
 * `config.tanks`; no field declarations change.
 *
 * Multi-container pipelining (ECS): each container is its own Entity carrying a
 * `ContainerStateComponent`; the controller launches one Sequence per container
 * so multiple flow concurrently. Belt speed is one global setting.
 */

import {
  type Entity,
  Component,
  IO,
  DoubleSignal,
  BooleanSignal,
  StringSignal,
  Access,
  Handle,
  Units,
  UnitType,
  Wait,
  type IReadable,
  SensorComponent,
  MotorComponent,
} from "prototwin";

import { DEFAULT_CONFIG, MAX_TANKS, type TwinConfig } from "./config";
import { parseBarcode, BarcodeError, type ParsedBarcode } from "./barcode";
import { buildDispensePlan, type DispensePlan, type MixStep } from "./recipe";

/** Per-container state, attached to each container Entity (ECS). */
export class ContainerStateComponent extends Component {
  public id = 0;
  public barcodeRaw = "";
  public parsed: ParsedBarcode | null = null;
  public plan: DispensePlan | null = null;
  public parseError: string | null = null;
  public fillMl = 0;
  public targetMl = 0;
  public accepted = false;
  public rejected = false;
  public jamReason: string | null = null;
}

export class PaintLineControllerIO extends IO {
  public beltSpeed: DoubleSignal;
  public dispenseVariancePct: DoubleSignal;
  public acceptedCount: DoubleSignal;
  public rejectedCount: DoubleSignal;
  public lastEvent: StringSignal;
  public snapshotJson: StringSignal;
  constructor() {
    super();
    this.beltSpeed = new DoubleSignal(0.2, Access.Writable);
    this.dispenseVariancePct = new DoubleSignal(2, Access.Writable);
    this.acceptedCount = new DoubleSignal(0, Access.Readable);
    this.rejectedCount = new DoubleSignal(0, Access.Readable);
    this.lastEvent = new StringSignal("init", Access.Readable);
    this.snapshotJson = new StringSignal("{}", Access.Readable);
  }
}

export class PaintLineController extends Component<PaintLineControllerIO> {
  #io: PaintLineControllerIO;
  public config: TwinConfig = DEFAULT_CONFIG;

  public scanSensor: Handle<SensorComponent> = this.handle(SensorComponent);
  public beltMotor: Handle<MotorComponent> = this.handle(MotorComponent);

  public nozzleSensors: Handle<SensorComponent>[] = [];
  public tankLevelSensors: Handle<SensorComponent>[] = [];
  public nozzleActuators: Handle<MotorComponent>[] = [];
  public stationSensors: Map<string, Handle<SensorComponent>> = new Map();

  private nextContainerId = 1;
  private counts = { accepted: 0, rejected: 0, total: 0 };
  private lastEvent = "init";

  public override get io(): PaintLineControllerIO {
    return this.#io;
  }
  public override set io(value: PaintLineControllerIO) {
    this.#io = value;
  }

  constructor(entity: Entity) {
    super(entity);
    this.#io = new PaintLineControllerIO();
  }

  public override initialize(): void {
    if (this.config.tanks.length > MAX_TANKS) {
      throw new Error(`config has ${this.config.tanks.length} tanks but MAX_TANKS is ${MAX_TANKS}`);
    }
    this.nozzleSensors = [];
    this.tankLevelSensors = [];
    this.nozzleActuators = [];
    for (let i = 0; i < this.config.tanks.length; i++) {
      this.nozzleSensors.push(this.handle(SensorComponent));
      this.tankLevelSensors.push(this.handle(SensorComponent));
      this.nozzleActuators.push(this.handle(MotorComponent));
    }
    for (const s of this.config.stations) {
      this.stationSensors.set(s.id, this.handle(SensorComponent));
    }
    this.#io.beltSpeed.value = this.config.beltSpeedMPerSec;
    this.#io.dispenseVariancePct.value = this.config.dispenseVariance * 100;
  }

  @Units(UnitType.Percentage)
  public get dispenseVariance(): number {
    return this.#io.dispenseVariancePct.value / 100;
  }
  public set dispenseVariance(fraction: number) {
    this.#io.dispenseVariancePct.value = fraction * 100;
  }

  public override update(_dt: number): void {
    this.#io.acceptedCount.value = this.counts.accepted;
    this.#io.rejectedCount.value = this.counts.rejected;
    this.#io.lastEvent.value = this.lastEvent;
  }

  /** Called when the scanner has read a new preprinted barcode. */
  public onBarcodeScanned(barcode: string): void {
    const e = this.entity.world.create(`Container-${this.nextContainerId}`);
    const state = e.addComponent(ContainerStateComponent);
    if (!state) return;
    state.id = this.nextContainerId++;
    state.barcodeRaw = barcode;
    try {
      state.parsed = parseBarcode(barcode, this.config);
      state.plan = buildDispensePlan(state.parsed, this.config.mixPolicy);
      state.targetMl = state.parsed.totalMl;
    } catch (err) {
      state.parseError = err instanceof BarcodeError ? `${err.code}: ${err.message}` : String(err);
    }
    this.recordEvent(`container ${state.id} entered (${barcode})`);
    this.runContainer(state).then(undefined, (err) => {
      state.rejected = true;
      state.jamReason = `coroutine error: ${String(err)}`;
      this.counts.rejected++;
      this.counts.total++;
      this.recordEvent(`container ${state.id} crashed: ${state.jamReason}`);
    });
  }

  private async runContainer(state: ContainerStateComponent): Promise<void> {
    if (state.parseError || !state.parsed || !state.plan) {
      await this.routeToStation(state, "GATE");
      this.reject(state, `bad barcode: ${state.parseError ?? "no plan"}`);
      return;
    }
    if (!(await this.routeToStation(state, "SCAN"))) return;
    for (const step of state.plan.steps) {
      const stationId = this.dispenseStationFor(step.tankIndex);
      if (!(await this.routeToStation(state, stationId))) return;
      if (!(await this.dispenseStep(state, step))) return;
    }
    if (!(await this.routeToStation(state, "QC"))) return;
    if (!(await this.routeToStation(state, "GATE"))) return;
    this.finalize(state);
  }

  /** Drive the container to `stationId`; false on jam/timeout. */
  private async routeToStation(
    state: ContainerStateComponent,
    stationId: string,
  ): Promise<boolean> {
    const sensor = this.stationSensors.get(stationId);
    if (!sensor || !sensor.value) {
      this.reject(state, `station ${stationId} sensor not wired`);
      return false;
    }
    const ioState = sensor.value.io as { state: IReadable<boolean> };
    const free = await this.waitForSignal(ioState.state, false);
    if (!free) {
      this.forceReject(state, `jam routing to ${stationId} (timeout)`);
      return false;
    }
    this.beltMotor.value!.moveTo(this.stationPositionM(stationId));
    const arrived = await this.waitForSignal(ioState.state, true);
    if (!arrived) {
      this.forceReject(state, `jam arriving at ${stationId} (timeout)`);
      return false;
    }
    return true;
  }

  /** Dispense one mix step; auto-refill the tank if low, then continue. */
  private async dispenseStep(state: ContainerStateComponent, step: MixStep): Promise<boolean> {
    const tank = this.config.tanks[step.tankIndex];
    const levelHandle = this.tankLevelSensors[step.tankIndex].value;
    const nozzle = this.nozzleActuators[step.tankIndex].value;
    if (!levelHandle || !nozzle) {
      this.forceReject(state, `tank ${tank.id} actuator not wired`);
      return false;
    }
    const levelSignal = (levelHandle.io as { level: IReadable<number> }).level;

    // Refinement a: low tank → refill THEN continue (never reject on low level).
    if (levelSignal.value < tank.refillThresholdMl) {
      this.recordEvent(`container ${state.id}: tank ${tank.id} low — auto-refilling`);
      nozzle.moveTo(tank.capacityMl);
      const recovered = await this.waitForSignal(
        levelSignal,
        tank.refillThresholdMl + this.config.refillAmountMl,
      );
      if (!recovered) {
        this.forceReject(state, `tank ${tank.id} refill timeout`);
        return false;
      }
    }

    // Refinement d: variance applied to the dispense target.
    const target = step.volumeMl * (1 + (Math.random() * 2 - 1) * this.dispenseVariance);
    nozzle.moveTo(target);
    const nozzleSensor = this.nozzleSensors[step.tankIndex].value;
    if (!nozzleSensor) {
      this.forceReject(state, `tank ${tank.id} nozzle sensor not wired`);
      return false;
    }
    const done = await this.waitForSignal(
      (nozzleSensor.io as { state: IReadable<boolean> }).state,
      false,
    );
    if (!done) {
      this.forceReject(state, `tank ${tank.id} dispense timeout`);
      return false;
    }
    state.fillMl += target;
    return true;
  }

  private finalize(state: ContainerStateComponent): void {
    const tol = Math.max(1, state.targetMl * (this.dispenseVariance + 0.01));
    if (Math.abs(state.fillMl - state.targetMl) > tol) {
      this.reject(state, `fill ${state.fillMl.toFixed(1)} != target ${state.targetMl}`);
    } else {
      state.accepted = true;
      this.counts.accepted++;
      this.counts.total++;
      this.recordEvent(`container ${state.id} ACCEPTED (${state.fillMl.toFixed(1)}/${state.targetMl} ml)`);
    }
  }

  private reject(state: ContainerStateComponent, reason: string): void {
    state.rejected = true;
    state.jamReason = reason;
    this.counts.rejected++;
    this.counts.total++;
    this.recordEvent(`container ${state.id} REJECTED — ${reason}`);
  }

  private forceReject(state: ContainerStateComponent, reason: string): void {
    state.rejected = true;
    state.jamReason = reason;
    this.counts.rejected++;
    this.counts.total++;
    this.recordEvent(`container ${state.id} JAMMED — ${reason}`);
  }

  /**
   * Refinement c: race a sensor wait vs a timeout. Returns true if the signal
   * reached `expected` first, false on timeout (caller force-rejects).
   */
  private async waitForSignal<T>(signal: IReadable<T>, expected: T): Promise<boolean> {
    const winner = await Wait.any([
      Wait.value(signal, expected),
      Wait.seconds(this.config.sensorWaitTimeoutSec),
    ]);
    return winner === expected;
  }

  private dispenseStationFor(tankIndex: number): string {
    const bays = this.config.stations.filter((s) => s.id.startsWith("BAY-"));
    const bay = bays[tankIndex] ?? bays[bays.length - 1];
    return bay ? bay.id : "QC";
  }

  private stationPositionM(stationId: string): number {
    const s = this.config.stations.find((x) => x.id === stationId);
    return s ? s.positionM : 0;
  }

  private recordEvent(msg: string): void {
    this.lastEvent = msg;
  }
}
