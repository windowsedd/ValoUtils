//! Fixed-width unsigned integer arithmetic helpers.
//!
//! Port of `package/ts-replay-parser/src/transform/uint.ts`. The TS source
//! emulates C# `uint`/`ulong` wraparound semantics with `BigInt` masking;
//! Rust's native `u32`/`u64` already have exact wrapping arithmetic, so this
//! is a direct simplification, not a bignum port.

pub fn u32(value: u32) -> u32 {
    value
}

pub fn u64(value: u64) -> u64 {
    value
}

pub fn u8(value: u64) -> u8 {
    (value & 0xff) as u8
}

pub fn mul32(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}

pub fn mul64(a: u64, b: u64) -> u64 {
    a.wrapping_mul(b)
}

pub fn add64(a: u64, b: u64) -> u64 {
    a.wrapping_add(b)
}

pub fn sub64(a: u64, b: u64) -> u64 {
    a.wrapping_sub(b)
}

pub fn add32(a: u32, b: u32) -> u32 {
    a.wrapping_add(b)
}

pub fn sub32(a: u32, b: u32) -> u32 {
    a.wrapping_sub(b)
}

/// Rotate a 64-bit value right by `count` bits (mirrors TS `rotr64`, which
/// masks `count & 63` before rotating and returns the value unchanged when
/// the masked count is 0).
pub fn rotr64(value: u64, count: u32) -> u64 {
    let n = count & 63;
    if n == 0 {
        return value;
    }
    value.rotate_right(n)
}

pub fn rotl64(value: u64, count: u32) -> u64 {
    let n = count & 63;
    if n == 0 {
        return value;
    }
    value.rotate_left(n)
}

pub fn rotr32(value: u32, count: u32) -> u32 {
    let n = count & 31;
    if n == 0 {
        return value;
    }
    value.rotate_right(n)
}

pub fn rotl32(value: u32, count: u32) -> u32 {
    let n = count & 31;
    if n == 0 {
        return value;
    }
    value.rotate_left(n)
}

/// Rotate an 8-bit value right by `count` bits (mirrors TS `rotr8`, which
/// masks the input to 8 bits and `count & 7` before rotating).
pub fn rotr8(value: u8, count: u32) -> u8 {
    let n = (count & 7) as u32;
    if n == 0 {
        return value;
    }
    value.rotate_right(n)
}

/// Rotate an 8-bit value left by `count` bits (mirrors the C# reference's
/// `RotateLeft(byte, int)` overload, added for the 13.x transforms).
pub fn rotl8(value: u8, count: u32) -> u8 {
    let n = count & 7;
    if n == 0 {
        return value;
    }
    value.rotate_left(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotr64_zero_count_is_identity() {
        assert_eq!(rotr64(0x1234, 0), 0x1234);
        assert_eq!(rotr64(0x1234, 64), 0x1234);
    }

    #[test]
    fn rotr8_masks_to_byte() {
        assert_eq!(rotr8(0b1000_0001, 1), 0b1100_0000);
    }
}
