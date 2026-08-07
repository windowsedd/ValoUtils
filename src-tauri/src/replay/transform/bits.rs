//! Bit-permutation helpers used by the payload transform.
//! Port of `package/ts-replay-parser/src/transform/bits.ts`
//! (itself a direct port of the C# `SwapAdjacentBits` / `ReverseBits*` / `ShuffleBits64`).

const M64_55: u64 = 0x5555_5555_5555_5555;
const M64_33: u64 = 0x3333_3333_3333_3333;
const M64_0F: u64 = 0x0f0f_0f0f_0f0f_0f0f;
const M64_00FF: u64 = 0x00ff_00ff_00ff_00ff;

/// Swap each pair of adjacent bits in a 64-bit value.
pub fn swap_adjacent64(value: u64) -> u64 {
    ((value & M64_55) << 1) | ((value >> 1) & M64_55)
}

/// Swap each pair of adjacent bits in a 32-bit value.
pub fn swap_adjacent32(value: u32) -> u32 {
    ((value & 0x5555_5555) << 1) | ((value >> 1) & 0x5555_5555)
}

/// Swap each pair of adjacent bits in an 8-bit value.
pub fn swap_adjacent8(value: u8) -> u8 {
    ((value & 0x55) << 1) | ((value >> 1) & 0x55)
}

/// V12_11 64-bit shuffle: full bit-reversal cascade except the final 16-bit
/// swap is replaced by a 32-bit half swap. Mirrors `ShuffleBits64V12_11`.
pub fn shuffle_bits64_v12_11(value: u64) -> u64 {
    let mut v = value;
    v = ((v & M64_55) << 1) | ((v >> 1) & M64_55);
    v = ((v & M64_33) << 2) | ((v >> 2) & M64_33);
    v = ((v & M64_0F) << 4) | ((v >> 4) & M64_0F);
    v = ((v & M64_00FF) << 8) | ((v >> 8) & M64_00FF);
    // Native 12.11 swaps the 32-bit halves here, without the usual 16-bit swap.
    (v << 32) | (v >> 32)
}

/// Full 32-bit bit-reversal (mirrors `ReverseBits32`).
pub fn reverse_bits32(value: u32) -> u32 {
    let mut v = value;
    v = ((v & 0x5555_5555) << 1) | ((v >> 1) & 0x5555_5555);
    v = ((v & 0x3333_3333) << 2) | ((v >> 2) & 0x3333_3333);
    v = ((v & 0x0f0f_0f0f) << 4) | ((v >> 4) & 0x0f0f_0f0f);
    v = ((v & 0x00ff_00ff) << 8) | ((v >> 8) & 0x00ff_00ff);
    (v << 16) | (v >> 16)
}

/// Full 8-bit bit-reversal (mirrors `ReverseBits8`).
pub fn reverse_bits8(value: u8) -> u8 {
    let mut v = value;
    v = ((v & 0x55) << 1) | ((v >> 1) & 0x55);
    v = ((v & 0x33) << 2) | ((v >> 2) & 0x33);
    ((v & 0x0f) << 4) | ((v >> 4) & 0x0f)
}
