/**
 * Oodle replay-data decompression entry point.
 * Ported from Unreal.Encryption/Oodle.cs.
 */
import { Kraken } from "./kraken.js";

const kraken = new Kraken();

export function decompressReplayData(
  buffer: Uint8Array,
  uncompressedSize: number,
): Uint8Array {
  return kraken.decompress(buffer, uncompressedSize);
}

export { Kraken } from "./kraken.js";
export {
  DecoderTypes,
  DecoderException,
  KrakenHeader,
  KrakenQuantumHeader,
} from "./types.js";
