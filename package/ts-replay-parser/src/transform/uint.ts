/**
 * Fixed-width unsigned integer arithmetic helpers.
 *
 * The C# source relies on `uint` (32-bit) and `ulong` (64-bit) wrapping
 * semantics. JavaScript `number` cannot represent 64-bit integers exactly,
 * and its bitwise operators coerce to *signed* 32-bit, so we implement the
 * 64-bit paths with `BigInt` and keep 32-bit math explicit and masked.
 */

export const U32_MASK = 0xffffffff;
export const U64_MASK = 0xffffffffffffffffn;

/** Coerce to an unsigned 32-bit value (mirrors C# `(uint)`). */
export function u32(value: number): number {
  return value >>> 0;
}

/** Coerce a bigint to an unsigned 64-bit value (mirrors C# `(ulong)`). */
export function u64(value: bigint): bigint {
  return value & U64_MASK;
}

/** Truncate to the low 8 bits (mirrors C# `(byte)`). */
export function u8(value: number | bigint): number {
  return Number(BigInt(value) & 0xffn);
}

/** 32-bit unsigned multiply with wraparound (mirrors C# `uint * uint`). */
export function mul32(a: number, b: number): number {
  // Use BigInt to avoid float precision loss above 2^53, then mask.
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) & BigInt(U32_MASK));
}

/** 64-bit unsigned multiply with wraparound. */
export function mul64(a: bigint, b: bigint): bigint {
  return u64(a * b);
}

/** 64-bit unsigned add with wraparound. */
export function add64(a: bigint, b: bigint): bigint {
  return u64(a + b);
}

/** 64-bit unsigned subtract with wraparound. */
export function sub64(a: bigint, b: bigint): bigint {
  return u64(a - b);
}

/** 32-bit unsigned add with wraparound. */
export function add32(a: number, b: number): number {
  return (a + b) >>> 0;
}

/** 32-bit unsigned subtract with wraparound. */
export function sub32(a: number, b: number): number {
  return (a - b) >>> 0;
}

/** Rotate a 64-bit value right by `count` bits. */
export function rotr64(value: bigint, count: number): bigint {
  const n = BigInt(count & 63);
  if (n === 0n) return u64(value);
  return u64((value >> n) | (value << (64n - n)));
}

/** Rotate a 64-bit value left by `count` bits. */
export function rotl64(value: bigint, count: number): bigint {
  const n = BigInt(count & 63);
  if (n === 0n) return u64(value);
  return u64((value << n) | (value >> (64n - n)));
}

/** Rotate a 32-bit value right by `count` bits. */
export function rotr32(value: number, count: number): number {
  const n = count & 31;
  if (n === 0) return value >>> 0;
  return (((value >>> n) | (value << (32 - n))) >>> 0);
}

/** Rotate a 32-bit value left by `count` bits. */
export function rotl32(value: number, count: number): number {
  const n = count & 31;
  if (n === 0) return value >>> 0;
  return (((value << n) | (value >>> (32 - n))) >>> 0);
}

/** Rotate an 8-bit value right by `count` bits. */
export function rotr8(value: number, count: number): number {
  const v = value & 0xff;
  const n = count & 7;
  if (n === 0) return v;
  return ((v >>> n) | (v << (8 - n))) & 0xff;
}
