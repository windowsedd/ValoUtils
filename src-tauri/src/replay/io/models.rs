//! Math / value model types from Unreal.Core/Models.
//! Ported from `package/ts-replay-parser/src/io/models.ts`.
//!
//! Field names are preserved in exact PascalCase (X, Y, Z, ... not x, y, z)
//! since these eventually serialize to JSON consumed by the existing
//! frontend, matching the TS output shape.

#![allow(non_snake_case)]

use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct FVector {
    pub X: f64,
    pub Y: f64,
    pub Z: f64,
    pub ScaleFactor: f64,
    pub Bits: u32,
}

impl FVector {
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        FVector {
            X: x,
            Y: y,
            Z: z,
            ScaleFactor: 0.0,
            Bits: 0,
        }
    }
}

impl std::fmt::Display for FVector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "X: {}, Y: {}, Z: {}", self.X, self.Y, self.Z)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct FVector2D {
    pub X: f64,
    pub Y: f64,
}

impl FVector2D {
    pub fn new(x: f64, y: f64) -> Self {
        FVector2D { X: x, Y: y }
    }
}

impl std::fmt::Display for FVector2D {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "X: {}, Y: {}", self.X, self.Y)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct FQuat {
    pub X: f64,
    pub Y: f64,
    pub Z: f64,
    pub W: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct FRotator {
    pub Pitch: f64,
    pub Yaw: f64,
    pub Roll: f64,
}

impl FRotator {
    pub fn new(pitch: f64, yaw: f64, roll: f64) -> Self {
        FRotator {
            Pitch: pitch,
            Yaw: yaw,
            Roll: roll,
        }
    }
}

impl std::fmt::Display for FRotator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Pitch: {}, Yaw: {}, Roll: {}",
            self.Pitch, self.Yaw, self.Roll
        )
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct FTransform {
    pub Rotation: Option<FQuat>,
    pub Translation: Option<FVector>,
    pub Scale3D: Option<FVector>,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct FRepMovement {
    pub LinearVelocity: Option<FVector>,
    pub AngularVelocity: Option<FVector>,
    pub Location: Option<FVector>,
    pub Rotation: Option<FRotator>,
    pub Acceleration: Option<FVector>,
    pub bSimulatedPhysicSleep: bool,
    pub bRepPhysics: bool,
    pub bRepAcceleration: bool,
    pub ServerFrame: u32,
    pub ServerPhysicsHandle: u32,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct NetworkReplayVersion {
    pub Major: i32,
    pub Minor: i32,
    pub Patch: i32,
    pub Changelist: i32,
    pub Branch: String,
}
