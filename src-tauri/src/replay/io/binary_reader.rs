//! BinaryReader — byte-granular reader.
//! Ported from `package/ts-replay-parser/src/io/binary-reader.ts`
//! (itself ported from Unreal.Core/BinaryReader.cs).

use super::enums::EngineNetworkVersionHistory;
use super::farchive::{ArchiveState, FArchive, SeekOrigin};
use super::models::{FQuat, FRotator, FTransform, FVector};
use super::unreal_names::unreal_name;

fn trim_nulls(s: &str) -> &str {
    s.trim_matches(|c| c == ' ' || c == '\0')
}

pub struct BinaryReader {
    state: ArchiveState,
    bytes: Vec<u8>,
    length: usize,
    position: usize,
}

impl FArchive for BinaryReader {
    fn archive_state(&self) -> &ArchiveState {
        &self.state
    }
    fn archive_state_mut(&mut self) -> &mut ArchiveState {
        &mut self.state
    }
}

impl BinaryReader {
    pub fn new(input: Vec<u8>) -> Self {
        let length = input.len();
        BinaryReader {
            state: ArchiveState::default(),
            bytes: input,
            length,
            position: 0,
        }
    }

    pub fn position(&self) -> usize {
        self.position
    }

    pub fn at_end(&self) -> bool {
        self.position >= self.length
    }

    // Matches C#/TS: strict less-than.
    pub fn can_read(&self, count: usize) -> bool {
        self.position + count < self.length
    }

    pub fn read_array<T>(&mut self, mut read: impl FnMut(&mut Self) -> T) -> Vec<T> {
        let count = self.read_uint32();
        (0..count).map(|_| read(self)).collect()
    }

    pub fn read_boolean(&mut self) -> bool {
        let result = self.bytes[self.position] != 0;
        self.position += 1;
        result
    }

    pub fn read_byte(&mut self) -> u8 {
        let result = self.bytes[self.position];
        self.position += 1;
        result
    }

    pub fn read_bytes(&mut self, byte_count: usize) -> Vec<u8> {
        let result = self.bytes[self.position..self.position + byte_count].to_vec();
        self.position += byte_count;
        result
    }

    pub fn read_bytes_to_string(&mut self, count: usize) -> String {
        self.read_bytes(count)
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect()
    }

    pub fn read_fstring(&mut self) -> String {
        let mut length = self.read_int32();
        if length == 0 {
            return String::new();
        }
        let is_unicode = length < 0;
        if is_unicode {
            length = -2 * length;
        }
        let raw = self.read_bytes(length as usize);
        let decoded = if is_unicode {
            let units: Vec<u16> = raw
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(&raw).into_owned()
        };
        trim_nulls(&decoded).to_string()
    }

    pub fn read_fname(&mut self) -> String {
        let is_hardcoded = self.read_boolean();
        if is_hardcoded {
            let name_index = if self.state.EngineNetworkVersion
                < EngineNetworkVersionHistory::HistoryChannelNames
            {
                self.read_uint32()
            } else {
                self.read_int_packed()
            };
            return unreal_name(name_index);
        }
        let in_string = self.read_fstring();
        self.read_int32(); // inNumber
        in_string
    }

    pub fn read_ftransform(&mut self) -> FTransform {
        FTransform {
            Rotation: Some(self.read_fquat()),
            Translation: Some(self.read_fvector()),
            Scale3D: Some(self.read_fvector()),
        }
    }

    pub fn read_fquat(&mut self) -> FQuat {
        FQuat {
            X: self.read_single() as f64,
            Y: self.read_single() as f64,
            Z: self.read_single() as f64,
            W: self.read_single() as f64,
        }
    }

    pub fn read_fvector(&mut self) -> FVector {
        FVector::new(
            self.read_single() as f64,
            self.read_single() as f64,
            self.read_single() as f64,
        )
    }

    pub fn read_guid(&mut self, size: usize) -> String {
        self.read_bytes_to_string(size)
    }

    pub fn read_guid_default(&mut self) -> String {
        self.read_guid(16)
    }

    pub fn read_int16(&mut self) -> i16 {
        let result = i16::from_le_bytes([self.bytes[self.position], self.bytes[self.position + 1]]);
        self.position += 2;
        result
    }

    pub fn read_int32(&mut self) -> i32 {
        let b = &self.bytes[self.position..self.position + 4];
        let result = i32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        self.position += 4;
        result
    }

    pub fn read_int32_as_boolean(&mut self) -> bool {
        self.read_uint32() >= 1
    }

    pub fn read_int64(&mut self) -> i64 {
        let b = &self.bytes[self.position..self.position + 8];
        let result = i64::from_le_bytes(b.try_into().unwrap());
        self.position += 8;
        result
    }

    pub fn read_int_packed(&mut self) -> u32 {
        let mut value: u32 = 0;
        let mut count: u32 = 0;
        loop {
            let mut next_byte = self.read_byte() as u32;
            let remaining = (next_byte & 1) == 1;
            next_byte >>= 1;
            value = value.wrapping_add(next_byte.wrapping_shl(7u32.wrapping_mul(count)));
            count += 1;
            if !remaining {
                break;
            }
        }
        value
    }

    pub fn read_sbyte(&mut self) -> i8 {
        let result = self.bytes[self.position] as i8;
        self.position += 1;
        result
    }

    pub fn read_single(&mut self) -> f32 {
        let b = &self.bytes[self.position..self.position + 4];
        let result = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        self.position += 4;
        result
    }

    pub fn read_double(&mut self) -> f64 {
        let b = &self.bytes[self.position..self.position + 8];
        let result = f64::from_le_bytes(b.try_into().unwrap());
        self.position += 8;
        result
    }

    pub fn read_uint16(&mut self) -> u16 {
        let result = u16::from_le_bytes([self.bytes[self.position], self.bytes[self.position + 1]]);
        self.position += 2;
        result
    }

    pub fn read_uint32(&mut self) -> u32 {
        let b = &self.bytes[self.position..self.position + 4];
        let result = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        self.position += 4;
        result
    }

    pub fn read_uint32_as_boolean(&mut self) -> bool {
        self.read_uint32() >= 1
    }

    pub fn read_uint64(&mut self) -> u64 {
        let b = &self.bytes[self.position..self.position + 8];
        let result = u64::from_le_bytes(b.try_into().unwrap());
        self.position += 8;
        result
    }

    pub fn seek(&mut self, offset: i64, origin: SeekOrigin) {
        let invalid = offset < 0
            || offset as usize > self.length
            || (origin == SeekOrigin::Current
                && offset + self.position as i64 > self.length as i64);
        if invalid {
            self.state.IsError = true;
            return;
        }
        match origin {
            SeekOrigin::Begin => self.position = offset as usize,
            SeekOrigin::End => self.position = self.length - offset as usize,
            SeekOrigin::Current => self.position = (self.position as i64 + offset) as usize,
        }
    }

    pub fn skip_bytes(&mut self, byte_count: usize) {
        self.position += byte_count;
    }

    pub fn read_frotator(&mut self) -> FRotator {
        FRotator::new(
            self.read_single() as f64,
            self.read_single() as f64,
            self.read_single() as f64,
        )
    }
}
