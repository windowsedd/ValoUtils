//! ValorantSeededPayloadTransform — Rust port.
//!
//! De-obfuscates a replicated-bunch payload using a seed derived from the
//! payload bit-length and the channel's actor GUID. Riot re-keys and reshapes
//! this cipher every release; one variant exists per supported branch string:
//!   - release-12.10 (also the fallback for anything older/unrecognized)
//!   - release-12.11
//!   - release-13.00
//!   - release-13.01
//!   - release-13.02
//!
//! 12.10/12.11 were ported from `package/ts-replay-parser/src/transform/index.ts`;
//! the 13.x variants were ported directly from the C# reference
//! (michel-giehl/ValorantReplayParser, `PayloadEncryption/VersionedTransforms/`),
//! which the TS package does not implement. Parity for all five is pinned by
//! `test-fixtures/transform-vectors-csharp.json` — the C# suite's own
//! `KnownTransformVectors`.

use super::bits::{
    reverse_bits32, reverse_bits8, shuffle_bits64_v12_11, swap_adjacent32, swap_adjacent64,
    swap_adjacent8,
};
use super::tables::{SUBSTITUTE_TABLE_32, SUBSTITUTE_TABLE_64, SUBSTITUTE_TABLE_8};
use super::uint::{add64, mul32, mul64, rotl32, rotl64, rotl8, rotr32, rotr64, rotr8, u8 as to_u8};

const MULTIPLIER: u64 = 0x2545_f491_4f6c_dd1d;
const SEED_ADDEND_V12_10: u32 = 0x12fd_0ee5;
const SEED_ADDEND_V12_11: u32 = 0x409d_36a3;
const SEED_ADDEND_V13_00: u32 = 0x2949_b6ef;
const SEED_ADDEND_V13_01: u32 = 0xe62f_cd5c;
const SEED_ADDEND_V13_02: u32 = 0x9e81_a37c;
const INIT_A_OFFSET_V12_10: u32 = 0x1b;
const INIT_A_OFFSET_V12_11: u32 = 0x23;
const INIT_A_OFFSET_V13_00: u32 = 0x11;
const INIT_A_OFFSET_V13_01: u32 = 0x24;
const INIT_A_OFFSET_V13_02: u32 = 0x04;
const TAIL_XOR_V12_10: u8 = 0xe5;
const TAIL_XOR_V12_11: u8 = 0xa3;
const TAIL_XOR_V13_00: u8 = 0xef;
const TAIL_XOR_V13_01: u8 = 0x5c;
const TAIL_XOR_V13_02: u8 = 0x7c;
const U64_NOT: u64 = 0xffff_ffff_ffff_ffff;

#[derive(Clone, Copy, PartialEq)]
enum TransformVersion {
    V12_10,
    V12_11,
    V13_00,
    V13_01,
    V13_02,
}

struct TransformState {
    state: u32,
    prng_a: u64,
    prng_b: u64,
    stream_byte: u8,
}

/// Map a replay branch string onto its cipher variant.
///
/// The C# reference keys an exact-match dictionary on the full branch string
/// and *throws* on anything unknown. This port instead picks the newest
/// variant that is `<=` the replay's release, so an unrecognized branch still
/// gets the closest algorithm we know rather than aborting the parse:
/// pre-12.11 (and unparseable branches) fall back to 12.10, and a future
/// 13.03+ replay is attempted with 13.02. That guess will produce garbage if
/// Riot re-keyed again — the symptom is a replay that parses structurally but
/// yields no movement samples, which is the cue to port the next variant from
/// the C# reference.
fn resolve_version(branch: Option<&str>) -> TransformVersion {
    let Some(branch) = branch else {
        return TransformVersion::V12_10;
    };
    let Some((major, minor)) = parse_release(branch) else {
        return TransformVersion::V12_10;
    };
    match (major, minor) {
        (12, 10) => TransformVersion::V12_10,
        (12, 11) => TransformVersion::V12_11,
        (13, 0) => TransformVersion::V13_00,
        (13, 1) => TransformVersion::V13_01,
        (13, 2) => TransformVersion::V13_02,
        _ if major > 13 || (major == 13 && minor > 2) => TransformVersion::V13_02,
        _ => TransformVersion::V12_10,
    }
}

/// Mirrors the TS regex `/release-(\d+)\.(\d+)/i` — case-insensitive search
/// for "release-<major>.<minor>" anywhere in the branch string.
fn parse_release(branch: &str) -> Option<(u32, u32)> {
    let lower = branch.to_ascii_lowercase();
    let idx = lower.find("release-")?;
    let rest = &lower[idx + "release-".len()..];
    let chars = rest.char_indices();
    let major_end = chars
        .clone()
        .find(|(_, c)| !c.is_ascii_digit())
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    if major_end == 0 {
        return None;
    }
    let after_major = &rest[major_end..];
    if !after_major.starts_with('.') {
        return None;
    }
    let minor_str_start = major_end + 1;
    let minor_rest = &rest[minor_str_start..];
    let minor_end = minor_rest
        .char_indices()
        .find(|(_, c)| !c.is_ascii_digit())
        .map(|(i, _)| i)
        .unwrap_or(minor_rest.len());
    if minor_end == 0 {
        return None;
    }
    let major: u32 = rest[..major_end].parse().ok()?;
    let minor: u32 = minor_rest[..minor_end].parse().ok()?;
    Some((major, minor))
}

pub fn apply_transform(payload: &[u8], bit_count: u32, seed: u32, branch: Option<&str>) -> Vec<u8> {
    match resolve_version(branch) {
        TransformVersion::V12_11 => apply_v12_11(payload, bit_count, seed),
        TransformVersion::V12_10 => apply_v12_10(payload, bit_count, seed),
        TransformVersion::V13_00 => apply_v13_00(payload, bit_count, seed),
        TransformVersion::V13_01 => apply_v13_01(payload, bit_count, seed),
        TransformVersion::V13_02 => apply_v13_02(payload, bit_count, seed),
    }
}

// ---- PRNG initialisation -------------------------------------------------

fn initial_prng_a(seed: u32) -> u64 {
    let seed_plus = seed.wrapping_add(SEED_ADDEND_V12_10);
    let mixed = (((seed_plus >> 15) ^ seed_plus) >> 12)
        ^ mul32(seed.wrapping_sub(INIT_A_OFFSET_V12_10), 0x0200_0000)
        ^ seed_plus;
    mul64(mixed as u64, MULTIPLIER)
}

fn initial_prng_a_v12_11(seed: u32) -> u64 {
    let seed_plus = seed.wrapping_add(SEED_ADDEND_V12_11);
    let mixed = (((seed_plus >> 15) ^ seed_plus) >> 12)
        ^ mul32(seed.wrapping_add(INIT_A_OFFSET_V12_11), 0x0200_0000)
        ^ seed_plus;
    mul64(mixed as u64, MULTIPLIER)
}

/// `InitialPrngA` for the 13.x variants. Same shape as 12.10's (the offset is
/// *subtracted* from the seed, unlike 12.11's addition) — only the two
/// per-release constants differ, so they're parameters rather than three
/// copies of the function.
fn initial_prng_a_13x(seed: u32, seed_addend: u32, init_a_offset: u32) -> u64 {
    let seed_plus = seed.wrapping_add(seed_addend);
    let mixed = (((seed_plus >> 15) ^ seed_plus) >> 12)
        ^ mul32(seed.wrapping_sub(init_a_offset), 0x0200_0000)
        ^ seed_plus;
    mul64(mixed as u64, MULTIPLIER)
}

fn initial_prng_b(seed: u32) -> u64 {
    let mixed = (((seed >> 15) ^ seed) >> 12) ^ (seed << 25) ^ seed;
    mul64(mixed as u64, MULTIPLIER)
}

fn advance_transform_state(s: &mut TransformState) {
    let sum = add64(s.prng_b, s.prng_a);
    s.prng_b ^= s.prng_a;
    s.prng_a = rotr64(s.prng_a, 9) ^ (s.prng_b << 14) ^ s.prng_b;
    s.prng_b = rotl64(s.prng_b, 36);
    s.state = (sum >> 32) as u32;
    s.stream_byte = to_u8(s.state as u64);
}

// ---- Transform constants (per bit-width) ---------------------------------

struct Constants32 {
    addend1: u32,
    addend2: u32,
    rotate1: u32,
    rotate2: u32,
}

fn transform_constants64(state: u32) -> Constants32 {
    Constants32 {
        addend1: rotr32(state, 4),
        addend2: rotr32(state, 6),
        rotate1: (rotr32(state, 5) % 63) + 1,
        rotate2: (rotr32(state, 8) % 63) + 1,
    }
}

fn transform_constants32(state: u32) -> Constants32 {
    Constants32 {
        addend1: rotl32(state, 4),
        addend2: rotl32(state, 6),
        rotate1: (rotl32(state, 5) % 31) + 1,
        rotate2: (rotl32(state, 8) % 31) + 1,
    }
}

struct Constants8 {
    addend1: u8,
    addend2: u8,
    rotate1: u32,
    rotate2: u32,
}

fn transform_constants8(state: u32) -> Constants8 {
    Constants8 {
        addend1: to_u8(mul32(state, 0x31) as u64),
        addend2: to_u8(mul32(state, 0x29) as u64),
        rotate1: (mul32(state, 0x0002_751b) % 7) + 1,
        rotate2: (mul32(state, 0x0cc6_db61) % 7) + 1,
    }
}

// ---- V12_10 ---------------------------------------------------------------

fn apply_v12_10(payload: &[u8], bit_count: u32, seed: u32) -> Vec<u8> {
    let mut output = payload.to_vec();
    let mut s = TransformState {
        state: seed,
        prng_a: initial_prng_a(seed),
        prng_b: initial_prng_b(seed),
        stream_byte: to_u8(seed as u64),
    };
    let mut byte_offset = 0usize;
    let mut bits_remaining = bit_count as i64;

    while bits_remaining > 63 {
        let c = transform_constants64(s.state);
        let mut v = u64::from_le_bytes(output[byte_offset..byte_offset + 8].try_into().unwrap());
        v = rotr64(v, c.rotate2);
        v = swap_adjacent64(v);
        v = v.wrapping_sub(c.addend2 as u64);
        v = rotr64(v, c.rotate1);
        v = swap_adjacent64(v ^ (U64_NOT ^ (c.addend1 as u64)));
        output[byte_offset..byte_offset + 8].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 8;
        bits_remaining -= 64;
    }

    while bits_remaining > 31 {
        let c = transform_constants32(s.state);
        let mut v = u32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap());
        v = rotr32(v, c.rotate2);
        v = swap_adjacent32(v);
        v = v.wrapping_sub(c.addend2);
        v = rotr32(v, c.rotate1);
        v = swap_adjacent32(v ^ c.addend1);
        output[byte_offset..byte_offset + 4].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 4;
        bits_remaining -= 32;
    }

    while bits_remaining > 7 {
        let c = transform_constants8(s.state);
        let mut v = output[byte_offset];
        v = rotr8(v, c.rotate2);
        v = swap_adjacent8(v);
        v = v.wrapping_sub(c.addend2);
        v = rotr8(v, c.rotate1);
        v = swap_adjacent8(v ^ c.addend1);
        output[byte_offset] = v;
        advance_transform_state(&mut s);
        byte_offset += 1;
        bits_remaining -= 8;
    }

    if bits_remaining != 0 {
        let mask = (0xffu32 >> (7 - ((bit_count.wrapping_sub(1)) & 7))) as u8;
        output[byte_offset] ^= mask & (s.stream_byte ^ TAIL_XOR_V12_10);
    }

    output
}

// ---- V12_11 ---------------------------------------------------------------

fn apply_v12_11(payload: &[u8], bit_count: u32, seed: u32) -> Vec<u8> {
    let mut output = payload.to_vec();
    let mut s = TransformState {
        state: seed,
        prng_a: initial_prng_a_v12_11(seed),
        prng_b: initial_prng_b(seed),
        stream_byte: to_u8(seed as u64),
    };
    let mut byte_offset = 0usize;
    let mut bits_remaining = bit_count as i64;

    while bits_remaining > 63 {
        // state is a uint in C#, so these bind to the 32-bit rotate overload,
        // then zero-extend to u64 when combined with the 64-bit value.
        let ror2 = rotr32(s.state, 2) as u64;
        let ror3 = rotr32(s.state, 3) as u64;
        let ror4 = rotr32(s.state, 4) as u64;
        let ror6 = rotr32(s.state, 6) as u64;
        let ror8 = rotr32(s.state, 8) as u64;
        let mut v = u64::from_le_bytes(output[byte_offset..byte_offset + 8].try_into().unwrap());
        v = rotr64(v, (ror8 % 63) as u32 + 1);
        v = swap_adjacent64(v);
        v = add64(v, ror6);
        v = shuffle_bits64_v12_11(v);
        v = v.wrapping_sub(ror4);
        v = v.wrapping_sub(ror3);
        v = v.wrapping_sub(ror2);
        v = swap_adjacent64(v);
        output[byte_offset..byte_offset + 8].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 8;
        bits_remaining -= 64;
    }

    while bits_remaining > 31 {
        let rol2 = rotl32(s.state, 2);
        let rol3 = rotl32(s.state, 3);
        let rol4 = rotl32(s.state, 4);
        let rol6 = rotl32(s.state, 6);
        let rol8 = rotl32(s.state, 8);
        let mut v = u32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap());
        v = rotr32(v, (rol8 % 31) + 1);
        v = swap_adjacent32(v);
        v = v.wrapping_add(rol6);
        v = reverse_bits32(v);
        v = v.wrapping_sub(rol4);
        v = v.wrapping_sub(rol3);
        v = v.wrapping_sub(rol2);
        v = swap_adjacent32(v);
        output[byte_offset..byte_offset + 4].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 4;
        bits_remaining -= 32;
    }

    while bits_remaining > 7 {
        let state_byte = to_u8(s.state as u64);
        let rotate2_input = mul32(s.state, 0x0cc6_db61);
        let mut v = output[byte_offset];
        v = rotr8(v, (rotate2_input % 7) + 1);
        v = swap_adjacent8(v);
        v = v.wrapping_add(to_u8(mul32(state_byte as u32, 0x29) as u64));
        v = reverse_bits8(v);
        v = v.wrapping_add(to_u8(mul32(state_byte as u32, 0x23) as u64));
        v = swap_adjacent8(v);
        output[byte_offset] = v;
        advance_transform_state(&mut s);
        byte_offset += 1;
        bits_remaining -= 8;
    }

    if bits_remaining != 0 {
        let mask = (0xffu32 >> (7 - ((bit_count.wrapping_sub(1)) & 7))) as u8;
        output[byte_offset] ^= mask & (s.stream_byte ^ TAIL_XOR_V12_11);
    }

    output
}

// ---- 13.x shared helpers ---------------------------------------------------

/// C# `SubstituteBytes(ulong, byte[])` — independent table lookup per byte.
fn substitute_bytes64(value: u64, table: &[u8; 256]) -> u64 {
    let mut out = 0u64;
    for i in 0..8 {
        out |= (table[((value >> (i * 8)) & 0xff) as usize] as u64) << (i * 8);
    }
    out
}

/// C# `SubstituteBytes(uint, byte[])`.
fn substitute_bytes32(value: u32, table: &[u8; 256]) -> u32 {
    let mut out = 0u32;
    for i in 0..4 {
        out |= (table[((value >> (i * 8)) & 0xff) as usize] as u32) << (i * 8);
    }
    out
}

/// The trailing `bits_remaining != 0` tail step, identical across every
/// variant apart from its `TAIL_XOR_*` constant.
fn apply_tail(
    output: &mut [u8],
    byte_offset: usize,
    bit_count: u32,
    stream_byte: u8,
    tail_xor: u8,
) {
    let mask = (0xffu32 >> (7 - ((bit_count.wrapping_sub(1)) & 7))) as u8;
    output[byte_offset] ^= mask & (stream_byte ^ tail_xor);
}

// ---- V13_00 ---------------------------------------------------------------

fn apply_v13_00(payload: &[u8], bit_count: u32, seed: u32) -> Vec<u8> {
    let mut output = payload.to_vec();
    let mut s = TransformState {
        state: seed,
        prng_a: initial_prng_a_13x(seed, SEED_ADDEND_V13_00, INIT_A_OFFSET_V13_00),
        prng_b: initial_prng_b(seed),
        stream_byte: to_u8(seed as u64),
    };
    let mut byte_offset = 0usize;
    let mut bits_remaining = bit_count as i64;

    while bits_remaining > 63 {
        // `state` is a C# `uint`, so every rotate here is the 32-bit overload,
        // zero-extended when it meets the 64-bit value.
        let ror1 = rotr32(s.state, 1);
        let ror3 = rotr32(s.state, 3) as u64;
        let ror6 = rotr32(s.state, 6) as u64;
        let ror8 = rotr32(s.state, 8) as u64;
        let mut v = u64::from_le_bytes(output[byte_offset..byte_offset + 8].try_into().unwrap());
        v = add64(v, ror8);
        v = shuffle_bits64_v12_11(v);
        v = add64(v, ror6) ^ ror3;
        v = substitute_bytes64(v, &SUBSTITUTE_TABLE_64);
        v = rotr64(v, (ror1 % 63) + 1);
        output[byte_offset..byte_offset + 8].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 8;
        bits_remaining -= 64;
    }

    while bits_remaining > 31 {
        let rol1 = rotl32(s.state, 1);
        let rol3 = rotl32(s.state, 3);
        let rol6 = rotl32(s.state, 6);
        let rol8 = rotl32(s.state, 8);
        let mut v = u32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap());
        v = v.wrapping_add(rol8);
        v = reverse_bits32(v);
        v = !v.wrapping_add(rol6) ^ rol3;
        v = substitute_bytes32(v, &SUBSTITUTE_TABLE_32);
        v = rotr32(v, (rol1 % 31) + 1);
        output[byte_offset..byte_offset + 4].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 4;
        bits_remaining -= 32;
    }

    while bits_remaining > 7 {
        let mix = to_u8(mul32(s.state, 0x533) as u64);
        let mut v = output[byte_offset];
        v = v.wrapping_add(mix.wrapping_mul(0x1b));
        v = reverse_bits8(v);
        v = !v.wrapping_add(mix.wrapping_mul(0x33)) ^ mix;
        v = SUBSTITUTE_TABLE_8[v as usize];
        v = rotr8(v, (mul32(s.state, 0x0b) % 7) + 1);
        output[byte_offset] = v;
        advance_transform_state(&mut s);
        byte_offset += 1;
        bits_remaining -= 8;
    }

    if bits_remaining != 0 {
        apply_tail(
            &mut output,
            byte_offset,
            bit_count,
            s.stream_byte,
            TAIL_XOR_V13_00,
        );
    }

    output
}

// ---- V13_01 ---------------------------------------------------------------

fn apply_v13_01(payload: &[u8], bit_count: u32, seed: u32) -> Vec<u8> {
    let mut output = payload.to_vec();
    let mut s = TransformState {
        state: seed,
        prng_a: initial_prng_a_13x(seed, SEED_ADDEND_V13_01, INIT_A_OFFSET_V13_01),
        prng_b: initial_prng_b(seed),
        stream_byte: to_u8(seed as u64),
    };
    let mut byte_offset = 0usize;
    let mut bits_remaining = bit_count as i64;

    while bits_remaining > 63 {
        let mut v = u64::from_le_bytes(output[byte_offset..byte_offset + 8].try_into().unwrap());
        // `~(ulong)RotateRight(state, 5)`: the 32-bit rotate is zero-extended
        // to 64 bits *before* the complement, so the high half becomes all-ones.
        v = swap_adjacent64(!v) ^ !(rotr32(s.state, 5) as u64);
        v = !rotr64(v, (rotr32(s.state, 4) % 63) + 1);
        v = add64(v, rotr32(s.state, 1) as u64);
        output[byte_offset..byte_offset + 8].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 8;
        bits_remaining -= 64;
    }

    while bits_remaining > 31 {
        let mut v = u32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap());
        v = swap_adjacent32(!v) ^ rotl32(s.state, 5);
        v = !rotr32(v, (rotl32(s.state, 4) % 31) + 1);
        v = v.wrapping_add(rotl32(s.state, 1));
        output[byte_offset..byte_offset + 4].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 4;
        bits_remaining -= 32;
    }

    while bits_remaining > 7 {
        let state11 = mul32(s.state, 0x0b);
        let mix = mul32(state11, 0x533);
        let mut v = output[byte_offset];
        v = swap_adjacent8(!v) ^ to_u8(mul32(mix, 0x0b) as u64);
        v = !rotr8(v, (mix % 7) + 1);
        v = v.wrapping_add(to_u8(state11 as u64));
        output[byte_offset] = v;
        advance_transform_state(&mut s);
        byte_offset += 1;
        bits_remaining -= 8;
    }

    if bits_remaining != 0 {
        apply_tail(
            &mut output,
            byte_offset,
            bit_count,
            s.stream_byte,
            TAIL_XOR_V13_01,
        );
    }

    output
}

// ---- V13_02 ---------------------------------------------------------------

fn apply_v13_02(payload: &[u8], bit_count: u32, seed: u32) -> Vec<u8> {
    let mut output = payload.to_vec();
    let mut s = TransformState {
        state: seed,
        prng_a: initial_prng_a_13x(seed, SEED_ADDEND_V13_02, INIT_A_OFFSET_V13_02),
        prng_b: initial_prng_b(seed),
        stream_byte: to_u8(seed as u64),
    };
    let mut byte_offset = 0usize;
    let mut bits_remaining = bit_count as i64;

    while bits_remaining > 63 {
        // Unlike 13.00, the substitution happens *first* here.
        let raw = u64::from_le_bytes(output[byte_offset..byte_offset + 8].try_into().unwrap());
        let ror2 = rotr32(s.state, 2);
        let ror3 = rotr32(s.state, 3);
        let ror6 = rotr32(s.state, 6) as u64;
        let mut v = substitute_bytes64(raw, &SUBSTITUTE_TABLE_64);
        v = shuffle_bits64_v12_11(v);
        v = !v.wrapping_sub(ror6);
        v = shuffle_bits64_v12_11(v);
        v = rotl64(v, (ror3 % 63) + 1);
        v = rotr64(v, (ror2 % 63) + 1);
        output[byte_offset..byte_offset + 8].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 8;
        bits_remaining -= 64;
    }

    while bits_remaining > 31 {
        let raw = u32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap());
        let rol2 = rotl32(s.state, 2);
        let rol3 = rotl32(s.state, 3);
        let rol6 = rotl32(s.state, 6);
        let mut v = substitute_bytes32(raw, &SUBSTITUTE_TABLE_32);
        v = reverse_bits32(v);
        v = !v.wrapping_sub(rol6);
        v = reverse_bits32(v);
        v = rotl32(v, (rol3 % 31) + 1);
        v = rotr32(v, (rol2 % 31) + 1);
        output[byte_offset..byte_offset + 4].copy_from_slice(&v.to_le_bytes());
        advance_transform_state(&mut s);
        byte_offset += 4;
        bits_remaining -= 32;
    }

    while bits_remaining > 7 {
        let mix_a = mul32(s.state, 0x79);
        let mix_b = mul32(mix_a, 0x0b);
        let mut v = SUBSTITUTE_TABLE_8[output[byte_offset] as usize];
        v = reverse_bits8(v);
        v = !v.wrapping_sub(to_u8(mul32(mix_b, 0x33) as u64));
        v = reverse_bits8(v);
        v = rotl8(v, (mix_b % 7) + 1);
        v = rotr8(v, (mix_a % 7) + 1);
        output[byte_offset] = v;
        advance_transform_state(&mut s);
        byte_offset += 1;
        bits_remaining -= 8;
    }

    if bits_remaining != 0 {
        apply_tail(
            &mut output,
            byte_offset,
            bit_count,
            s.stream_byte,
            TAIL_XOR_V13_02,
        );
    }

    output
}

#[cfg(test)]
mod vector_tests {
    use super::apply_transform;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vector {
        branch: String,
        seed: u32,
        bits: u32,
        input: String,
        output: String,
    }

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn bytes_to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02X}", b)).collect()
    }

    /// The C# suite's own `ValorantSeededTransformTests.KnownTransformVectors`,
    /// transcribed to JSON (input = the first `ceil(bits/8)` bytes of its
    /// `PayloadHex` with the trailing partial byte masked, seed = `bits ^ 2`).
    /// Covers all five branches — including 12.10/12.11, which double as a
    /// check that the transcription itself is faithful.
    #[test]
    fn all_branch_vectors_match_csharp_reference() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/transform-vectors-csharp.json"
        ))
        .expect("C# reference vectors file should exist");
        let vectors: Vec<Vector> =
            serde_json::from_str(raw.trim_start_matches('\u{feff}')).unwrap();
        assert_eq!(vectors.len(), 55);

        for v in &vectors {
            let input = hex_to_bytes(&v.input);
            let result = apply_transform(&input, v.bits, v.seed, Some(v.branch.as_str()));
            assert_eq!(
                bytes_to_hex(&result),
                v.output,
                "branch={} seed={} bits={}",
                v.branch,
                v.seed,
                v.bits
            );
        }
    }

    #[test]
    fn transform_vectors_match_csharp_reference() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../package/ts-replay-parser/src/transform/__vectors__.json"
        ))
        .expect("reference vectors file should exist");
        let raw = raw.trim_start_matches('\u{feff}');
        let vectors: Vec<Vector> = serde_json::from_str(raw).unwrap();
        assert!(!vectors.is_empty());

        for v in &vectors {
            let input = hex_to_bytes(&v.input);
            let result = apply_transform(&input, v.bits, v.seed, Some(v.branch.as_str()));
            assert_eq!(
                bytes_to_hex(&result),
                v.output,
                "branch={} seed={} bits={}",
                v.branch,
                v.seed,
                v.bits
            );
        }
    }
}
