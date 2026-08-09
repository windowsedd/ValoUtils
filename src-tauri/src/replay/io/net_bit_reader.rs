//! NetBitReader — RepLayout property serialization helpers.
//! Ported from `package/ts-replay-parser/src/io/net-bit-reader.ts`
//! (itself ported from Unreal.Core/NetBitReader.cs).
//!
//! TS `NetBitReader extends BitReader`; Rust has no class inheritance, so this
//! wraps `BitReader` via composition + `Deref`/`DerefMut` so callers can still
//! use every `BitReader` method directly on a `NetBitReader` value.

use std::ops::{Deref, DerefMut};

use super::bit_reader::BitReader;
use super::enums::{
    unique_id_encoding_flags, EngineNetworkVersionHistory, RotatorQuantization, VectorQuantization,
};
use super::farchive::FArchive;
use super::models::{FRepMovement, FRotator, FVector, FVector2D};

pub struct NetBitReader(pub BitReader);

impl Deref for NetBitReader {
    type Target = BitReader;
    fn deref(&self) -> &BitReader {
        &self.0
    }
}

impl DerefMut for NetBitReader {
    fn deref_mut(&mut self) -> &mut BitReader {
        &mut self.0
    }
}

impl NetBitReader {
    pub fn new(input: Vec<u8>, bit_count: Option<usize>) -> Self {
        NetBitReader(BitReader::new(input, bit_count))
    }

    pub fn serialize_property_int(&mut self) -> i32 {
        self.0.read_int32()
    }
    pub fn serialize_property_uint32(&mut self) -> u32 {
        self.0.read_uint32()
    }
    pub fn serialize_property_uint16(&mut self) -> u16 {
        self.0.read_uint16()
    }
    pub fn serialize_property_uint64(&mut self) -> u64 {
        self.0.read_uint64()
    }
    pub fn serialize_property_float(&mut self) -> f32 {
        self.0.read_single()
    }
    pub fn serialize_property_double(&mut self) -> f64 {
        self.0.read_double()
    }
    pub fn serialize_property_name(&mut self) -> String {
        self.0.read_fname()
    }
    pub fn serialize_property_string(&mut self) -> String {
        self.0.read_fstring()
    }

    pub fn serialize_rep_movement(
        &mut self,
        location_quantization_level: VectorQuantization,
        rotation_quantization_level: RotatorQuantization,
        velocity_quantization_level: VectorQuantization,
    ) -> FRepMovement {
        let b_simulated_physic_sleep = self.0.read_bit();
        let b_rep_physics = self.0.read_bit();
        let mut b_rep_server_frame = false;
        let mut b_rep_server_handle = false;

        if self.0.archive_state().EngineNetworkVersion
            >= EngineNetworkVersionHistory::HistoryRepmoveServerframeAndHandle
            && self.0.archive_state().EngineNetworkVersion
                != EngineNetworkVersionHistory::History21AndViewpitchOnlyDoNotUse
        {
            b_rep_server_frame = self.0.read_bit();
            b_rep_server_handle = self.0.read_bit();
        }

        let mut rep_movement = FRepMovement {
            bSimulatedPhysicSleep: b_simulated_physic_sleep,
            bRepPhysics: b_rep_physics,
            bRepAcceleration: false,
            ServerFrame: 0,
            ServerPhysicsHandle: 0,
            Location: Some(self.serialize_property_quantized_vector(location_quantization_level)),
            Rotation: Some(
                if rotation_quantization_level == RotatorQuantization::ByteComponents {
                    self.0.read_rotation()
                } else {
                    self.0.read_rotation_short()
                },
            ),
            LinearVelocity: Some(
                self.serialize_property_quantized_vector(velocity_quantization_level),
            ),
            AngularVelocity: None,
            Acceleration: None,
        };

        if rep_movement.bRepPhysics {
            rep_movement.AngularVelocity =
                Some(self.serialize_property_quantized_vector(velocity_quantization_level));
        }
        if b_rep_server_frame {
            rep_movement.ServerFrame = self.0.read_int_packed();
        }
        if b_rep_server_handle {
            rep_movement.ServerPhysicsHandle = self.0.read_int_packed();
        }

        if self.0.archive_state().EngineNetworkVersion
            >= EngineNetworkVersionHistory::RepMoveOptionalAcceleration
        {
            rep_movement.bRepAcceleration = self.0.read_bit();
            if rep_movement.bRepAcceleration {
                rep_movement.Acceleration =
                    Some(self.serialize_property_quantized_vector(velocity_quantization_level));
            }
        }
        rep_movement
    }

    pub fn serialize_property_vector(&mut self) -> FVector {
        self.0.read_fvector()
    }
    pub fn serialize_property_vector2d(&mut self) -> FVector2D {
        FVector2D::new(self.0.read_single() as f64, self.0.read_single() as f64)
    }
    pub fn serialize_property_vector_normal(&mut self) -> FVector {
        FVector::new(
            self.read_fixed_compressed_float(1.0, 16),
            self.read_fixed_compressed_float(1.0, 16),
            self.read_fixed_compressed_float(1.0, 16),
        )
    }
    pub fn serialize_property_vector10(&mut self) -> FVector {
        self.0.read_packed_vector(10.0, 24)
    }
    pub fn serialize_property_vector100(&mut self) -> FVector {
        self.0.read_packed_vector(100.0, 30)
    }

    pub fn read_fixed_compressed_float(&mut self, max_value: f64, num_bits: u32) -> f64 {
        let max_bit_value = (1i64 << (num_bits - 1)) - 1;
        let bias = 1u32 << (num_bits - 1);
        let ser_int_max = 1u32 << num_bits;
        let delta = self.0.read_serialized_int(ser_int_max);
        let unscaled_value = delta as i64 - bias as i64;
        if max_value > max_bit_value as f64 {
            let inv_scale = max_value / max_bit_value as f64;
            return unscaled_value as f64 * inv_scale;
        }
        let scale = max_bit_value as f64 / max_value;
        let inv_scale = 1.0 / scale;
        unscaled_value as f64 * inv_scale
    }

    pub fn serialize_property_rotator(&mut self) -> FRotator {
        self.0.read_rotation_short()
    }

    pub fn serialize_property_byte(&mut self, enum_max_value: u32) -> u8 {
        let bit_count = if enum_max_value > 0 {
            (enum_max_value as f64).log2().ceil() as u32
        } else {
            8
        };
        self.0.read_bits_to_int(bit_count)
    }

    pub fn serialize_property_bool(&mut self) -> bool {
        self.0.read_bit()
    }
    pub fn serialize_property_native_bool(&mut self) -> bool {
        self.0.read_bit()
    }
    pub fn serialize_property_enum(&mut self) -> u8 {
        let bits_left = self.0.get_bits_left();
        self.0.read_bits_to_int(bits_left.max(0) as u32)
    }
    pub fn serialize_property_object(&mut self) -> u32 {
        self.0.read_int_packed()
    }

    pub fn serialize_property_quantized_vector(
        &mut self,
        quantization_level: VectorQuantization,
    ) -> FVector {
        match quantization_level {
            VectorQuantization::RoundTwoDecimals => self.0.read_packed_vector(100.0, 30),
            VectorQuantization::RoundOneDecimal => self.0.read_packed_vector(10.0, 27),
            VectorQuantization::RoundWholeNumber => self.0.read_packed_vector(1.0, 24),
        }
    }

    pub fn serialize_property_net_id(&mut self) -> String {
        const TYPE_HASH_OTHER: u8 = 31;
        let encoding_flags = self.0.read_byte();
        let mut encoded = false;
        if (encoding_flags & unique_id_encoding_flags::IS_ENCODED) != 0 {
            encoded = true;
            if (encoding_flags & unique_id_encoding_flags::IS_EMPTY) != 0 {
                return String::new();
            }
        }
        let type_hash = (encoding_flags & unique_id_encoding_flags::TYPE_MASK) >> 3;
        if type_hash == 0 {
            return "NULL".to_string();
        }

        let mut b_valid_type_hash = type_hash != 0;
        if type_hash == TYPE_HASH_OTHER {
            let type_string = self.0.read_fstring();
            if type_string == "None" {
                b_valid_type_hash = false;
            }
        }
        if b_valid_type_hash {
            if encoded {
                let encoded_size = self.0.read_byte();
                return self.0.read_bytes_to_string(encoded_size as i64);
            }
            return self.0.read_fstring();
        }
        String::new()
    }
}
