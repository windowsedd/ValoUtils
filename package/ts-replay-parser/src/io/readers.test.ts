import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BinaryReader } from "./binary-reader.js";
import { BitReader } from "./bit-reader.js";

// Same deterministic LCG the C# generator uses, so inputs match exactly.
function makeBuf(byteLen: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  let s = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  for (let i = 0; i < byteLen; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    bytes[i] = (s >>> 24) & 0xff;
  }
  return bytes;
}

interface ReaderTest {
  test: string;
  values: (number | string)[];
}

const path = fileURLToPath(new URL("./__rvectors__.json", import.meta.url));
const tests: ReaderTest[] = JSON.parse(
  readFileSync(path, "utf8").replace(/^﻿/, ""),
);
const byName = new Map(tests.map((t) => [t.test, t.values]));

const buf = makeBuf(64, 0xabcdef01);

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

describe("BitReader parity with C# Unreal.Core", () => {
  it("loaded reference vectors", () => {
    expect(tests.length).toBeGreaterThan(0);
  });

  it("readBit", () => {
    const br = new BitReader(buf);
    const out: number[] = [];
    for (let i = 0; i < 200; i++) out.push(br.readBit() ? 1 : 0);
    expect(out).toEqual(byName.get("readBit"));
  });

  it("readByte unaligned (+3 bits)", () => {
    const br = new BitReader(buf);
    br.skipBits(3);
    const out: number[] = [];
    for (let i = 0; i < 20; i++) out.push(br.readByte());
    expect(out).toEqual(byName.get("readByte_unaligned3"));
  });

  it("readInt32", () => {
    const br = new BitReader(buf);
    const out: number[] = [];
    for (let i = 0; i < 8; i++) out.push(br.readInt32());
    expect(out).toEqual(byName.get("readInt32"));
  });

  it("readIntPacked", () => {
    const packed = new Uint8Array([
      0x05, 0x83, 0x01, 0xff, 0x7f, 0x80, 0x80, 0x01, 0x00,
    ]);
    const br = new BitReader(packed);
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push(br.readIntPacked());
    expect(out).toEqual(byName.get("readIntPacked"));
  });

  it("readIntPacked unaligned (+2 bits)", () => {
    const packed = new Uint8Array([
      0x05, 0x83, 0x01, 0xff, 0x7f, 0x80, 0x80, 0x01, 0x00,
    ]);
    const br = new BitReader(packed);
    br.skipBits(2);
    const out: number[] = [];
    for (let i = 0; i < 3; i++) out.push(br.readIntPacked());
    expect(out).toEqual(byName.get("readIntPacked_unaligned2"));
  });

  it("readSerializedInt", () => {
    const br = new BitReader(buf);
    const out: number[] = [];
    for (const max of [2, 7, 16, 100, 1024]) out.push(br.readSerializedInt(max));
    expect(out).toEqual(byName.get("readSerializedInt"));
  });

  it("readBits unaligned (+5 bits)", () => {
    const br = new BitReader(buf);
    br.skipBits(5);
    const out: string[] = [];
    for (const n of [1, 7, 8, 13, 16, 31, 33]) out.push(hex(br.readBits(n)));
    expect(out).toEqual(byName.get("readBits_unaligned5"));
  });

  it("readBytes unaligned (+4 bits)", () => {
    const br = new BitReader(buf);
    br.skipBits(4);
    const out: string[] = [];
    for (const n of [1, 3, 8]) out.push(hex(br.readBytes(n)));
    expect(out).toEqual(byName.get("readBytes_unaligned4"));
  });

  it("readSingle", () => {
    const br = new BitReader(buf);
    const out: number[] = [];
    for (let i = 0; i < 4; i++) out.push(br.readSingle());
    // Float32 round-trip; compare with tolerance via JSON-equivalent values.
    const expected = byName.get("readSingle") as number[];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 3));
  });

  it("readDouble", () => {
    const br = new BitReader(buf);
    br.skipBytes(16); // 4 singles consumed in C# before doubles
    const out: number[] = [];
    for (let i = 0; i < 2; i++) out.push(br.readDouble());
    expect(out).toEqual(byName.get("readDouble"));
  });
});

describe("BinaryReader parity with C# Unreal.Core", () => {
  it("readFString", () => {
    const str = new TextEncoder().encode("Hello\0");
    const bytes = new Uint8Array(4 + str.length);
    new DataView(bytes.buffer).setInt32(0, str.length, true);
    bytes.set(str, 4);
    const rdr = new BinaryReader(bytes);
    expect([rdr.readFString()]).toEqual(byName.get("binaryReadFString"));
  });
});
