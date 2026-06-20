/**
 * ValorantSeededPayloadTransform — TypeScript port.
 *
 * De-obfuscates a replicated-bunch payload using a seed derived from the
 * payload bit-length and the channel's actor GUID. Two algorithm variants
 * exist, selected by the replay branch string:
 *   - release-12.10 (default)
 *   - release-12.11
 *
 * Ported from ValorantReplayParser/ValorantSeededPayloadTransform.cs.
 */
import {
  u32,
  u64,
  u8,
  mul32,
  mul64,
  add64,
  sub64,
  rotr64,
  rotl64,
  rotr32,
  rotl32,
  rotr8,
} from "./uint.js";
import {
  swapAdjacent64,
  swapAdjacent32,
  swapAdjacent8,
  shuffleBits64V12_11,
  reverseBits32,
  reverseBits8,
} from "./bits.js";

const MULTIPLIER = 0x2545f4914f6cdd1dn;
const SEED_ADDEND_V12_10 = 0x12fd0ee5;
const SEED_ADDEND_V12_11 = 0x409d36a3;
const INIT_A_OFFSET_V12_10 = 0x1b;
const INIT_A_OFFSET_V12_11 = 0x23;
const TAIL_XOR_V12_10 = 0xe5;
const TAIL_XOR_V12_11 = 0xa3;

enum TransformVersion {
  V12_10,
  V12_11,
}

interface TransformState {
  state: number; // uint
  prngA: bigint; // ulong
  prngB: bigint; // ulong
  streamByte: number; // byte
}

function resolveVersion(branch?: string | null): TransformVersion {
  if (!branch) return TransformVersion.V12_10;
  const match = /release-(\d+)\.(\d+)/i.exec(branch);
  if (!match) return TransformVersion.V12_10;
  const major = Number.parseInt(match[1]!, 10);
  const minor = Number.parseInt(match[2]!, 10);
  return major === 12 && minor === 11
    ? TransformVersion.V12_11
    : TransformVersion.V12_10;
}

export function applyTransform(
  payload: Uint8Array,
  bitCount: number,
  seed: number,
  branch?: string | null,
): Uint8Array {
  return resolveVersion(branch) === TransformVersion.V12_11
    ? applyV12_11(payload, bitCount, seed)
    : applyV12_10(payload, bitCount, seed);
}

// ---- PRNG initialisation -------------------------------------------------

function initialPrngA(seed: number): bigint {
  const seedPlus = u32(seed + SEED_ADDEND_V12_10);
  const mixed =
    BigInt(
      (((seedPlus >>> 15) ^ seedPlus) >>> 12) ^
        mul32(u32(seed - INIT_A_OFFSET_V12_10), 0x02000000) ^
        seedPlus,
    ) & 0xffffffffn;
  return mul64(mixed, MULTIPLIER);
}

function initialPrngAV12_11(seed: number): bigint {
  const seedPlus = u32(seed + SEED_ADDEND_V12_11);
  const mixed =
    BigInt(
      (((seedPlus >>> 15) ^ seedPlus) >>> 12) ^
        mul32(u32(seed + INIT_A_OFFSET_V12_11), 0x02000000) ^
        seedPlus,
    ) & 0xffffffffn;
  return mul64(mixed, MULTIPLIER);
}

function initialPrngB(seed: number): bigint {
  const mixed =
    BigInt(
      (((seed >>> 15) ^ seed) >>> 12) ^ u32(seed << 25) ^ seed,
    ) & 0xffffffffn;
  return mul64(mixed, MULTIPLIER);
}

function advanceTransformState(s: TransformState): void {
  const sum = add64(s.prngB, s.prngA);
  s.prngB ^= s.prngA;
  s.prngA = u64(rotr64(s.prngA, 9) ^ (s.prngB << 14n) ^ s.prngB);
  s.prngB = rotl64(s.prngB, 36);
  s.state = u32(Number(sum >> 32n));
  s.streamByte = u8(s.state);
}

// ---- Transform constants (V12_10) ----------------------------------------

interface Constants {
  addend1: bigint | number;
  addend2: bigint | number;
  rotate1: number;
  rotate2: number;
}

function transformConstants64(state: number): Constants {
  let r = state >>> 0;
  const rors: number[] = [];
  for (let i = 0; i < 8; i++) {
    r = ((r >>> 1) | (r << 31)) >>> 0;
    rors.push(r);
  }
  // ror1..ror8 -> indices 0..7
  return {
    addend1: rors[3]!, // ror4
    addend2: rors[5]!, // ror6
    rotate1: (rors[4]! % 63) + 1, // ror5
    rotate2: (rors[7]! % 63) + 1, // ror8
  };
}

function transformConstants32(state: number): Constants {
  let r = state >>> 0;
  const rots: number[] = [];
  for (let i = 0; i < 8; i++) {
    r = ((r << 1) | (r >>> 31)) >>> 0;
    rots.push(r);
  }
  return {
    addend1: rots[3]!, // rot4
    addend2: rots[5]!, // rot6
    rotate1: (rots[4]! % 31) + 1, // rot5
    rotate2: (rots[7]! % 31) + 1, // rot8
  };
}

function transformConstants8(state: number): Constants {
  return {
    addend1: u8(mul32(state, 0x31)),
    addend2: u8(mul32(state, 0x29)),
    rotate1: (mul32(state, 0x2751b) % 7) + 1,
    rotate2: (mul32(state, 0xcc6db61) % 7) + 1,
  };
}

// ---- V12_10 --------------------------------------------------------------

function applyV12_10(
  payload: Uint8Array,
  bitCount: number,
  seed: number,
): Uint8Array {
  const output = payload.slice();
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const s: TransformState = {
    state: u32(seed),
    prngA: initialPrngA(seed),
    prngB: initialPrngB(seed),
    streamByte: u8(seed),
  };
  let byteOffset = 0;
  let bitsRemaining = bitCount;

  while (bitsRemaining > 63) {
    const c = transformConstants64(s.state);
    let v = view.getBigUint64(byteOffset, true);
    v = rotr64(v, c.rotate2);
    v = swapAdjacent64(v);
    v = sub64(v, BigInt(c.addend2 as number));
    v = rotr64(v, c.rotate1);
    v = swapAdjacent64(v ^ (U64_NOT ^ BigInt(c.addend1 as number)));
    view.setBigUint64(byteOffset, u64(v), true);
    advanceTransformState(s);
    byteOffset += 8;
    bitsRemaining -= 64;
  }

  while (bitsRemaining > 31) {
    const c = transformConstants32(s.state);
    let v = view.getUint32(byteOffset, true);
    v = rotr32(v, c.rotate2);
    v = swapAdjacent32(v);
    v = ((v - (c.addend2 as number)) >>> 0);
    v = rotr32(v, c.rotate1);
    v = swapAdjacent32((v ^ (c.addend1 as number)) >>> 0);
    view.setUint32(byteOffset, v >>> 0, true);
    advanceTransformState(s);
    byteOffset += 4;
    bitsRemaining -= 32;
  }

  while (bitsRemaining > 7) {
    const c = transformConstants8(s.state);
    let v = output[byteOffset]!;
    v = rotr8(v, c.rotate2);
    v = swapAdjacent8(v);
    v = (v - (c.addend2 as number)) & 0xff;
    v = rotr8(v, c.rotate1);
    v = swapAdjacent8((v ^ (c.addend1 as number)) & 0xff);
    output[byteOffset] = v & 0xff;
    advanceTransformState(s);
    byteOffset++;
    bitsRemaining -= 8;
  }

  if (bitsRemaining !== 0) {
    const mask = (0xff >> (7 - ((bitCount - 1) & 7))) & 0xff;
    output[byteOffset] =
      (output[byteOffset]! ^ (mask & (s.streamByte ^ TAIL_XOR_V12_10))) & 0xff;
  }

  return output;
}

const U64_NOT = 0xffffffffffffffffn;

// ---- V12_11 --------------------------------------------------------------

function applyV12_11(
  payload: Uint8Array,
  bitCount: number,
  seed: number,
): Uint8Array {
  const output = payload.slice();
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const s: TransformState = {
    state: u32(seed),
    prngA: initialPrngAV12_11(seed),
    prngB: initialPrngB(seed),
    streamByte: u8(seed),
  };
  let byteOffset = 0;
  let bitsRemaining = bitCount;

  while (bitsRemaining > 63) {
    // state is a uint in C#, so these bind to the 32-bit rotate overload,
    // then zero-extend to ulong when combined with the 64-bit value.
    const ror2 = BigInt(rotr32(s.state, 2));
    const ror3 = BigInt(rotr32(s.state, 3));
    const ror4 = BigInt(rotr32(s.state, 4));
    const ror6 = BigInt(rotr32(s.state, 6));
    const ror8 = BigInt(rotr32(s.state, 8));
    let v = view.getBigUint64(byteOffset, true);
    v = rotr64(v, Number(ror8 % 63n) + 1);
    v = swapAdjacent64(v);
    v = add64(v, ror6);
    v = shuffleBits64V12_11(v);
    v = sub64(v, ror4);
    v = sub64(v, ror3);
    v = sub64(v, ror2);
    v = swapAdjacent64(v);
    view.setBigUint64(byteOffset, u64(v), true);
    advanceTransformState(s);
    byteOffset += 8;
    bitsRemaining -= 64;
  }

  while (bitsRemaining > 31) {
    const rol2 = rotl32(s.state, 2);
    const rol3 = rotl32(s.state, 3);
    const rol4 = rotl32(s.state, 4);
    const rol6 = rotl32(s.state, 6);
    const rol8 = rotl32(s.state, 8);
    let v = view.getUint32(byteOffset, true);
    v = rotr32(v, (rol8 % 31) + 1);
    v = swapAdjacent32(v);
    v = ((v + rol6) >>> 0);
    v = reverseBits32(v);
    v = ((v - rol4) >>> 0);
    v = ((v - rol3) >>> 0);
    v = ((v - rol2) >>> 0);
    v = swapAdjacent32(v);
    view.setUint32(byteOffset, v >>> 0, true);
    advanceTransformState(s);
    byteOffset += 4;
    bitsRemaining -= 32;
  }

  while (bitsRemaining > 7) {
    const stateByte = u8(s.state);
    const rotate2Input = mul32(s.state, 0x0cc6db61);
    let v = output[byteOffset]!;
    v = rotr8(v, (rotate2Input % 7) + 1);
    v = swapAdjacent8(v);
    v = (v + u8(mul32(stateByte, 0x29))) & 0xff;
    v = reverseBits8(v);
    v = (v + u8(mul32(stateByte, 0x23))) & 0xff;
    v = swapAdjacent8(v);
    output[byteOffset] = v & 0xff;
    advanceTransformState(s);
    byteOffset++;
    bitsRemaining -= 8;
  }

  if (bitsRemaining !== 0) {
    const mask = (0xff >> (7 - ((bitCount - 1) & 7))) & 0xff;
    output[byteOffset] =
      (output[byteOffset]! ^ (mask & (s.streamByte ^ TAIL_XOR_V12_11))) & 0xff;
  }

  return output;
}

