/**
 * Math / value model types from Unreal.Core/Models.
 * Ported as plain classes; only fields used by the readers are kept.
 */

export class FVector {
  X: number;
  Y: number;
  Z: number;
  ScaleFactor = 0;
  Bits = 0;

  constructor(x: number, y: number, z: number) {
    this.X = x;
    this.Y = y;
    this.Z = z;
  }

  toString(): string {
    return `X: ${this.X}, Y: ${this.Y}, Z: ${this.Z}`;
  }
}

export class FVector2D {
  constructor(
    public X: number,
    public Y: number,
  ) {}

  toString(): string {
    return `X: ${this.X}, Y: ${this.Y}`;
  }
}

export class FQuat {
  X = 0;
  Y = 0;
  Z = 0;
  W = 0;
}

export class FRotator {
  constructor(
    public Pitch: number,
    public Yaw: number,
    public Roll: number,
  ) {}

  toString(): string {
    return `Pitch: ${this.Pitch}, Yaw: ${this.Yaw}, Roll: ${this.Roll}`;
  }
}

export class FTransform {
  Rotation?: FQuat;
  Translation?: FVector;
  Scale3D?: FVector;
}

export interface FRepMovement {
  LinearVelocity?: FVector;
  AngularVelocity?: FVector;
  Location?: FVector;
  Rotation?: FRotator;
  Acceleration?: FVector | null;
  bSimulatedPhysicSleep: boolean;
  bRepPhysics: boolean;
  bRepAcceleration: boolean;
  ServerFrame: number;
  ServerPhysicsHandle: number;
}

export interface NetworkReplayVersion {
  Major: number;
  Minor: number;
  Patch: number;
  Changelist: number;
  Branch: string;
}
