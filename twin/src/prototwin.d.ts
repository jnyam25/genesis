/**
 * Ambient declaration for the `prototwin` runtime module.
 *
 * The real `prototwin` package is injected by the ProtoTwin Simulate/Connect
 * script editor at runtime; it is NOT published to the public npm registry.
 * This file mirrors the subset of the public ProtoTwin TypeScript API
 * (https://prototwin.com/docs/scripting/typescript-api) that the Captsone
 * controller uses, so the project typechecks offline with plain `tsc`.
 *
 * It is a TYPE-ONLY stub. The Node demo harness (`src/run.ts`) deliberately
 * does NOT import `prototwin`; it drives the framework-agnostic core in
 * `core.ts` directly, so the twin is runnable here without the simulator.
 */

declare module "prototwin" {
  export type TrackableType<T> = new (...args: any[]) => T;
  export interface ITrackable<T> {}
  export interface IReadable<T> {
    value: T;
  }
  export interface IWritable<T> extends IReadable<T> {}
  export type Future<T> = PromiseLike<T> & { done: boolean };

  export class Vec3 {
    constructor(x?: number, y?: number, z?: number);
    x: number; y: number; z: number;
  }

  export class Quat {
    constructor(x?: number, y?: number, z?: number, w?: number);
  }

  export enum Access {
    Readable = 0,
    Writable = 1,
  }

  export enum UnitType {
    Dimensionless = 0,
    Time = 1,
    LinearDistance = 2,
    AngularDistance = 3,
    LinearVelocity = 4,
    AngularVelocity = 5,
    LinearAcceleration = 6,
    AngularAcceleration = 7,
    Force = 8,
    Torque = 9,
    Mass = 10,
    Frequency = 11,
    Percentage = 12,
    Pressure = 13,
    MomentOfInertia = 14,
  }

  export class Handle<T extends ITrackable<any>> {
    constructor();
    value: T | null;
  }

  export abstract class IO {
    constructor();
  }

  export class DoubleSignal implements IReadable<number>, IWritable<number> {
    constructor(value?: number, access?: Access);
    value: number;
    access: Access;
  }

  export class BooleanSignal implements IReadable<boolean>, IWritable<boolean> {
    constructor(value?: boolean, access?: Access);
    value: boolean;
    access: Access;
  }

  export class StringSignal implements IReadable<string>, IWritable<string> {
    constructor(value?: string, access?: Access);
    value: string;
    access: Access;
  }

  export abstract class Component<TIO extends IO = IO> {
    readonly entity: Entity;
    constructor(entity: Entity);

    handle<T extends ITrackable<any>>(type: TrackableType<T>, value?: T | null): Handle<T>;
    findComponent<T extends Component>(type: TrackableType<T>): T | null;
    addComponent<T extends Component>(type: TrackableType<T>): T | null;
    hasComponent<T extends Component>(type: TrackableType<T>): boolean;

    get io(): TIO;
    set io(value: TIO);

    initialize?(): void;
    initializeAsync?(): Promise<void>;
    update?(dt: number): void;
    added?(): void;
    removed?(): void;
  }

  export interface Entity {
    readonly name: string;
    position: Vec3;
    orientation: Quat;
    scale: Vec3;
    parent: Entity | null;
    children: Entity[] | null;
    readonly world: World;
    readonly worldBoundingBox: { min: Vec3; max: Vec3 };
    findComponent<T extends Component>(type: TrackableType<T>): T | null;
    addComponent<T extends Component>(type: TrackableType<T>): T | null;
    hasComponent<T extends Component>(type: TrackableType<T>): boolean;
  }

  export interface World {
    readonly time: number;
    readonly descendants: Entity[];
    create(name: string): Entity;
  }

  // Built-in components referenced by the controller.
  export class SensorComponent extends Component {
    static io: any;
    get io(): any;
    set io(value: any);
  }

  export class MotorComponent extends Component {
    get io(): any;
    set io(value: any);
    moveTo(position: number): Future<void>;
  }

  export class TransportSurfaceComponent extends Component {
    get io(): any;
    set io(value: any);
  }

  // Sequencing / concurrency primitives.
  export class Sequence {
    constructor(repeat?: boolean);
    add(step: () => Future<any> | void): void;
    run(): Future<void>;
  }

  export class Util {
    static radians(degrees: number): number;
    static degrees(radians: number): number;
  }

  export class Wait {
    static seconds(seconds: number): Future<void>;
    static value<T>(signal: IReadable<T>, value: T): Future<T>;
    static all(futures: Future<any>[]): Future<any[]>;
    static any(futures: Future<any>[]): Future<any>;
  }

  // Decorator functions (typed loosely so they typecheck under both legacy
  // and stage-3 decorator semantics; the real implementations are injected by
  // the simulator at runtime).
  export function Units(unit: UnitType): any;
  export function Name(name: string): any;
  export function Icon(icon: string): any;
  export function Label(label: string): any;
  export function Slider(min: number, max: number, steps?: number): any;
  export function Dropdown(options: any): any;
  export function Flags(options: any): any;
  export function Visible(predicate: (c: any) => boolean): any;
  export function Readonly(): any;
  export function Category(name: string): any;
  export function HandleArray<T extends ITrackable<any>>(type: TrackableType<T>): any;
  export class LocalFeature {}
  export enum LocalFeatureType {}
}
