//! IO layer — bit-stream readers ported from `package/ts-replay-parser/src/io/`.
//! Layer dependency: `io` depends only on nothing else in this crate (it sits
//! at the bottom alongside `transform`/`ooz`). Never introduce an upward
//! import from here into `unreal`/`valorant`.

pub mod binary_reader;
pub mod bit_reader;
pub mod enums;
pub mod farchive;
pub mod models;
pub mod net_bit_reader;
pub mod unreal_names;

pub use binary_reader::BinaryReader;
pub use bit_reader::BitReader;
pub use enums::{
    unique_id_encoding_flags, EngineNetworkVersionHistory, RotatorQuantization, VectorQuantization,
};
pub use farchive::{ArchiveState, FArchive, SeekOrigin};
pub use models::{
    FQuat, FRepMovement, FRotator, FTransform, FVector, FVector2D, NetworkReplayVersion,
};
pub use net_bit_reader::NetBitReader;
pub use unreal_names::unreal_name;
