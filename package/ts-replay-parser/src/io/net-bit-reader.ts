/**
 * NetBitReader — RepLayout property serialization helpers.
 * Ported from Unreal.Core/NetBitReader.cs.
 */
import { BitReader } from "./bit-reader.js";
import {
  EngineNetworkVersionHistory,
  RotatorQuantization,
  UniqueIdEncodingFlags,
  VectorQuantization,
} from "./enums.js";
import { FVector, FVector2D, FRotator, type FRepMovement } from "./models.js";

export class NetBitReader extends BitReader {
  serializePropertyInt(): number {
    return this.readInt32();
  }
  serializePropertyUInt32(): number {
    return this.readUInt32();
  }
  serializePropertyUInt16(): number {
    return this.readUInt16();
  }
  serializePropertyUInt64(): bigint {
    return this.readUInt64();
  }
  serializePropertyFloat(): number {
    return this.readSingle();
  }
  serializePropertyDouble(): number {
    return this.readDouble();
  }
  serializePropertyName(): string {
    return this.readFName();
  }
  serializePropertyString(): string {
    return this.readFString();
  }

  serializeRepMovement(
    locationQuantizationLevel: VectorQuantization = VectorQuantization.RoundTwoDecimals,
    rotationQuantizationLevel: RotatorQuantization = RotatorQuantization.ByteComponents,
    velocityQuantizationLevel: VectorQuantization = VectorQuantization.RoundWholeNumber,
  ): FRepMovement {
    const bSimulatedPhysicSleep = this.readBit();
    const bRepPhysics = this.readBit();
    let bRepServerFrame = false;
    let bRepServerHandle = false;

    if (
      this.EngineNetworkVersion >=
        EngineNetworkVersionHistory.HISTORY_REPMOVE_SERVERFRAME_AND_HANDLE &&
      this.EngineNetworkVersion !==
        EngineNetworkVersionHistory.HISTORY_21_AND_VIEWPITCH_ONLY_DO_NOT_USE
    ) {
      bRepServerFrame = this.readBit();
      bRepServerHandle = this.readBit();
    }

    const repMovement: FRepMovement = {
      bSimulatedPhysicSleep,
      bRepPhysics,
      bRepAcceleration: false,
      ServerFrame: 0,
      ServerPhysicsHandle: 0,
      Location: this.serializePropertyQuantizedVector(locationQuantizationLevel),
      Rotation:
        rotationQuantizationLevel === RotatorQuantization.ByteComponents
          ? this.readRotation()
          : this.readRotationShort(),
      LinearVelocity:
        this.serializePropertyQuantizedVector(velocityQuantizationLevel),
    };

    if (repMovement.bRepPhysics) {
      repMovement.AngularVelocity =
        this.serializePropertyQuantizedVector(velocityQuantizationLevel);
    }
    if (bRepServerFrame) repMovement.ServerFrame = this.readIntPacked();
    if (bRepServerHandle) repMovement.ServerPhysicsHandle = this.readIntPacked();

    if (
      this.EngineNetworkVersion >=
      EngineNetworkVersionHistory.RepMoveOptionalAcceleration
    ) {
      repMovement.bRepAcceleration = this.readBit();
      if (repMovement.bRepAcceleration) {
        repMovement.Acceleration =
          this.serializePropertyQuantizedVector(velocityQuantizationLevel);
      }
    }
    return repMovement;
  }

  serializePropertyVector(): FVector {
    return this.readFVector();
  }
  serializePropertyVector2D(): FVector2D {
    return new FVector2D(this.readSingle(), this.readSingle());
  }
  serializePropertyVectorNormal(): FVector {
    return new FVector(
      this.readFixedCompressedFloat(1, 16),
      this.readFixedCompressedFloat(1, 16),
      this.readFixedCompressedFloat(1, 16),
    );
  }
  serializePropertyVector10(): FVector {
    return this.readPackedVector(10, 24);
  }
  serializePropertyVector100(): FVector {
    return this.readPackedVector(100, 30);
  }

  readFixedCompressedFloat(maxValue: number, numBits: number): number {
    const maxBitValue = (1 << (numBits - 1)) - 1;
    const bias = 1 << (numBits - 1);
    const serIntMax = 1 << numBits;
    const delta = this.readSerializedInt(serIntMax);
    const unscaledValue = delta - bias;
    if (maxValue > maxBitValue) {
      const invScale = maxValue / maxBitValue;
      return unscaledValue * invScale;
    }
    const scale = maxBitValue / maxValue;
    const invScale = 1 / scale;
    return unscaledValue * invScale;
  }

  serializePropertyRotator(): FRotator {
    return this.readRotationShort();
  }

  serializePropertyByte(enumMaxValue = 0): number {
    return this.readBitsToInt(
      enumMaxValue > 0 ? Math.ceil(Math.log2(enumMaxValue)) : 8,
    );
  }

  serializePropertyBool(): boolean {
    return this.readBit();
  }
  serializePropertyNativeBool(): boolean {
    return this.readBit();
  }
  serializePropertyEnum(): number {
    return this.readBitsToInt(this.getBitsLeft());
  }
  serializePropertyObject(): number {
    return this.readIntPacked();
  }

  serializePropertyQuantizedVector(
    quantizationLevel: VectorQuantization = VectorQuantization.RoundWholeNumber,
  ): FVector {
    switch (quantizationLevel) {
      case VectorQuantization.RoundTwoDecimals:
        return this.readPackedVector(100, 30);
      case VectorQuantization.RoundOneDecimal:
        return this.readPackedVector(10, 27);
      default:
        return this.readPackedVector(1, 24);
    }
  }

  serializePropertyNetId(): string {
    const typeHashOther = 31;
    const encodingFlags = this.readByte();
    let encoded = false;
    if ((encodingFlags & UniqueIdEncodingFlags.IsEncoded) !== 0) {
      encoded = true;
      if ((encodingFlags & UniqueIdEncodingFlags.IsEmpty) !== 0) return "";
    }
    const typeHash =
      (encodingFlags & UniqueIdEncodingFlags.TypeMask) >> 3;
    if (typeHash === 0) return "NULL";

    let bValidTypeHash = typeHash !== 0;
    if (typeHash === typeHashOther) {
      const typeString = this.readFString();
      if (typeString === "None") bValidTypeHash = false;
    }
    if (bValidTypeHash) {
      if (encoded) {
        const encodedSize = this.readByte();
        return this.readBytesToString(encodedSize);
      }
      return this.readFString();
    }
    return "";
  }
}
