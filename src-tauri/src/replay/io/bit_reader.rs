//! BitReader — bit-granular reader (FBitArchive + BitReader merged).
//! Ported from `package/ts-replay-parser/src/io/bit-reader.ts`
//! (itself ported from Unreal.Core/BitReader.cs and FBitArchive.cs).

use std::collections::HashMap;

use super::enums::EngineNetworkVersionHistory;
use super::farchive::{ArchiveState, FArchive, SeekOrigin};
use super::models::{FQuat, FRotator, FTransform, FVector};
use super::unreal_names::unreal_name;

fn trim_nulls(s: &str) -> &str {
    s.trim_matches(|c| c == ' ' || c == '\0')
}

pub struct BitReader {
    state: ArchiveState,
    buffer: Vec<u8>,
    position: usize,
    pub last_bit: usize,
    pub mark_position: usize,
    /// Mirrors the TS `tempLastBit: Map<number, number>` keyed by a
    /// caller-supplied `index` (not an implicit LIFO stack) — `setTempEnd`/
    /// `restoreTempEnd` in the TS source store/restore by that explicit key,
    /// so this is ported as a HashMap rather than a `Vec` stack to stay
    /// byte-for-byte faithful to the original control flow.
    temp_last_bit: HashMap<u32, usize>,
}

impl FArchive for BitReader {
    fn archive_state(&self) -> &ArchiveState {
        &self.state
    }
    fn archive_state_mut(&mut self) -> &mut ArchiveState {
        &mut self.state
    }
}

impl BitReader {
    pub fn new(input: Vec<u8>, bit_count: Option<usize>) -> Self {
        // A caller-supplied `bit_count` can exceed the actual bytes handed in
        // (e.g. when it was read via a prior `read_bits`/`read_bytes` call
        // that itself hit end-of-stream and returned an empty/short buffer
        // while the declared bit count was computed from the bitstream
        // header before that failure). `can_read`/`at_end` only compare
        // against `last_bit`, so leaving it inflated makes those checks
        // report "readable" for bits that don't physically exist, and the
        // next byte-level read panics indexing past the end of `buffer`.
        // Clamping here keeps the invariant `last_bit <= buffer.len() * 8`
        // for every `BitReader`, without changing any of the read logic.
        let last_bit = bit_count.unwrap_or(input.len() * 8).min(input.len() * 8);
        BitReader {
            state: ArchiveState::default(),
            buffer: input,
            position: 0,
            last_bit,
            mark_position: 0,
            temp_last_bit: HashMap::new(),
        }
    }

    pub fn fill_buffer(&mut self, input: Vec<u8>, bit_count: Option<usize>) {
        self.last_bit = bit_count.unwrap_or(input.len() * 8).min(input.len() * 8);
        self.buffer = input;
        self.position = 0;
        self.state.IsError = false;
    }

    pub fn position(&self) -> usize {
        self.position
    }

    fn current_byte(&self) -> usize {
        self.position >> 3
    }

    pub fn at_end(&self) -> bool {
        self.position >= self.last_bit
    }

    pub fn can_read(&self, count: i64) -> bool {
        self.position as i64 + count <= self.last_bit as i64
    }

    pub fn peek_bit(&self) -> bool {
        if self.at_end() {
            return false;
        }
        (self.buffer[self.current_byte()] & (1 << (self.position & 7))) > 0
    }

    pub fn read_bit(&mut self) -> bool {
        if self.at_end() || self.state.IsError {
            self.state.IsError = true;
            return false;
        }
        let result = (self.buffer[self.current_byte()] & (1 << (self.position & 7))) > 0;
        self.position += 1;
        result
    }

    pub fn read_bits_to_int(&mut self, bit_count: u32) -> u8 {
        let mut result: u32 = 0;
        for i in 0..bit_count {
            if self.state.IsError {
                return 0;
            }
            if self.read_bit() {
                result |= 1u32.wrapping_shl(i);
            }
        }
        (result & 0xff) as u8
    }

    pub fn read_bits_to_long(&mut self, bit_count: u32) -> u64 {
        let mut result: u64 = 0;
        for i in 0..bit_count {
            if self.read_bit() {
                result |= 1u64 << i;
            }
        }
        result
    }

    pub fn read_bits(&mut self, bit_count: i64) -> Vec<u8> {
        if !self.can_read(bit_count) || bit_count < 0 {
            self.state.IsError = true;
            return Vec::new();
        }
        let bit_count = bit_count as usize;

        let bit_count_used_in_byte = self.position & 7;
        let byte_count = bit_count / 8;
        let extra_bits = bit_count % 8;
        if bit_count_used_in_byte == 0 && extra_bits == 0 {
            let start = self.current_byte();
            let result = self.buffer[start..start + byte_count].to_vec();
            self.position += bit_count;
            return result;
        }

        let mut result = vec![0u8; (bit_count + 7) / 8];
        let bit_count_left_in_byte = 8 - (self.position & 7);
        let current_byte = self.current_byte();
        let shift_delta: u32 = (1u32 << bit_count_used_in_byte) - 1;
        for i in 0..byte_count {
            let b0 = self.buffer[current_byte + i] as u32;
            let b1 = self.buffer[current_byte + i + 1] as u32;
            result[i] = (((b0 >> bit_count_used_in_byte) | ((b1 & shift_delta) << bit_count_left_in_byte)) & 0xff) as u8;
        }
        self.position += byte_count * 8;

        let rem = bit_count % 8;
        for i in 0..rem {
            let bit = (self.buffer[self.current_byte()] & (1 << (self.position & 7))) > 0;
            self.position += 1;
            if bit {
                let len = result.len();
                result[len - 1] |= 1 << i;
            }
        }
        result
    }

    pub fn read_boolean(&mut self) -> bool {
        self.read_bit()
    }

    pub fn peek_byte(&mut self) -> u8 {
        let result = self.read_byte();
        self.position = self.position.saturating_sub(8);
        result
    }

    pub fn read_byte(&mut self) -> u8 {
        // `read_byte` indexes `buffer` directly (and `buffer[current + 1]` when
        // unaligned), so it has to refuse the read at end-of-stream the same
        // way `read_bit`/`read_bytes` do instead of panicking.
        if !self.can_read(8) || self.state.IsError {
            self.state.IsError = true;
            return 0;
        }
        let bit_count_used_in_byte = self.position & 7;
        let bit_count_left_in_byte = 8 - (self.position & 7);
        let result = if bit_count_used_in_byte == 0 {
            self.buffer[self.current_byte()]
        } else {
            (((self.buffer[self.current_byte()] as u32) >> bit_count_used_in_byte)
                | (((self.buffer[self.current_byte() + 1] as u32) & ((1 << bit_count_used_in_byte) - 1))
                    << bit_count_left_in_byte))
                as u8
        };
        self.position += 8;
        result
    }

    pub fn read_bytes(&mut self, byte_count: i64) -> Vec<u8> {
        if !self.can_read(byte_count * 8) || byte_count < 0 {
            self.state.IsError = true;
            return Vec::new();
        }
        let byte_count = byte_count as usize;
        let bit_count_used_in_byte = self.position & 7;
        let bit_count_left_in_byte = 8 - (self.position & 7);
        let result = if bit_count_used_in_byte == 0 {
            let start = self.current_byte();
            self.buffer[start..start + byte_count].to_vec()
        } else {
            let mut output = vec![0u8; byte_count];
            for i in 0..byte_count {
                let b0 = self.buffer[self.current_byte() + i] as u32;
                let b1 = self.buffer[self.current_byte() + 1 + i] as u32;
                output[i] =
                    (((b0 >> bit_count_used_in_byte) | ((b1 & ((1 << bit_count_used_in_byte) - 1)) << bit_count_left_in_byte)) & 0xff)
                        as u8;
            }
            output
        };
        self.position += byte_count * 8;
        result
    }

    pub fn read_bytes_to_string(&mut self, count: i64) -> String {
        self.read_bytes(count).iter().map(|b| format!("{:02X}", b)).collect()
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
        let raw = self.read_bytes(length as i64);
        let decoded = if is_unicode {
            let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(&raw).into_owned()
        };
        trim_nulls(&decoded).to_string()
    }

    pub fn read_fname(&mut self) -> String {
        let is_hardcoded = self.read_bit();
        if is_hardcoded {
            let name_index = if self.state.EngineNetworkVersion < EngineNetworkVersionHistory::HistoryChannelNames {
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
        panic!("ReadFTransform not implemented on BitReader")
    }

    pub fn read_guid(&mut self, size: i64) -> String {
        self.read_bytes_to_string(size)
    }

    pub fn read_guid_default(&mut self) -> String {
        self.read_guid(16)
    }

    pub fn read_serialized_int(&mut self, max_value: u32) -> u32 {
        let mut value: u32 = 0;
        let mut mask: u32 = 1;
        while value.wrapping_add(mask) < max_value {
            if self.read_bit() {
                value |= mask;
            }
            mask = mask.wrapping_mul(2);
        }
        value
    }

    pub fn read_int16(&mut self) -> i16 {
        let value = self.read_bytes(2);
        if self.state.IsError {
            0
        } else {
            i16::from_le_bytes([value[0], value[1]])
        }
    }

    pub fn read_int32(&mut self) -> i32 {
        let value = self.read_bytes(4);
        if self.state.IsError {
            0
        } else {
            i32::from_le_bytes([value[0], value[1], value[2], value[3]])
        }
    }

    pub fn read_int32_as_boolean(&mut self) -> bool {
        self.read_int32() == 1
    }

    pub fn read_int64(&mut self) -> i64 {
        let value = self.read_bytes(8);
        if self.state.IsError {
            0
        } else {
            i64::from_le_bytes(value.try_into().unwrap())
        }
    }

    pub fn read_int_packed(&mut self) -> u32 {
        let bit_count_used_in_byte = (self.position & 7) as u32;
        let bit_count_left_in_byte = 8 - (self.position & 7);
        let src_mask_byte0: u32 = ((1u32 << bit_count_left_in_byte) - 1) & 0xff;
        let src_mask_byte1: u32 = ((1u32 << bit_count_used_in_byte) - 1) & 0xff;
        let mut src_index = self.current_byte();
        let mut next_src_index = if bit_count_used_in_byte != 0 { src_index + 1 } else { src_index };

        let mut value: u32 = 0;
        let mut shift_count: u32 = 0;
        for _it in 0..5 {
            if !self.can_read(8) {
                self.state.IsError = true;
                break;
            }
            if next_src_index >= self.buffer.len() {
                next_src_index = src_index;
            }
            self.position += 8;
            let read_byte = (((self.buffer[src_index] as u32) >> bit_count_used_in_byte) & src_mask_byte0)
                | (((self.buffer[next_src_index] as u32) & src_mask_byte1) << (bit_count_left_in_byte & 7));
            let read_byte = read_byte & 0xff;
            value = ((read_byte >> 1) << shift_count) | value;
            src_index += 1;
            next_src_index += 1;
            shift_count += 7;
            if (read_byte & 1) == 0 {
                break;
            }
        }
        value
    }

    pub fn read_fquat(&mut self) -> FQuat {
        panic!("ReadFQuat not implemented on BitReader")
    }

    pub fn read_fvector(&mut self) -> FVector {
        if self.state.EngineNetworkVersion >= EngineNetworkVersionHistory::HistoryPackedVectorLwcSupport {
            FVector::new(self.read_double(), self.read_double(), self.read_double())
        } else {
            FVector::new(self.read_single() as f64, self.read_single() as f64, self.read_single() as f64)
        }
    }

    pub fn read_packed_vector(&mut self, scale_factor: f64, max_bits: u32) -> FVector {
        if self.state.EngineNetworkVersion >= EngineNetworkVersionHistory::HistoryPackedVectorLwcSupport
            && self.state.EngineNetworkVersion != EngineNetworkVersionHistory::History21AndViewpitchOnlyDoNotUse
        {
            self.read_quantized_vector(scale_factor)
        } else {
            self.read_packed_vector_legacy(scale_factor, max_bits)
        }
    }

    fn read_quantized_vector(&mut self, scale_factor: f64) -> FVector {
        let component_bit_count_and_extra_info = self.read_serialized_int(1 << 7);
        let component_bit_count = component_bit_count_and_extra_info & 63;
        let extra_info = component_bit_count_and_extra_info >> 6;

        if component_bit_count > 0 {
            let x = self.read_bits_to_long(component_bit_count);
            let y = self.read_bits_to_long(component_bit_count);
            let z = self.read_bits_to_long(component_bit_count);
            let sign_bit: u64 = 1u64 << (component_bit_count - 1);
            let mut f_x = ((x ^ sign_bit) as i64 - sign_bit as i64) as f64;
            let mut f_y = ((y ^ sign_bit) as i64 - sign_bit as i64) as f64;
            let mut f_z = ((z ^ sign_bit) as i64 - sign_bit as i64) as f64;
            if extra_info > 0 {
                f_x /= scale_factor;
                f_y /= scale_factor;
                f_z /= scale_factor;
            }
            let mut v = FVector::new(f_x, f_y, f_z);
            v.Bits = component_bit_count;
            v.ScaleFactor = scale_factor;
            v
        } else if extra_info == 0 {
            let mut v = FVector::new(self.read_single() as f64, self.read_single() as f64, self.read_single() as f64);
            v.Bits = 32;
            v.ScaleFactor = scale_factor;
            v
        } else {
            let mut v = FVector::new(self.read_double(), self.read_double(), self.read_double());
            v.Bits = 64;
            v.ScaleFactor = scale_factor;
            v
        }
    }

    fn read_packed_vector_legacy(&mut self, scale_factor: f64, max_bits: u32) -> FVector {
        let bits = self.read_serialized_int(max_bits);
        if self.state.IsError {
            return FVector::new(0.0, 0.0, 0.0);
        }
        let bias = 1i64 << (bits + 1);
        let max = 1u32 << (bits + 2);
        let dx = self.read_serialized_int(max);
        let dy = self.read_serialized_int(max);
        let dz = self.read_serialized_int(max);
        if self.state.IsError {
            return FVector::new(0.0, 0.0, 0.0);
        }
        FVector::new(
            (dx as i64 - bias) as f64 / scale_factor,
            (dy as i64 - bias) as f64 / scale_factor,
            (dz as i64 - bias) as f64 / scale_factor,
        )
    }

    pub fn read_rotation(&mut self) -> FRotator {
        let mut pitch = 0.0;
        let mut yaw = 0.0;
        let mut roll = 0.0;
        if self.read_bit() {
            pitch = (self.read_byte() as f64 * 360.0) / 256.0;
        }
        if self.read_bit() {
            yaw = (self.read_byte() as f64 * 360.0) / 256.0;
        }
        if self.read_bit() {
            roll = (self.read_byte() as f64 * 360.0) / 256.0;
        }
        if self.state.IsError {
            return FRotator::new(0.0, 0.0, 0.0);
        }
        FRotator::new(pitch, yaw, roll)
    }

    pub fn read_rotation_short(&mut self) -> FRotator {
        let mut pitch = 0.0;
        let mut yaw = 0.0;
        let mut roll = 0.0;
        if self.read_bit() {
            pitch = (self.read_uint16() as f64 * 360.0) / 65536.0;
        }
        if self.read_bit() {
            yaw = (self.read_uint16() as f64 * 360.0) / 65536.0;
        }
        if self.read_bit() {
            roll = (self.read_uint16() as f64 * 360.0) / 65536.0;
        }
        if self.state.IsError {
            return FRotator::new(0.0, 0.0, 0.0);
        }
        FRotator::new(pitch, yaw, roll)
    }

    pub fn read_sbyte(&mut self) -> i8 {
        panic!("ReadSByte not implemented on BitReader")
    }

    pub fn read_single(&mut self) -> f32 {
        let b = self.read_bytes(4);
        if self.state.IsError {
            0.0
        } else {
            f32::from_le_bytes([b[0], b[1], b[2], b[3]])
        }
    }

    pub fn read_double(&mut self) -> f64 {
        let b = self.read_bytes(8);
        if self.state.IsError {
            0.0
        } else {
            f64::from_le_bytes(b.try_into().unwrap())
        }
    }

    pub fn read_uint16(&mut self) -> u16 {
        let b = self.read_bytes(2);
        if self.state.IsError {
            0
        } else {
            u16::from_le_bytes([b[0], b[1]])
        }
    }

    pub fn read_uint32(&mut self) -> u32 {
        let b = self.read_bytes(4);
        if self.state.IsError {
            0
        } else {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        }
    }

    pub fn read_uint32_as_boolean(&mut self) -> bool {
        panic!("ReadUInt32AsBoolean not implemented on BitReader")
    }

    pub fn read_uint64(&mut self) -> u64 {
        let b = self.read_bytes(8);
        if self.state.IsError {
            0
        } else {
            u64::from_le_bytes(b.try_into().unwrap())
        }
    }

    pub fn seek(&mut self, offset: i64, origin: SeekOrigin) {
        let buffer_len = self.buffer.len() as i64;
        let invalid = offset < 0
            || offset >> 3 > buffer_len
            || (offset >> 3 == buffer_len && (offset & 7) > 0)
            || (origin == SeekOrigin::Current && offset + self.position as i64 > buffer_len * 8);
        if invalid {
            self.state.IsError = true;
            return;
        }
        match origin {
            SeekOrigin::Begin => self.position = offset as usize,
            SeekOrigin::End => self.position = (buffer_len * 8 - offset) as usize,
            SeekOrigin::Current => self.position = (self.position as i64 + offset) as usize,
        }
    }

    pub fn skip_bytes(&mut self, byte_count: i64) {
        self.seek(byte_count * 8, SeekOrigin::Current);
    }

    pub fn skip_bits(&mut self, numbits: i64) {
        self.seek(numbits, SeekOrigin::Current);
    }

    pub fn mark(&mut self) {
        self.mark_position = self.position;
    }

    pub fn pop(&mut self) {
        self.position = self.mark_position;
    }

    pub fn get_bits_left(&self) -> i64 {
        self.last_bit as i64 - self.position as i64
    }

    pub fn append_data_from_checked(&mut self, data: &[u8], bit_count: usize) {
        self.last_bit += bit_count;
        self.buffer.extend_from_slice(data);
    }

    pub fn set_temp_end(&mut self, size: usize, index: u32) {
        let set_position = self.position + size;
        if set_position > self.last_bit {
            self.state.IsError = true;
            return;
        }
        self.temp_last_bit.insert(index, self.last_bit);
        self.last_bit = set_position;
    }

    pub fn restore_temp_end(&mut self, index: u32) {
        self.position = self.last_bit;
        match self.temp_last_bit.remove(&index) {
            Some(last_bit) => {
                self.last_bit = last_bit;
                self.state.IsError = false;
            }
            None => {
                // Defensive: this should only happen if the matching
                // `set_temp_end` never ran on *this* reader instance (e.g. a
                // `TempEndGuard` torn down against a reader that got swapped
                // for a different one — a placeholder from `mem::replace` —
                // while the guard was alive; see the fixed hazard in
                // `process_bunch`). Panicking here (as a raw HashMap index
                // would) during unwind from an earlier panic would abort the
                // whole process instead of letting `catch_unwind` further up
                // the stack gracefully swallow the one malformed bunch/field.
                // Mark the reader errored and leave `last_bit` as-is — safe
                // no-op behavior, matching what every other `IsError`-gated
                // read already does.
                self.state.IsError = true;
            }
        }
    }
}

#[cfg(test)]
mod vector_tests {
    use super::super::binary_reader::BinaryReader;
    use super::*;
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct ReaderTest {
        test: String,
        values: Vec<Value>,
    }

    // Same deterministic LCG the C# generator uses, so inputs match exactly.
    fn make_buf(byte_len: usize, seed: u32) -> Vec<u8> {
        let mut bytes = vec![0u8; byte_len];
        let mut s: u32 = if seed == 0 { 0x9e3779b9 } else { seed };
        for b in bytes.iter_mut() {
            s = (s.wrapping_mul(1664525)).wrapping_add(1013904223);
            *b = ((s >> 24) & 0xff) as u8;
        }
        bytes
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02X}", b)).collect()
    }

    fn load_vectors() -> std::collections::HashMap<String, Vec<Value>> {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../package/ts-replay-parser/src/io/__rvectors__.json"
        ))
        .expect("reference vectors file should exist");
        let raw = raw.trim_start_matches('\u{feff}');
        let tests: Vec<ReaderTest> = serde_json::from_str(raw).unwrap();
        assert!(!tests.is_empty());
        tests.into_iter().map(|t| (t.test, t.values)).collect()
    }

    fn as_i64(v: &Value) -> i64 {
        if let Some(n) = v.as_i64() {
            n
        } else if let Some(n) = v.as_u64() {
            n as i64
        } else if let Some(f) = v.as_f64() {
            f as i64
        } else {
            panic!("expected numeric value, got {v:?}")
        }
    }

    fn as_f64(v: &Value) -> f64 {
        v.as_f64().unwrap_or_else(|| panic!("expected numeric value, got {v:?}"))
    }

    fn as_str(v: &Value) -> String {
        v.as_str().unwrap_or_else(|| panic!("expected string value, got {v:?}")).to_string()
    }

    #[test]
    fn read_bit_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        let out: Vec<i64> = (0..200).map(|_| if br.read_bit() { 1 } else { 0 }).collect();
        let expected: Vec<i64> = vectors["readBit"].iter().map(as_i64).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_byte_unaligned_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        br.skip_bits(3);
        let out: Vec<i64> = (0..20).map(|_| br.read_byte() as i64).collect();
        let expected: Vec<i64> = vectors["readByte_unaligned3"].iter().map(as_i64).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_int32_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        let out: Vec<i64> = (0..8).map(|_| br.read_int32() as i64).collect();
        let expected: Vec<i64> = vectors["readInt32"].iter().map(as_i64).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_int_packed_matches_reference() {
        let vectors = load_vectors();
        let packed = vec![0x05, 0x83, 0x01, 0xff, 0x7f, 0x80, 0x80, 0x01, 0x00];
        let mut br = BitReader::new(packed, None);
        let out: Vec<i64> = (0..4).map(|_| br.read_int_packed() as i64).collect();
        let expected: Vec<i64> = vectors["readIntPacked"].iter().map(as_i64).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_int_packed_unaligned_matches_reference() {
        let vectors = load_vectors();
        let packed = vec![0x05, 0x83, 0x01, 0xff, 0x7f, 0x80, 0x80, 0x01, 0x00];
        let mut br = BitReader::new(packed, None);
        br.skip_bits(2);
        let out: Vec<i64> = (0..3).map(|_| br.read_int_packed() as i64).collect();
        let expected: Vec<i64> = vectors["readIntPacked_unaligned2"].iter().map(as_i64).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_serialized_int_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        let out: Vec<i64> = [2u32, 7, 16, 100, 1024].iter().map(|&max| br.read_serialized_int(max) as i64).collect();
        let expected: Vec<i64> = vectors["readSerializedInt"].iter().map(as_i64).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_bits_unaligned_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        br.skip_bits(5);
        let out: Vec<String> = [1i64, 7, 8, 13, 16, 31, 33].iter().map(|&n| hex(&br.read_bits(n))).collect();
        let expected: Vec<String> = vectors["readBits_unaligned5"].iter().map(as_str).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_bytes_unaligned_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        br.skip_bits(4);
        let out: Vec<String> = [1i64, 3, 8].iter().map(|&n| hex(&br.read_bytes(n))).collect();
        let expected: Vec<String> = vectors["readBytes_unaligned4"].iter().map(as_str).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn read_single_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        let out: Vec<f64> = (0..4).map(|_| br.read_single() as f64).collect();
        let expected: Vec<f64> = vectors["readSingle"].iter().map(as_f64).collect();
        // The TS test uses toBeCloseTo(_, 3) because it stringifies through a
        // widened f64; here we control the JSON parse precision exactly
        // (arbitrary_precision), so bit-exact equality is the stronger and
        // correct check.
        assert_eq!(out, expected);
    }

    #[test]
    fn read_double_matches_reference() {
        let vectors = load_vectors();
        let buf = make_buf(64, 0xabcdef01);
        let mut br = BitReader::new(buf, None);
        br.skip_bytes(16); // 4 singles consumed in C# before doubles
        let out: Vec<f64> = (0..2).map(|_| br.read_double()).collect();
        let expected: Vec<f64> = vectors["readDouble"].iter().map(as_f64).collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn binary_read_fstring_matches_reference() {
        let vectors = load_vectors();
        let s = b"Hello\0";
        let mut bytes = vec![0u8; 4 + s.len()];
        bytes[0..4].copy_from_slice(&(s.len() as i32).to_le_bytes());
        bytes[4..].copy_from_slice(s);
        let mut rdr = BinaryReader::new(bytes);
        let out = rdr.read_fstring();
        let expected = as_str(&vectors["binaryReadFString"][0]);
        assert_eq!(out, expected);
    }
}
