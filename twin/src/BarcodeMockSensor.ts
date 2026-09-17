/**
 * BarcodeMockSensor — a prototwin Component that feeds preprinted barcodes into
 * the line on a timer (refinement b). The controller reads the scanned value
 * from `scanSensor.io.barcodeData` rather than from a hard-coded field.
 *
 * In a real line a fixed scanner would write the preprinted barcode string into
 * `barcodeData` as each container passes. Here we cycle through a sample list on
 * `mockSensorPeriodSec` so the simulator has a self-contained demo. Replace
 * `barcodes` with whatever set of preprinted containers you want to run.
 */

import { type Entity, Component, IO, StringSignal, Access } from "prototwin";

export class BarcodeMockSensorIO extends IO {
  /** Writable by the scanner simulation, readable by the controller. */
  public barcodeData: StringSignal;

  constructor() {
    super();
    this.barcodeData = new StringSignal("", Access.Readable);
  }
}

export class BarcodeMockSensor extends Component<BarcodeMockSensorIO> {
  #io: BarcodeMockSensorIO;

  public periodSec: number = 3.0;
  public barcodes: string[] = [
    "PT1|T250|100,80,70",
    "PT1|T300|120,90,90",
    "PT1|T200|200",
    "PT1|T150|60,50,40",
  ];

  private index = 0;
  private timer = 0;

  public override get io(): BarcodeMockSensorIO {
    return this.#io;
  }
  public override set io(value: BarcodeMockSensorIO) {
    this.#io = value;
  }

  constructor(entity: Entity) {
    super(entity);
    this.#io = new BarcodeMockSensorIO();
  }

  public override initialize(): void {
    this.timer = 0;
    this.#io.barcodeData.value = "";
  }

  public override update(dt: number): void {
    if (this.barcodes.length === 0) return;
    this.timer += dt;
    if (this.timer >= this.periodSec) {
      this.timer = 0;
      const code = this.barcodes[this.index % this.barcodes.length];
      this.index++;
      this.#io.barcodeData.value = code;
    }
  }
}
