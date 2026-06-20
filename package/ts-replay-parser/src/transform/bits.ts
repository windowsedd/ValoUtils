/**
 * Bit-permutation helpers used by the payload transform.
 * Direct ports of the C# `SwapAdjacentBits` / `ReverseBits*` / `ShuffleBits64`.
 */
import { u64 } from "./uint.js";

const M64_55 = 0x5555555555555555n;
const M64_33 = 0x3333333333333333n;
const M64_0f = 0x0f0f0f0f0f0f0f0fn;
const M64_00ff = 0x00ff00ff00ff00ffn;

/** Swap each pair of adjacent bits in a 64-bit value. */
export function swapAdjacent64(value: bigint): bigint {
  return u64(((value & M64_55) << 1n) | ((value >> 1n) & M64_55));
}

/** Swap each pair of adjacent bits in a 32-bit value. */
export function swapAdjacent32(value: number): number {
  return (((value & 0x55555555) << 1) | ((value >>> 1) & 0x55555555)) >>> 0;
}

/** Swap each pair of adjacent bits in an 8-bit value. */
export function swapAdjacent8(value: number): number {
  const v = value & 0xff;
  return (((v & 0x55) << 1) | ((v >> 1) & 0x55)) & 0xff;
}

/**
 * V12_11 64-bit shuffle: full bit-reversal cascade except the final 16-bit
 * swap is replaced by a 32-bit half swap. Mirrors `ShuffleBits64V12_11`.
 */
export function shuffleBits64V12_11(value: bigint): bigint {
  let v = value;
  v = ((v & M64_55) << 1n) | ((v >> 1n) & M64_55);
  v = ((v & M64_33) << 2n) | ((v >> 2n) & M64_33);
  v = ((v & M64_0f) << 4n) | ((v >> 4n) & M64_0f);
  v = ((v & M64_00ff) << 8n) | ((v >> 8n) & M64_00ff);
  // Native 12.11 swaps the 32-bit halves here, without the usual 16-bit swap.
  v = (v << 32n) | (v >> 32n);
  return u64(v);
}

/** Full 32-bit bit-reversal (mirrors `ReverseBits32`). */
export function reverseBits32(value: number): number {
  let v = value >>> 0;
  v = (((v & 0x55555555) << 1) | ((v >>> 1) & 0x55555555)) >>> 0;
  v = (((v & 0x33333333) << 2) | ((v >>> 2) & 0x33333333)) >>> 0;
  v = (((v & 0x0f0f0f0f) << 4) | ((v >>> 4) & 0x0f0f0f0f)) >>> 0;
  v = (((v & 0x00ff00ff) << 8) | ((v >>> 8) & 0x00ff00ff)) >>> 0;
  v = (((v << 16) | (v >>> 16))) >>> 0;
  return v;
}

/** Full 8-bit bit-reversal (mirrors `ReverseBits8`). */
export function reverseBits8(value: number): number {
  let v = value & 0xff;
  v = ((v & 0x55) << 1) | ((v >> 1) & 0x55);
  v = ((v & 0x33) << 2) | ((v >> 2) & 0x33);
  v = ((v & 0x0f) << 4) | ((v >> 4) & 0x0f);
  return v & 0xff;
}
