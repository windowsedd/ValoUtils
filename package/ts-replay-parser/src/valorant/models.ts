/**
 * Auto-translated from ValorantReplayParser/Models. Registry-driven port.
 *
 * C# used reflection over `[NetFieldExportGroup]` etc. attributes; here each
 * model registers a descriptor with the shared `registry` at module load.
 * Importing this module has the side effect of populating the registry.
 */
import { registry } from "../unreal/registry.js";
import { RepLayoutCmdType, ParseMode } from "../unreal/enums.js";
import { FVector } from "../io/models.js";
import { SeekOrigin } from "../io/farchive.js";
import { NetBitReader } from "../io/net-bit-reader.js";
import { FBitArchiveEndIndex } from "../unreal/enums.js";
import type { IProperty } from "../unreal/models.js";
import { FText } from "../unreal/models.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum EAresGamePhase {
  NotStarted = 0,
  GameStarted = 1,
  BetweenRounds = 2,
  RoundStarting = 3,
  InRound = 4,
  RoundEnding = 5,
  SwitchingTeams = 6,
  GameEnded = 7,
  Count = 8,
  Invalid = 254,
  EAresGamePhase_MAX = 255,
}

export enum EAresRewardGrantStrategy {
  Immediately = 0,
  EndOfRound = 1,
  StartOfRound = 2,
  EAresRewardGrantStrategy_MAX = 255,
}

export enum EAresTeam {
  AresTeam_Red = 0,
  AresTeam_Blue = 1,
  AresTeam_Invalid = 254,
  EAresTeam_MAX = 255,
}

export enum EConnectionStatus {
  Uninitialized = 0,
  Disconnected = 1,
  Unresponsive = 2,
  Connecting = 3,
  Connected = 4,
  Count = 5,
  EConnectionStatus_MAX = 6,
}

export enum ERewardSource {
  None = 0,
  Kill = 1,
  Assist = 2,
  Death = 3,
  RoundWin = 4,
  RoundLoss = 5,
  Plant = 6,
  Defuse = 7,
  Objective = 8,
  FirstBlood = 9,
  RoundStart = 10,
  GameModeSpecific = 11,
  Battlepass = 12,
  CombatReport = 13,
  Mission = 14,
  ERewardSource_MAX = 255,
}

export enum EAresAlliance {
  Alliance_Ally = 0,
  Alliance_Enemy = 1,
  Alliance_Neutral = 2,
  Alliance_Any = 3,
  Alliance_Count = 4,
  Alliance_MAX = 5,
}

// ---------------------------------------------------------------------------
// ComponentDataStream (IProperty with custom movement-section parsing)
// ---------------------------------------------------------------------------

export class MovementMove {
  Marker = 0;
  MoveType = 0;
  Position?: FVector;
  Velocity?: FVector;
  RotationInput?: FVector;
  Variant1Vector?: FVector;
  Timestamp = 0;
  ModeFlags = 0;
  MovementState = 0;
  RotationYawMultiplier = 0;
  UnusedByte = 0;
  HasOptionalMovementValue = false;
  OptionalMovementRawByte?: number;
  OptionalMovementValue?: number;
  Flag48 = false;
  PackedAngles = 0;
  RawYaw = 0;
  RawPitch = 0;
  Yaw = 0;
  Pitch = 0;
  Variant0HasExternalCharacterRef?: boolean;
  Variant0PackedAngles?: number;
  Variant1Flag?: boolean;
  ErrorSentinel = false;
}

const MovementMagic = 0x52;
const FixedVectorScale = 1.0 / 65536.0;
const OptionalByteScale = 1.0;
const AngleScale = 360.0 / 65536.0;
const MaxMovementPaddingBits = 31;

export class ComponentDataStream implements IProperty {
  HasMovementSection = false;
  HasValidMovementMagic = false;
  MovementBitCount = 0;
  TrailingComponentBitCount = 0;
  MovementParseError?: string;
  Moves: MovementMove[] = [];

  serialize(reader: NetBitReader): void {
    const payloadBytes = tryReadPayloadBytes(reader);
    if (payloadBytes) {
      const payloadReader = new NetBitReader(
        payloadBytes,
        payloadBytes.length * 8,
      );
      payloadReader.EngineNetworkVersion = reader.EngineNetworkVersion;
      payloadReader.NetworkVersion = reader.NetworkVersion;
      payloadReader.NetworkReplayVersion = reader.NetworkReplayVersion;
      payloadReader.ReplayHeaderFlags = reader.ReplayHeaderFlags;
      payloadReader.ReplayVersion = reader.ReplayVersion;
      this.parseComponentPayload(payloadReader);
      return;
    }
    this.parseComponentPayload(reader);
  }

  private parseComponentPayload(reader: NetBitReader): void {
    reader.mark();
    if (!reader.canRead(16)) return;

    const movementBitCount = reader.readUInt16();
    if (movementBitCount === 0) {
      this.HasMovementSection = true;
      this.MovementBitCount = Math.min(reader.getBitsLeft(), 0xffff);
      this.parseMovementSection(reader);
      return;
    }

    if (movementBitCount > reader.getBitsLeft()) {
      reader.pop();
      this.HasMovementSection = true;
      this.MovementBitCount = Math.min(reader.getBitsLeft(), 0xffff);
      this.parseMovementSection(reader);
      return;
    }

    this.HasMovementSection = true;
    this.MovementBitCount = movementBitCount;

    reader.setTempEnd(movementBitCount, FBitArchiveEndIndex.FIELD_HEADER_PAYLOAD);
    try {
      this.parseMovementSection(reader);
    } finally {
      reader.restoreTempEnd(FBitArchiveEndIndex.FIELD_HEADER_PAYLOAD);
    }

    if (reader.getBitsLeft() > 0) {
      this.TrailingComponentBitCount = reader.getBitsLeft();
      reader.seek(this.TrailingComponentBitCount, SeekOrigin.Current);
    }
  }

  private parseMovementSection(reader: NetBitReader): void {
    const magic = tryReadByte(reader);
    if (magic === null) {
      this.MovementParseError = "Missing movement magic";
      return;
    }
    this.HasValidMovementMagic = magic === MovementMagic;
    if (!this.HasValidMovementMagic) {
      this.MovementParseError = `Invalid movement magic 0x${magic.toString(16)}`;
      return;
    }

    let expectedMarker = 1;
    let marker = tryReadBits(reader, 3);
    if (marker === null) {
      this.MovementParseError = "Missing first movement marker";
      return;
    }

    while (marker !== 0 && !reader.IsError) {
      if (marker !== expectedMarker) {
        this.MovementParseError = `Movement marker mismatch: expected ${expectedMarker}, got ${marker}`;
        return;
      }
      const result = tryReadMove(reader, marker);
      if (!result.move) {
        this.MovementParseError = result.error ?? "Invalid movement record";
        return;
      }
      this.Moves.push(result.move);

      if (reader.getBitsLeft() <= MaxMovementPaddingBits) return;

      expectedMarker = nextMarker(expectedMarker);
      marker = tryReadBits(reader, 3);
      if (marker === null) {
        this.MovementParseError = "Missing next movement marker";
        return;
      }
    }
  }
}

function nextMarker(marker: number): number {
  const next = (marker + 1) & 7;
  return next < 2 ? 1 : next;
}

function tryReadPayloadBytes(reader: NetBitReader): Uint8Array | null {
  reader.mark();
  const byteCount = tryReadUInt16(reader);
  if (byteCount === null || byteCount === 0 || !reader.canRead(byteCount * 8)) {
    reader.pop();
    return null;
  }
  const bytes = reader.readBytes(byteCount).slice();
  return reader.IsError ? null : bytes;
}

interface MoveResult {
  move: MovementMove | null;
  error?: string;
}

function tryReadMove(reader: NetBitReader, marker: number): MoveResult {
  const move = new MovementMove();

  const moveType = tryReadBit(reader);
  const rotationYawMultiplier = tryReadByte(reader);
  const movementState = tryReadByte(reader);
  const unusedByte = tryReadByte(reader);
  if (
    moveType === null ||
    rotationYawMultiplier === null ||
    movementState === null ||
    unusedByte === null
  ) {
    return { move: null, error: "Missing movement record header" };
  }

  move.Marker = marker;
  move.MoveType = moveType ? 1 : 0;
  // unchecked (sbyte) cast
  move.RotationYawMultiplier = (unusedByte << 24) >> 24;
  move.ModeFlags = movementState;
  move.MovementState = movementState;
  move.UnusedByte = unusedByte;

  const rotationInput = tryReadFixedVector(reader);
  const timestamp = tryReadVLQ(reader);
  const position = tryReadQuantizedVector(reader, 100);
  if (rotationInput === null || timestamp === null || position === null) {
    return { move: null, error: "Missing movement common vector/timestamp fields" };
  }
  move.RotationInput = rotationInput;
  move.Timestamp = timestamp;
  move.Position = position;

  const hasOptionalByte = tryReadBit(reader);
  if (hasOptionalByte === null) {
    return { move: null, error: "Missing optional movement value flag" };
  }
  move.HasOptionalMovementValue = hasOptionalByte;
  if (hasOptionalByte) {
    const optionalByte = tryReadByte(reader);
    if (optionalByte === null) {
      return { move: null, error: "Missing optional movement value" };
    }
    move.OptionalMovementRawByte = optionalByte;
    move.OptionalMovementValue = optionalByte * OptionalByteScale;
  }

  const flag48 = tryReadBit(reader);
  if (flag48 === null) {
    return { move: null, error: "Missing movement flag/angle fields" };
  }
  const packedAngles = tryReadUInt32(reader);
  if (packedAngles === null) {
    return { move: null, error: "Missing movement flag/angle fields" };
  }
  const pitch = packedAngles & 0xffff;
  const yaw = (packedAngles >>> 16) & 0xffff;
  move.Flag48 = flag48;
  move.PackedAngles = packedAngles;
  move.RawYaw = yaw;
  move.RawPitch = pitch;
  move.Yaw = yaw * AngleScale;
  move.Pitch = pitch * AngleScale;

  if (moveType) {
    const variant1Flag = tryReadBit(reader);
    const variant1Vector = tryReadQuantizedVector(reader, 10);
    if (variant1Flag === null || variant1Vector === null) {
      return { move: null, error: "Missing variant-1 movement fields" };
    }
    move.Variant1Flag = variant1Flag;
    move.Variant1Vector = variant1Vector;
    move.Velocity = variant1Vector;
  } else {
    const err = tryReadVariant0Extra(reader, move);
    if (err) return { move: null, error: err };
  }

  const errorSentinel = tryReadBit(reader);
  if (errorSentinel === null) {
    return { move: null, error: "Missing movement error sentinel" };
  }
  move.ErrorSentinel = errorSentinel;
  if (errorSentinel) {
    return { move: null, error: "Movement error sentinel was set" };
  }
  return { move };
}

function tryReadVariant0Extra(
  reader: NetBitReader,
  move: MovementMove,
): string | null {
  const hasExternalCharacterRef = tryReadBit(reader);
  if (hasExternalCharacterRef === null) {
    return "Missing variant-0 external reference flag";
  }
  move.Variant0HasExternalCharacterRef = hasExternalCharacterRef;
  if (hasExternalCharacterRef) {
    return "Variant-0 external character reference is not decoded yet";
  }
  const packedAngles = tryReadUInt32(reader);
  if (packedAngles === null) {
    return "Missing variant-0 packed angle dword";
  }
  move.Variant0PackedAngles = packedAngles;
  return null;
}

function tryReadFixedVector(reader: NetBitReader): FVector | null {
  const x = tryReadSerializedInt(reader, 0x10000);
  const y = tryReadSerializedInt(reader, 0x10000);
  const z = tryReadSerializedInt(reader, 0x10000);
  if (x === null || y === null || z === null) return null;
  const vector = new FVector(
    (x - 0x8000) * FixedVectorScale,
    (y - 0x8000) * FixedVectorScale,
    (z - 0x8000) * FixedVectorScale,
  );
  vector.ScaleFactor = 65536;
  vector.Bits = 16;
  return vector;
}

function tryReadQuantizedVector(
  reader: NetBitReader,
  scaleFactor: number,
): FVector | null {
  const vector = new FVector(0, 0, 0);
  vector.ScaleFactor = scaleFactor;

  const componentBitCountAndExtraInfo = tryReadSerializedInt(reader, 1 << 7);
  if (componentBitCountAndExtraInfo === null) return null;
  const componentBits = componentBitCountAndExtraInfo & 63;
  const extraInfo = componentBitCountAndExtraInfo >>> 6;
  vector.Bits = componentBits;

  if (componentBits > 0) {
    const x = tryReadSignedQuantizedComponent(reader, componentBits);
    const y = tryReadSignedQuantizedComponent(reader, componentBits);
    const z = tryReadSignedQuantizedComponent(reader, componentBits);
    if (x === null || y === null || z === null) return null;
    vector.X = extraInfo > 0 ? Number(x) / scaleFactor : Number(x);
    vector.Y = extraInfo > 0 ? Number(y) / scaleFactor : Number(y);
    vector.Z = extraInfo > 0 ? Number(z) / scaleFactor : Number(z);
    return vector;
  }

  if (extraInfo === 0) {
    if (!reader.canRead(96)) return null;
    vector.X = reader.readSingle();
    vector.Y = reader.readSingle();
    vector.Z = reader.readSingle();
    vector.Bits = 32;
    return reader.IsError ? null : vector;
  }

  if (!reader.canRead(192)) return null;
  vector.X = reader.readDouble();
  vector.Y = reader.readDouble();
  vector.Z = reader.readDouble();
  vector.Bits = 64;
  return reader.IsError ? null : vector;
}

function tryReadSignedQuantizedComponent(
  reader: NetBitReader,
  componentBits: number,
): bigint | null {
  if (componentBits <= 0 || componentBits > 62 || !reader.canRead(componentBits)) {
    return null;
  }
  const raw = reader.readBitsToLong(componentBits);
  const signBit = 1n << BigInt(componentBits - 1);
  const value = BigInt.asIntN(64, raw ^ signBit) - signBit;
  return reader.IsError ? null : value;
}

function tryReadVLQ(reader: NetBitReader): number | null {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = tryReadByte(reader);
    if (b === null) return null;
    value = (value | (((b >> 1) & 0x7f) << shift)) >>> 0;
    if ((b & 1) === 0) return value;
    shift += 7;
    if (shift >= 32) return null;
  }
}

function tryReadSerializedInt(
  reader: NetBitReader,
  maxValue: number,
): number | null {
  let value = 0;
  for (let mask = 1; value + mask < maxValue; mask <<= 1) {
    const bit = tryReadBit(reader);
    if (bit === null) return null;
    if (bit) value |= mask;
  }
  return value;
}

function tryReadBit(reader: NetBitReader): boolean | null {
  if (!reader.canRead(1)) return null;
  const value = reader.readBit();
  return reader.IsError ? null : value;
}

function tryReadBits(reader: NetBitReader, bitCount: number): number | null {
  if (!reader.canRead(bitCount)) return null;
  const value = reader.readBitsToInt(bitCount);
  return reader.IsError ? null : value;
}

function tryReadByte(reader: NetBitReader): number | null {
  if (!reader.canRead(8)) return null;
  const value = reader.readByte();
  return reader.IsError ? null : value;
}

function tryReadUInt16(reader: NetBitReader): number | null {
  if (!reader.canRead(16)) return null;
  const value = reader.readUInt16();
  return reader.IsError ? null : value;
}

function tryReadUInt32(reader: NetBitReader): number | null {
  if (!reader.canRead(32)) return null;
  const value = reader.readUInt32();
  return reader.IsError ? null : value;
}

// ---------------------------------------------------------------------------
// AresAttributeSet (IHandleNetFieldExportGroup, handle-driven attribute pairs)
// ---------------------------------------------------------------------------

export enum EAresAttributeIndex {
  AllowFiringWhileUsing = 0,
  BonusDamage = 1,
  CanSeeOthersHealth = 2,
  DamageReduction = 3,
  DefensiveDetectionDuration = 4,
  DescendingGravityModifier = 5,
  DetectionDelay = 6,
  DetectionDisabled = 7,
  EquippableMovementModifier = 8,
  HealingEffectiveness = 9,
  ShieldRestoreEffectiveness = 10,
  FiringErrorModifier = 11,
  FiringRateModifier = 12,
  StabilityMovementModifier = 13,
  GravityModifier = 14,
  FootstepVolumeReduction = 15,
  ForceCrouch = 16,
  Frozen = 17,
  HeavyWeaponsDisabled = 18,
  Hide1P = 19,
  Hide3P = 20,
  HideCrosshair = 21,
  HudVisibleToAll = 22,
  HudVisibleToInstigator = 23,
  InDanger = 24,
  Intangible = 25,
  Invisible = 26,
  InvisibleEquippables = 27,
  InvisibleToEnemies = 28,
  InvisibleToEnemyNonPlayers = 29,
  InvisibleToOwner = 30,
  Invulnerable = 31,
  JumpForceModifier = 32,
  JumpMovementSlow = 33,
  MinimapBlinded = 34,
  MinimumAboveMaxSpeedDecayRateReduction = 35,
  FallDamageReduction = 36,
  LockMovement = 37,
  MagazineBonus = 38,
  MapVisibleToAll = 39,
  MaxHealthModifier = 40,
  MaxShieldModifier = 41,
  MaxTurnRate = 42,
  MinError = 43,
  MinimapDetectionDelay = 44,
  MinimapDisabled = 45,
  MinimapInvisible = 46,
  MinimapViewDistance = 47,
  MaxVisionDistance = 48,
  MoneyKillRewardModifier = 49,
  MovementBonus = 50,
  MovementBonusCrouch = 51,
  MovementBonusFlying = 52,
  MovementBonusJump = 53,
  MovementBonusRun = 54,
  MovementBonusWalk = 55,
  MovementErrorModifier = 56,
  MovementSlow = 57,
  OffensiveDetectionDuration = 58,
  PickupAmmoBonus = 59,
  PreventAbilities = 60,
  PreventCrouch = 61,
  PreventDroppingEquippables = 62,
  PreventJump = 63,
  PreventFiring = 64,
  PreventFiringPrimaryWeapon = 65,
  PreventFiringSecondaryWeapon = 66,
  PreventMeleeAttacking = 67,
  PreventMovementInput = 68,
  PreventReloading = 69,
  PreventSwitchingEquippables = 70,
  PreventUseCancelling = 71,
  PreventUsing = 72,
  PreventPickup = 73,
  PrimarySlotDisabled = 74,
  ReduceAbilityMovementPenalty = 75,
  ReduceTaggingMovementPenalty = 76,
  ReloadTimeModifier = 77,
  SpreadRecoveryModifier = 78,
  Stealthed = 79,
  Untrackable = 80,
  RecoilModifier = 81,
  ThirdPerson = 82,
  TurnRatePenalty = 83,
  UltimatePointsDeathModifier = 84,
  UltimatePointsDefuseModifier = 85,
  UltimatePointsKillModifier = 86,
  UltimatePointsPickUpModifier = 87,
  UltimatePointsPlantModifier = 88,
  UsingTimeModifier = 89,
  WallPenetrationDistanceModifier = 90,
  WeaponDrawTimeModifier = 91,
  FastEquipPrimaryWeapon = 92,
  FastEquipSecondaryWeapon = 93,
  WeaponsDisabled = 94,
  WeaponsLowered = 95,
  Disarmed = 96,
  GrenadeDisabled = 97,
  QDisabled = 98,
  EDisabled = 99,
  UltimateDisabled = 100,
  ZoomDisabled = 101,
  EquipmentDisabled = 102,
  TemporaryDamage = 103,
  IncomingDamageShieldPenetrationModifier = 104,
  IncomingSelfDamageModifier = 105,
  IncomingAllyDamageModifier = 106,
  PreventDeathFromDamage = 107,
  BlindImmune = 108,
  PreventUsingAbilities = 109,
  PreventUsingAscenders = 110,
  PreventUsingLoreItems = 111,
  OverrideEquippableBaseMovement = 112,
  DisableRegionalDamageMultipliers = 113,
  DisableIncomingDamageCombatTracking = 114,
  HealsFromAllyFlames = 115,
  Marked = 116,
  Suppressed = 117,
  PreventDowned = 118,
  PreventPlanting = 119,
  PreventDefusing = 120,
  PreventFollowing = 121,
  InPeril = 122,
  PreventMinimapFocusing = 123,
  SensitivityModifier = 124,
  ShowObserverKeybindsWhileHidden = 125,
  PreventSkinFinisherIfVictim = 126,
  PreventTeamWipeCondition = 127,
  GroundedFootstepMute = 128,
  DelayDeathUltPointReward = 129,
  PreventKillUltPointReward = 130,
  DashSpeedMultiplier = 131,
  DisablePrimaryWeaponFocusMode = 132,
  AbilityInvulnerable = 133,
  DisplacementImmunity = 134,
  ImpairmentImmunity = 135,
  BombPlantTime = 136,
  BombDefuseTime = 137,
  FootstepPlayTimeMultiplier = 138,
  HeadshotDamageMultiplier = 139,
  NormalDamageMultiplier = 140,
  LegshotDamageMultiplier = 141,
}

const booleanAttributes = new Set<EAresAttributeIndex>([
  EAresAttributeIndex.AllowFiringWhileUsing,
  EAresAttributeIndex.CanSeeOthersHealth,
  EAresAttributeIndex.DetectionDisabled,
  EAresAttributeIndex.ForceCrouch,
  EAresAttributeIndex.Frozen,
  EAresAttributeIndex.HeavyWeaponsDisabled,
  EAresAttributeIndex.Hide1P,
  EAresAttributeIndex.Hide3P,
  EAresAttributeIndex.HideCrosshair,
  EAresAttributeIndex.HudVisibleToAll,
  EAresAttributeIndex.HudVisibleToInstigator,
  EAresAttributeIndex.InDanger,
  EAresAttributeIndex.Intangible,
  EAresAttributeIndex.Invisible,
  EAresAttributeIndex.InvisibleEquippables,
  EAresAttributeIndex.InvisibleToEnemies,
  EAresAttributeIndex.InvisibleToEnemyNonPlayers,
  EAresAttributeIndex.InvisibleToOwner,
  EAresAttributeIndex.Invulnerable,
  EAresAttributeIndex.MinimapBlinded,
  EAresAttributeIndex.LockMovement,
  EAresAttributeIndex.MapVisibleToAll,
  EAresAttributeIndex.MinimapDisabled,
  EAresAttributeIndex.MinimapInvisible,
  EAresAttributeIndex.PreventAbilities,
  EAresAttributeIndex.PreventCrouch,
  EAresAttributeIndex.PreventDroppingEquippables,
  EAresAttributeIndex.PreventJump,
  EAresAttributeIndex.PreventFiring,
  EAresAttributeIndex.PreventFiringPrimaryWeapon,
  EAresAttributeIndex.PreventFiringSecondaryWeapon,
  EAresAttributeIndex.PreventMeleeAttacking,
  EAresAttributeIndex.PreventMovementInput,
  EAresAttributeIndex.PreventReloading,
  EAresAttributeIndex.PreventSwitchingEquippables,
  EAresAttributeIndex.PreventUseCancelling,
  EAresAttributeIndex.PreventUsing,
  EAresAttributeIndex.PreventPickup,
  EAresAttributeIndex.PrimarySlotDisabled,
  EAresAttributeIndex.Stealthed,
  EAresAttributeIndex.Untrackable,
  EAresAttributeIndex.ThirdPerson,
  EAresAttributeIndex.WeaponsDisabled,
  EAresAttributeIndex.WeaponsLowered,
  EAresAttributeIndex.Disarmed,
  EAresAttributeIndex.GrenadeDisabled,
  EAresAttributeIndex.QDisabled,
  EAresAttributeIndex.EDisabled,
  EAresAttributeIndex.UltimateDisabled,
  EAresAttributeIndex.ZoomDisabled,
  EAresAttributeIndex.EquipmentDisabled,
  EAresAttributeIndex.PreventDeathFromDamage,
  EAresAttributeIndex.BlindImmune,
  EAresAttributeIndex.PreventUsingAbilities,
  EAresAttributeIndex.PreventUsingAscenders,
  EAresAttributeIndex.PreventUsingLoreItems,
  EAresAttributeIndex.DisableRegionalDamageMultipliers,
  EAresAttributeIndex.DisableIncomingDamageCombatTracking,
  EAresAttributeIndex.HealsFromAllyFlames,
  EAresAttributeIndex.Marked,
  EAresAttributeIndex.Suppressed,
  EAresAttributeIndex.PreventDowned,
  EAresAttributeIndex.PreventPlanting,
  EAresAttributeIndex.PreventDefusing,
  EAresAttributeIndex.PreventFollowing,
  EAresAttributeIndex.InPeril,
  EAresAttributeIndex.PreventMinimapFocusing,
  EAresAttributeIndex.ShowObserverKeybindsWhileHidden,
  EAresAttributeIndex.PreventSkinFinisherIfVictim,
  EAresAttributeIndex.PreventTeamWipeCondition,
  EAresAttributeIndex.GroundedFootstepMute,
  EAresAttributeIndex.DelayDeathUltPointReward,
  EAresAttributeIndex.PreventKillUltPointReward,
  EAresAttributeIndex.DisablePrimaryWeaponFocusMode,
  EAresAttributeIndex.AbilityInvulnerable,
  EAresAttributeIndex.DisplacementImmunity,
  EAresAttributeIndex.ImpairmentImmunity,
  EAresAttributeIndex.FastEquipPrimaryWeapon,
  EAresAttributeIndex.FastEquipSecondaryWeapon,
]);

export class AttributeValue {
  Handle = 0;
  AttributeName = "";
  IsBoolean = false;
  BaseValue?: number;
  CurrentValue?: number;
  get BoolValue(): boolean | null {
    return this.IsBoolean ? this.CurrentValue === 1.0 : null;
  }
}

const HealingHandle = EAresAttributeIndex.LegshotDamageMultiplier * 2 + 2;
const DamageHandle = HealingHandle + 1;
const ShieldHandle = HealingHandle + 2;

export class AresAttributeSet {
  Attributes: AttributeValue[] = [];
  Healing?: number;
  Damage?: number;
  Shield?: number;

  get ChangedAttributes(): AttributeValue[] {
    return this.Attributes.filter(
      (a) =>
        a.BaseValue !== undefined &&
        a.CurrentValue !== undefined &&
        Math.abs(a.BaseValue - a.CurrentValue) > 1e-5,
    );
  }

  readFieldHandle(handle: number, reader: NetBitReader): boolean {
    const totalAttributePairs = EAresAttributeIndex.LegshotDamageMultiplier + 1;
    if (handle < totalAttributePairs * 2) {
      const index = Math.floor(handle / 2);
      const isCurrent = handle % 2 !== 0;
      while (this.Attributes.length <= index) {
        this.Attributes.push(new AttributeValue());
      }
      const attr = this.Attributes[index]!;
      attr.Handle = handle;
      attr.AttributeName = EAresAttributeIndex[index] ?? String(index);
      attr.IsBoolean = booleanAttributes.has(index as EAresAttributeIndex);
      if (isCurrent) {
        attr.CurrentValue = reader.serializePropertyFloat();
      } else {
        attr.BaseValue = reader.serializePropertyFloat();
      }
      return true;
    }

    switch (handle) {
      case HealingHandle:
        this.Healing = reader.serializePropertyFloat();
        return true;
      case DamageHandle:
        this.Damage = reader.serializePropertyFloat();
        return true;
      case ShieldHandle:
        this.Shield = reader.serializePropertyFloat();
        return true;
    }
    return false;
  }
}

registry.registerGroup({
  path: "/Script/ShooterGame.AresAttributeSet",
  minimalParseMode: ParseMode.Normal,
  factory: () => new AresAttributeSet(),
  usesHandles: true,
  properties: [],
});

// ---------------------------------------------------------------------------
// Plain models / array-element export groups
// ---------------------------------------------------------------------------

/** Array element export group (no group attribute in C#). */
export class FObfuscatedPlayerInformation {
  SubjectUniqueId?: string;
  bIsAfk?: boolean;
  ConnectionStatus?: EConnectionStatus;
}

/** Sub-group of OwnerExclusivePlayerInfo. */
export class FAresTrackedReward {
  Rewards?: unknown;
  RewardName?: string;
  LocalizedRewardName?: FText;
  InstancesOfReward?: number;
  RewardGrantStrategy?: EAresRewardGrantStrategy;
  Source?: ERewardSource;
}

/** Aggregated, human-friendly player state (not a net export group). */
export class PlayerState {
  ActorId?: number;
  ControllerId?: number;
  CharacterId?: number;
  PlayerId?: number;
  SubjectUniqueId?: string;
  IsAfk?: boolean;
  ConnectionStatus?: EConnectionStatus;
  Position?: FVector;
  SpawnLocation?: FVector;
  IsAlive?: boolean;
  Health?: number;
  Armor?: number;
  MaxHealth?: number;
  Money?: number;
  StartOfRoundMoneyCache?: number;
  StartOfRoundLoadoutValueCache?: number;
  EndOfRoundBeforeRewardsMoney?: number;
  Kills = 0;
  Deaths = 0;
  Assists = 0;
  NumDeathStreak?: number;
  bLoadoutFinalized?: boolean;
  bCanProgressAchievements?: boolean;
  bOnlySpectator?: boolean;
  CompetitiveTier?: number;
  ProfileName?: string;
  TrackedRewards: FAresTrackedReward[] = [];
  AllPlayersInMatch: FObfuscatedPlayerInformation[] = [];
}

// ---------------------------------------------------------------------------
// Net field export groups
// ---------------------------------------------------------------------------

const PN = ParseMode.Normal;
const PF = ParseMode.Full;

export class BaseReplayController {
  RemoteRole?: number;
  Role?: number;
  PlayerState?: number;
  SpawnLocation?: FVector;
}
registry.registerGroup({
  path: "/Game/Characters/_Core/BaseReplayController.BaseReplayController_C",
  minimalParseMode: PN,
  factory: () => new BaseReplayController(),
  usesHandles: true,
  properties: [
    { handle: 3, key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { handle: 12, key: "Role", type: RepLayoutCmdType.Ignore },
    { handle: 14, key: "PlayerState", type: RepLayoutCmdType.PropertyObject },
    { handle: 18, key: "SpawnLocation", type: RepLayoutCmdType.PropertyVector },
  ],
});
registry.registerPlayerController("BaseReplayController_C");

export class BaseReplayPlayerState {
  RemoteRole?: number;
  Owner?: number;
  Role?: number;
  bOnlySpectator?: boolean;
}
registry.registerGroup({
  path: "/Game/GameModes/Common/BaseReplayPlayerState.BaseReplayPlayerState_C",
  minimalParseMode: PN,
  factory: () => new BaseReplayPlayerState(),
  usesHandles: false,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Owner", key: "Owner", type: RepLayoutCmdType.Ignore },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "bOnlySpectator", key: "bOnlySpectator", type: RepLayoutCmdType.PropertyBool },
  ],
});

export class AbilityTrackingDelegateComponent {
  AbilityTrackingComponent?: number;
}
registry.registerGroup({
  path: "/Script/ShooterGame.AbilityTrackingDelegateComponent",
  minimalParseMode: PN,
  factory: () => new AbilityTrackingDelegateComponent(),
  usesHandles: false,
  properties: [
    { name: "AbilityTrackingComponent", key: "AbilityTrackingComponent", type: RepLayoutCmdType.PropertyObject },
  ],
});

export class AresWorldSettings {
  RemoteRole?: number;
  Role?: number;
  WorldGravityZ?: number;
}
registry.registerGroup({
  path: "/Script/ShooterGame.AresWorldSettings",
  minimalParseMode: PN,
  factory: () => new AresWorldSettings(),
  usesHandles: false,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "WorldGravityZ", key: "WorldGravityZ", type: RepLayoutCmdType.PropertyFloat },
  ],
});

export class StealthComponent {
  bReplicates?: boolean;
  bStealthIsActive?: boolean;
  SubscribedToComponent?: number;
}
registry.registerGroup({
  path: "/Script/ShooterGame.StealthComponent",
  minimalParseMode: PN,
  factory: () => new StealthComponent(),
  usesHandles: false,
  properties: [
    { name: "bReplicates", key: "bReplicates", type: RepLayoutCmdType.PropertyBool },
    { name: "bStealthIsActive", key: "bStealthIsActive", type: RepLayoutCmdType.PropertyBool },
    { name: "SubscribedToComponent", key: "SubscribedToComponent", type: RepLayoutCmdType.PropertyObject },
  ],
});

export class TimedBomb {
  RemoteRole?: unknown;
  Role?: unknown;
  TimeRemainingToExplode?: number;
}
registry.registerGroup({
  path: "/Game/GameModes/Bomb/TimedBomb.TimedBomb_C",
  minimalParseMode: PN,
  factory: () => new TimedBomb(),
  usesHandles: false,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "TimeRemainingToExplode", key: "TimeRemainingToExplode", type: RepLayoutCmdType.PropertyFloat },
  ],
});

export class EquippableStateMachineComponent {
  CurrentState?: number;
  TransitionContext?: number;
  AuthStartWorldTime?: number;
}
registry.registerGroup({
  path: "/Script/ShooterGame.EquippableStateMachineComponent",
  minimalParseMode: PN,
  factory: () => new EquippableStateMachineComponent(),
  usesHandles: false,
  properties: [
    { name: "CurrentState", key: "CurrentState", type: RepLayoutCmdType.Ignore },
    { name: "TransitionContext", key: "TransitionContext", type: RepLayoutCmdType.Ignore },
    { name: "AuthStartWorldTime", key: "AuthStartWorldTime", type: RepLayoutCmdType.PropertyFloat },
  ],
});

export class EquipmentChargeComponent {
  AuthResourceAmount?: number;
}
registry.registerGroup({
  path: "/Script/ShooterGame.EquipmentChargeComponent",
  minimalParseMode: PN,
  factory: () => new EquipmentChargeComponent(),
  usesHandles: false,
  properties: [
    { name: "AuthResourceAmount", key: "AuthResourceAmount", type: RepLayoutCmdType.PropertyFloat },
  ],
});

export class PurchasedItemComponent {
  Purchaseable?: number;
  bIsCurrentSessionPurchase?: boolean;
  PurchasingPlayerState?: number;
  PurchasableTransactionSource?: number;
}
registry.registerGroup({
  path: "/Script/ShooterGame.PurchasedItemComponent",
  minimalParseMode: PN,
  factory: () => new PurchasedItemComponent(),
  usesHandles: false,
  properties: [
    { name: "Purchaseable", key: "Purchaseable", type: RepLayoutCmdType.Ignore },
    { name: "bIsCurrentSessionPurchase", key: "bIsCurrentSessionPurchase", type: RepLayoutCmdType.PropertyBool },
    { name: "PurchasingPlayerState", key: "PurchasingPlayerState", type: RepLayoutCmdType.PropertyObject },
    { name: "PurchasableTransactionSource", key: "PurchasableTransactionSource", type: RepLayoutCmdType.Ignore },
  ],
});

export class UsableComponent {
  bIsActive?: boolean;
}
registry.registerGroup({
  path: "/Script/ShooterGame.UsableComponent",
  minimalParseMode: PN,
  factory: () => new UsableComponent(),
  usesHandles: false,
  properties: [
    { name: "bIsActive", key: "bIsActive", type: RepLayoutCmdType.PropertyBool },
  ],
});

export class BombTeamComponent {
  Team?: EAresTeam;
}
registry.registerGroup({
  path: "/Script/ShooterGame.BombTeamComponent",
  minimalParseMode: PF,
  factory: () => new BombTeamComponent(),
  usesHandles: false,
  properties: [{ name: "Team", key: "Team", type: RepLayoutCmdType.Enum }],
});

export class BombGameState {
  RemoteRole?: number;
  Role?: number;
  GameModeClass?: number;
  SpectatorClass?: number;
  PlayerArray?: number;
  bReplicatedHasBegunPlay?: boolean;
  ReplicatedWorldTimeSecondsDouble?: number;
  MatchState?: number;
  bBotDesiredCharactersReady?: boolean;
  bShouldPerformanceInstabilityTrackingBeEnabled?: boolean;
  TeamEconomy?: number;
  TeamComponents?: number;
  Phase?: number;
  DisplayRemainingTime?: number;
  StateRemainingTime?: number;
  GamePhaseElapsedTime?: number;
  NetServerMaxTickRate?: number;
  MatchID?: number;
  GameStateHUDConfig?: number;
  AllowedVoteTypes?: number;
  ModifierManager?: number;
}
registry.registerGroup({
  path: "/Game/GameModes/Bomb/BombGameState.BombGameState_C",
  minimalParseMode: PN,
  factory: () => new BombGameState(),
  usesHandles: false,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "GameModeClass", key: "GameModeClass", type: RepLayoutCmdType.Ignore },
    { name: "SpectatorClass", key: "SpectatorClass", type: RepLayoutCmdType.Ignore },
    { name: "PlayerArray", key: "PlayerArray", type: RepLayoutCmdType.Ignore },
    { name: "bReplicatedHasBegunPlay", key: "bReplicatedHasBegunPlay", type: RepLayoutCmdType.PropertyBool },
    { name: "ReplicatedWorldTimeSecondsDouble", key: "ReplicatedWorldTimeSecondsDouble", type: RepLayoutCmdType.PropertyDouble },
    { name: "MatchState", key: "MatchState", type: RepLayoutCmdType.Ignore },
    { name: "bBotDesiredCharactersReady", key: "bBotDesiredCharactersReady", type: RepLayoutCmdType.PropertyBool },
    { name: "bShouldPerformanceInstabilityTrackingBeEnabled", key: "bShouldPerformanceInstabilityTrackingBeEnabled", type: RepLayoutCmdType.PropertyBool },
    { name: "TeamEconomy", key: "TeamEconomy", type: RepLayoutCmdType.Ignore },
    { name: "TeamComponents", key: "TeamComponents", type: RepLayoutCmdType.Ignore },
    { name: "Phase", key: "Phase", type: RepLayoutCmdType.Ignore },
    { name: "DisplayRemainingTime", key: "DisplayRemainingTime", type: RepLayoutCmdType.Ignore },
    { name: "StateRemainingTime", key: "StateRemainingTime", type: RepLayoutCmdType.Ignore },
    { name: "GamePhaseElapsedTime", key: "GamePhaseElapsedTime", type: RepLayoutCmdType.Ignore },
    { name: "NetServerMaxTickRate", key: "NetServerMaxTickRate", type: RepLayoutCmdType.Ignore },
    { name: "MatchID", key: "MatchID", type: RepLayoutCmdType.Ignore },
    { name: "GameStateHUDConfig", key: "GameStateHUDConfig", type: RepLayoutCmdType.Ignore },
    { name: "AllowedVoteTypes", key: "AllowedVoteTypes", type: RepLayoutCmdType.Ignore },
    { name: "ModifierManager", key: "ModifierManager", type: RepLayoutCmdType.Ignore },
  ],
});

export class OwnerExclusivePlayerInfo extends FObfuscatedPlayerInformation {
  RemoteRole?: number;
  Owner?: number;
  Role?: number;
  AresController?: number;
  NumDeathStreak?: number;
  StartOfRoundMoneyCache?: number;
  StartOfRoundLoadoutValueCache?: number;
  TrackedRewards?: FAresTrackedReward[];
  EndOfRoundBeforeRewardsMoney?: number;
  bLoadoutFinalized?: boolean;
  bCanProgressAchievements?: boolean;
  CombatReportComponent?: number;
  KillStreakComponent?: number;
  PersonalizationComponent?: number;
  SprayLoadoutComponent?: number;
  TotemLoadoutComponent?: number;
  PlayerPurchaseablesComponent?: number;
  ExtendedCombatReportComponent?: number;
  AllPlayersObfuscatedPlayerInformation?: FObfuscatedPlayerInformation[];
}
registry.registerGroup({
  path: "/Script/ShooterGame.OwnerExclusivePlayerInfo",
  minimalParseMode: PN,
  factory: () => new OwnerExclusivePlayerInfo(),
  usesHandles: false,
  properties: [
    // Inherited from FObfuscatedPlayerInformation
    { name: "SubjectUniqueId", key: "SubjectUniqueId", type: RepLayoutCmdType.PropertyNetId },
    { name: "bIsAfk", key: "bIsAfk", type: RepLayoutCmdType.PropertyBool },
    { name: "ConnectionStatus", key: "ConnectionStatus", type: RepLayoutCmdType.Enum },
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Owner", key: "Owner", type: RepLayoutCmdType.Ignore },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "AresController", key: "AresController", type: RepLayoutCmdType.PropertyObject },
    { name: "NumDeathStreak", key: "NumDeathStreak", type: RepLayoutCmdType.PropertyInt },
    { name: "StartOfRoundMoneyCache", key: "StartOfRoundMoneyCache", type: RepLayoutCmdType.PropertyInt },
    { name: "StartOfRoundLoadoutValueCache", key: "StartOfRoundLoadoutValueCache", type: RepLayoutCmdType.PropertyInt },
    // Element type FAresTrackedReward is neither the group type nor its base,
    // so C#'s ReadArrayField returns null (data consumed, not assigned).
    { name: "TrackedRewards", key: "TrackedRewards", type: RepLayoutCmdType.DynamicArray, elementFactory: null },
    { name: "EndOfRoundBeforeRewardsMoney", key: "EndOfRoundBeforeRewardsMoney", type: RepLayoutCmdType.PropertyInt },
    { name: "bLoadoutFinalized", key: "bLoadoutFinalized", type: RepLayoutCmdType.PropertyBool },
    { name: "bCanProgressAchievements", key: "bCanProgressAchievements", type: RepLayoutCmdType.PropertyBool },
    { name: "CombatReportComponent", key: "CombatReportComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "KillStreakComponent", key: "KillStreakComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "PersonalizationComponent", key: "PersonalizationComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "SprayLoadoutComponent", key: "SprayLoadoutComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "TotemLoadoutComponent", key: "TotemLoadoutComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "PlayerPurchaseablesComponent", key: "PlayerPurchaseablesComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "ExtendedCombatReportComponent", key: "ExtendedCombatReportComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "AllPlayersObfuscatedPlayerInformation", key: "AllPlayersObfuscatedPlayerInformation", type: RepLayoutCmdType.DynamicArray, elementFactory: () => new FObfuscatedPlayerInformation() },
  ],
});

// FAresTrackedReward is a sub-group of OwnerExclusivePlayerInfo: its fields
// merge into the parent's property list (per [NetFieldExportSubGroup]).
registry.registerSubGroup("/Script/ShooterGame.OwnerExclusivePlayerInfo", [
  { name: "Rewards", key: "Rewards", type: RepLayoutCmdType.Ignore },
  { name: "RewardName", key: "RewardName", type: RepLayoutCmdType.PropertyName },
  { name: "LocalizedRewardName", key: "LocalizedRewardName", type: RepLayoutCmdType.Property, elementFactory: () => new FText() },
  { name: "InstancesOfReward", key: "InstancesOfReward", type: RepLayoutCmdType.PropertyInt },
  { name: "RewardGrantStrategy", key: "RewardGrantStrategy", type: RepLayoutCmdType.Enum },
  { name: "Source", key: "Source", type: RepLayoutCmdType.Enum },
]);

export class AresAbilitySystemComponent {
  OwnerActor?: number;
  AvatarActor?: number;
  Def?: number;
  ModifiedAttributes?: number;
  Duration?: number;
  Period?: number;
  ChanceToApplyToTarget?: number;
  DynamicGrantedTags?: number;
  DynamicAssetTags?: number;
  Modifiers?: number;
  EvaluatedMagnitude?: number;
  StackCount?: number;
  GrantedAbilitySpecs?: number;
  EffectContext?: number;
  Level?: number;
  PredictionKey?: number;
  GrantedAbilityHandles?: number;
  StartServerWorldTime?: number;
  SpawnedAttributes?: number;
  CachedAttributeSet?: number;
}
registry.registerGroup({
  path: "/Script/ShooterGame.AresAbilitySystemComponent",
  minimalParseMode: PN,
  factory: () => new AresAbilitySystemComponent(),
  usesHandles: false,
  properties: [
    { name: "OwnerActor", key: "OwnerActor", type: RepLayoutCmdType.PropertyObject },
    { name: "AvatarActor", key: "AvatarActor", type: RepLayoutCmdType.PropertyObject },
    { name: "Def", key: "Def", type: RepLayoutCmdType.Ignore },
    { name: "ModifiedAttributes", key: "ModifiedAttributes", type: RepLayoutCmdType.Ignore },
    { name: "Duration", key: "Duration", type: RepLayoutCmdType.PropertyFloat },
    { name: "Period", key: "Period", type: RepLayoutCmdType.PropertyFloat },
    { name: "ChanceToApplyToTarget", key: "ChanceToApplyToTarget", type: RepLayoutCmdType.PropertyFloat },
    { name: "DynamicGrantedTags", key: "DynamicGrantedTags", type: RepLayoutCmdType.Ignore },
    { name: "DynamicAssetTags", key: "DynamicAssetTags", type: RepLayoutCmdType.Ignore },
    { name: "Modifiers", key: "Modifiers", type: RepLayoutCmdType.Ignore },
    { name: "EvaluatedMagnitude", key: "EvaluatedMagnitude", type: RepLayoutCmdType.Ignore },
    { name: "StackCount", key: "StackCount", type: RepLayoutCmdType.PropertyInt },
    { name: "GrantedAbilitySpecs", key: "GrantedAbilitySpecs", type: RepLayoutCmdType.Ignore },
    { name: "EffectContext", key: "EffectContext", type: RepLayoutCmdType.Ignore },
    { name: "Level", key: "Level", type: RepLayoutCmdType.PropertyFloat },
    { name: "PredictionKey", key: "PredictionKey", type: RepLayoutCmdType.Ignore },
    { name: "GrantedAbilityHandles", key: "GrantedAbilityHandles", type: RepLayoutCmdType.Ignore },
    { name: "StartServerWorldTime", key: "StartServerWorldTime", type: RepLayoutCmdType.PropertyFloat },
    { name: "SpawnedAttributes", key: "SpawnedAttributes", type: RepLayoutCmdType.Ignore },
    { name: "CachedAttributeSet", key: "CachedAttributeSet", type: RepLayoutCmdType.PropertyObject },
  ],
});

export class Ability_Gumshoe_E_TripWire {
  RemoteRole?: number;
  AttachParent?: number;
  RelativeScale3D?: FVector;
  AttachComponent?: number;
  Owner?: number;
  Role?: number;
  Instigator?: number;
  CosmeticRandomSeed?: number;
  CreatedByCharacter?: number;
}
registry.registerGroup({
  path: "/Game/Characters/Gumshoe/S0/Ability_E/Ability_Gumshoe_E_TripWire.Ability_Gumshoe_E_TripWire_C",
  minimalParseMode: PN,
  factory: () => new Ability_Gumshoe_E_TripWire(),
  usesHandles: false,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "AttachParent", key: "AttachParent", type: RepLayoutCmdType.PropertyObject },
    { name: "RelativeScale3D", key: "RelativeScale3D", type: RepLayoutCmdType.PropertyVector100 },
    { name: "AttachComponent", key: "AttachComponent", type: RepLayoutCmdType.PropertyObject },
    { name: "Owner", key: "Owner", type: RepLayoutCmdType.PropertyObject },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "Instigator", key: "Instigator", type: RepLayoutCmdType.PropertyObject },
    { name: "CosmeticRandomSeed", key: "CosmeticRandomSeed", type: RepLayoutCmdType.PropertyInt },
    { name: "CreatedByCharacter", key: "CreatedByCharacter", type: RepLayoutCmdType.PropertyObject },
  ],
});

export class GameObject_Gumshoe_E_TripWire {
  RemoteRole?: number;
  Owner?: number;
  Role?: number;
  Instigator?: number;
  Deployed?: boolean;
}
registry.registerGroup({
  path: "/Game/Characters/Gumshoe/S0/Ability_E/GameObject_Gumshoe_E_TripWire.GameObject_Gumshoe_E_TripWire_C",
  minimalParseMode: PN,
  factory: () => new GameObject_Gumshoe_E_TripWire(),
  usesHandles: false,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Owner", key: "Owner", type: RepLayoutCmdType.PropertyObject },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "Instigator", key: "Instigator", type: RepLayoutCmdType.PropertyObject },
    { name: "Deployed", key: "Deployed", type: RepLayoutCmdType.PropertyBool },
  ],
});

export class GameObject_Gumshoe_E_TripWire_SecondWire {
  RemoteRole?: number;
  Owner?: number;
  Role?: number;
  Instigator?: number;
}
registry.registerGroup({
  path: "/Game/Characters/Gumshoe/S0/Ability_E/GameObject_Gumshoe_E_TripWire_SecondWire.GameObject_Gumshoe_E_TripWire_SecondWire_C",
  minimalParseMode: PN,
  factory: () => new GameObject_Gumshoe_E_TripWire_SecondWire(),
  usesHandles: false,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Owner", key: "Owner", type: RepLayoutCmdType.PropertyObject },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { name: "Instigator", key: "Instigator", type: RepLayoutCmdType.PropertyObject },
  ],
});

export class RemoteCharacterUpdate {
  ShooterCharacterNetGuidValue?: number;
  ComponentDataStream?: ComponentDataStream;
}
registry.registerGroup({
  path: "/Script/ShooterGame.RemoteCharacterUpdate",
  minimalParseMode: PN,
  factory: () => new RemoteCharacterUpdate(),
  usesHandles: false,
  properties: [
    { name: "ShooterCharacterNetGuidValue", key: "ShooterCharacterNetGuidValue", type: RepLayoutCmdType.PropertyUInt32 },
    { name: "ComponentDataStream", key: "ComponentDataStream", type: RepLayoutCmdType.Property, elementFactory: () => new ComponentDataStream() },
  ],
});

export class ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous extends RemoteCharacterUpdate {
  RemoteCharacterUpdates?: RemoteCharacterUpdate[];
}
registry.registerGroup({
  path: "/Script/ShooterGame.ReplayPlayerController:ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous",
  minimalParseMode: PN,
  factory: () => new ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous(),
  usesHandles: false,
  properties: [
    { name: "ShooterCharacterNetGuidValue", key: "ShooterCharacterNetGuidValue", type: RepLayoutCmdType.PropertyUInt32 },
    { name: "ComponentDataStream", key: "ComponentDataStream", type: RepLayoutCmdType.Property, elementFactory: () => new ComponentDataStream() },
    { name: "RemoteCharacterUpdates", key: "RemoteCharacterUpdates", type: RepLayoutCmdType.DynamicArray, elementFactory: () => new RemoteCharacterUpdate() },
  ],
});

export class ClientGamePhaseEnded {
  OldPhase?: EAresGamePhase;
}
registry.registerGroup({
  path: "/Script/ShooterGame.AresPlayerController:ClientGamePhaseEnded",
  minimalParseMode: PN,
  factory: () => new ClientGamePhaseEnded(),
  usesHandles: false,
  properties: [{ name: "OldPhase", key: "OldPhase", type: RepLayoutCmdType.Enum }],
});

export class ClientReplayReceiveInputEventProcessingCapture {
  PlayerID?: number;
  InputEventData?: unknown[];
}
registry.registerGroup({
  path: "/Script/ShooterGame.ReplayPlayerController:ClientReplayReceiveInputEventProcessingCapture",
  minimalParseMode: PN,
  factory: () => new ClientReplayReceiveInputEventProcessingCapture(),
  usesHandles: false,
  properties: [
    { name: "PlayerID", key: "PlayerID", type: RepLayoutCmdType.PropertyInt },
    { name: "InputEventData", key: "InputEventData", type: RepLayoutCmdType.DynamicArray, elementFactory: null, elementType: RepLayoutCmdType.PropertyByte },
  ],
});

// Empty RPC marker groups
export class ClientCleanUpLocationalEffects {}
registry.registerGroup({
  path: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientCleanUpLocationalEffects",
  minimalParseMode: PN,
  factory: () => new ClientCleanUpLocationalEffects(),
  usesHandles: false,
  properties: [],
});
export class ClientPlayOneShotEffectAtLocation {}
registry.registerGroup({
  path: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientPlayOneShotEffectAtLocation",
  minimalParseMode: PN,
  factory: () => new ClientPlayOneShotEffectAtLocation(),
  usesHandles: false,
  properties: [],
});
export class ReplayPlayContinuousEffectAtLocation {}
registry.registerGroup({
  path: "/Script/ShooterGame.ReplayEffectComponent",
  minimalParseMode: PN,
  factory: () => new ReplayPlayContinuousEffectAtLocation(),
  usesHandles: false,
  properties: [],
});

/** FQuat that derives W from X,Y,Z. see Unreal UnrealMath.cpp quat net serialize. */
export class QuatProperty implements IProperty {
  X = 0;
  Y = 0;
  Z = 0;
  W = 0;
  serialize(reader: NetBitReader): void {
    this.X = reader.readSingle();
    this.Y = reader.readSingle();
    this.Z = reader.readSingle();
    const xyzMagSquared = this.X * this.X + this.Y * this.Y + this.Z * this.Z;
    const wSquared = 1.0 - xyzMagSquared;
    if (wSquared >= 0) {
      this.W = Math.sqrt(wSquared);
    } else {
      this.W = 0;
      const inv = 1 / Math.sqrt(xyzMagSquared);
      this.X *= inv;
      this.Y *= inv;
      this.Z *= inv;
    }
  }
}

// MulticastPlayContinuousEffectFromClient — group referenced by BasePistol cache
export class MulticastPlayContinuousEffectFromClient {
  EffectManagerComponent?: unknown;
  EffectContainer?: unknown;
  WaitOnReplicationActor?: unknown;
  ObjectValues?: unknown;
  Name?: unknown;
  Object?: unknown;
  Rotation?: import("../io/models.js").FQuat;
  Translation?: FVector;
  Scale3D?: FVector;
  EffectID?: number;
  SourceID?: string;
  bLocalEffect?: boolean;
  bTransient?: boolean;
  ClientControllerThatTriggered?: unknown;
  StartMovementTime?: number;
  AllianceFilter?: EAresAlliance;
}
registry.registerGroup({
  path: "/Script/ShooterGame.AresEquippable:MulticastPlayContinuousEffectFromClient",
  minimalParseMode: PN,
  factory: () => new MulticastPlayContinuousEffectFromClient(),
  usesHandles: false,
  properties: [
    { name: "EffectManagerComponent", key: "EffectManagerComponent", type: RepLayoutCmdType.Ignore },
    { name: "EffectContainer", key: "EffectContainer", type: RepLayoutCmdType.Ignore },
    { name: "WaitOnReplicationActor", key: "WaitOnReplicationActor", type: RepLayoutCmdType.Ignore },
    { name: "ObjectValues", key: "ObjectValues", type: RepLayoutCmdType.Ignore },
    { name: "Name", key: "Name", type: RepLayoutCmdType.Ignore },
    { name: "Object", key: "Object", type: RepLayoutCmdType.Ignore },
    { name: "Translation", key: "Rotation", type: RepLayoutCmdType.PropertyQuat, elementFactory: () => new QuatProperty() },
    { name: "Translation", key: "Translation", type: RepLayoutCmdType.PropertyVector },
    { name: "Scale3D", key: "Scale3D", type: RepLayoutCmdType.PropertyVector },
    { name: "EffectID", key: "EffectID", type: RepLayoutCmdType.PropertyUInt64 },
    { name: "SourceID", key: "SourceID", type: RepLayoutCmdType.PropertyString },
    { name: "bLocalEffect", key: "bLocalEffect", type: RepLayoutCmdType.PropertyBool },
    { name: "StartMovementTime", key: "ClientControllerThatTriggered", type: RepLayoutCmdType.Ignore },
    { name: "StartMovementTime", key: "StartMovementTime", type: RepLayoutCmdType.PropertyFloat },
    { name: "AllianceFilter", key: "AllianceFilter", type: RepLayoutCmdType.Enum },
  ],
});

export class BombPlayerState {
  RemoteRole?: number;
  Owner?: number;
  Role?: number;
  PlayerId?: number;
  Ping?: number;
  UniqueId?: number;
  CompetitiveTier?: number;
  Subject?: number;
  PlayerInfo?: number;
  PlayerMatchStatsComponent?: number;
  PlayerScoreComponent?: number;
  AFKDetectionComponent?: number;
  ProfileName?: string;
}
registry.registerGroup({
  path: "/Game/GameModes/Bomb/BombPlayerState.BombPlayerState_C",
  minimalParseMode: PN,
  factory: () => new BombPlayerState(),
  usesHandles: true,
  properties: [
    { name: "RemoteRole", key: "RemoteRole", type: RepLayoutCmdType.Ignore },
    { name: "Owner", key: "Owner", type: RepLayoutCmdType.Ignore },
    { name: "Role", key: "Role", type: RepLayoutCmdType.Ignore },
    { handle: 14, key: "PlayerId", type: RepLayoutCmdType.PropertyInt },
    { handle: 15, key: "Ping", type: RepLayoutCmdType.PropertyUInt16 },
    { handle: 20, key: "UniqueId", type: RepLayoutCmdType.Ignore },
    { handle: 22, key: "CompetitiveTier", type: RepLayoutCmdType.PropertyInt },
    { name: "Subject", key: "Subject", type: RepLayoutCmdType.Ignore },
    { name: "PlayerInfo", key: "PlayerInfo", type: RepLayoutCmdType.Ignore },
    { name: "PlayerMatchStatsComponent", key: "PlayerMatchStatsComponent", type: RepLayoutCmdType.Ignore },
    { name: "PlayerScoreComponent", key: "PlayerScoreComponent", type: RepLayoutCmdType.Ignore },
    { name: "AFKDetectionComponent", key: "AFKDetectionComponent", type: RepLayoutCmdType.Ignore },
    { handle: 197, key: "ProfileName", type: RepLayoutCmdType.PropertyString },
  ],
});

// ---------------------------------------------------------------------------
// Class net caches (RPC function dispatch)
// ---------------------------------------------------------------------------

registry.registerClassNetCache({
  path: "BasePistol_C_ClassNetCache",
  minimalParseMode: PN,
  properties: [
    {
      name: "MulticastPlayContinuousEffectFromClient",
      pathName: "/Script/ShooterGame.AresEquippable:MulticastPlayContinuousEffectFromClient",
      isFunction: true,
      enablePropertyChecksum: true,
      isCustomStruct: false,
    },
  ],
});

registry.registerClassNetCache({
  path: "BaseReplayController_C_ClassNetCache",
  minimalParseMode: PF,
  properties: [
    { name: "ClientReplayReceiveInputEventProcessingCapture", pathName: "/Script/ShooterGame.ReplayPlayerController:ClientReplayReceiveInputEventProcessingCapture", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
    { name: "ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous", pathName: "/Script/ShooterGame.ReplayPlayerController:ReplaysClientReceiveRemoteCharacterUpdatesSingleArrayNoAutonomous", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
    { name: "ClientGamePhaseBegin", pathName: "/Script/ShooterGame.AresPlayerController:ClientGamePhaseBegin", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
    { name: "ClientGamePhaseEnded", pathName: "/Script/ShooterGame.AresPlayerController:ClientGamePhaseEnded", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
    { name: "ClientOnWinningTeam", pathName: "/Script/ShooterGame.AresPlayerController:ClientOnWinningTeam", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
    { name: "ClientFlushLevelStreaming", pathName: "/Script/Engine.PlayerController:ClientFlushLevelStreaming", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
    { name: "ClientUpdateMultipleLevelsStreamingStatus", pathName: "/Script/Engine.PlayerController:ClientUpdateMultipleLevelsStreamingStatus", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
  ],
});

registry.registerClassNetCache({
  path: "LocationalEffectManagerComponent_ClassNetCache",
  minimalParseMode: PN,
  properties: [
    { name: "ClientCleanUpLocationalEffects", pathName: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientCleanUpLocationalEffects", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
    { name: "ClientPlayOneShotEffectAtLocation", pathName: "/Script/ShooterGame.LocationalEffectManagerComponent:ClientPlayOneShotEffectAtLocation", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
  ],
});

registry.registerClassNetCache({
  path: "ReplayEffectComponent_ClassNetCache",
  minimalParseMode: PN,
  properties: [
    { name: "ReplayPlayContinuousEffectAtLocation", pathName: "/Script/ShooterGame.ReplayEffectComponent", isFunction: true, enablePropertyChecksum: true, isCustomStruct: false },
  ],
});
