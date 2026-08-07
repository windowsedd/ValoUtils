//! Valorant-specific enums.
//! Ported from `package/ts-replay-parser/src/valorant/models.ts` (enum section).

#![allow(non_camel_case_types, dead_code)]

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum EAresGamePhase {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum EAresRewardGrantStrategy {
    Immediately = 0,
    EndOfRound = 1,
    StartOfRound = 2,
    EAresRewardGrantStrategy_MAX = 255,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum EAresTeam {
    AresTeam_Red = 0,
    AresTeam_Blue = 1,
    AresTeam_Invalid = 254,
    EAresTeam_MAX = 255,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum EConnectionStatus {
    Uninitialized = 0,
    Disconnected = 1,
    Unresponsive = 2,
    Connecting = 3,
    Connected = 4,
    Count = 5,
    EConnectionStatus_MAX = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum ERewardSource {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum EAresAlliance {
    Alliance_Ally = 0,
    Alliance_Enemy = 1,
    Alliance_Neutral = 2,
    Alliance_Any = 3,
    Alliance_Count = 4,
    Alliance_MAX = 5,
}

/// Mirrors TS `EAresAttributeIndex` — the numeric enum indexing
/// `AresAttributeSet`'s handle-driven attribute pairs. Kept as `u32` discriminants
/// matching the TS declaration order exactly (0..=141).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u32)]
pub enum EAresAttributeIndex {
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

impl EAresAttributeIndex {
    /// All 142 discriminants in ascending order (mirrors iterating the TS
    /// numeric enum 0..=141).
    pub const COUNT: u32 = 142;

    pub fn from_index(index: u32) -> Option<EAresAttributeIndex> {
        use EAresAttributeIndex::*;
        const TABLE: [EAresAttributeIndex; 142] = [
            AllowFiringWhileUsing, BonusDamage, CanSeeOthersHealth, DamageReduction, DefensiveDetectionDuration,
            DescendingGravityModifier, DetectionDelay, DetectionDisabled, EquippableMovementModifier, HealingEffectiveness,
            ShieldRestoreEffectiveness, FiringErrorModifier, FiringRateModifier, StabilityMovementModifier, GravityModifier,
            FootstepVolumeReduction, ForceCrouch, Frozen, HeavyWeaponsDisabled, Hide1P, Hide3P, HideCrosshair,
            HudVisibleToAll, HudVisibleToInstigator, InDanger, Intangible, Invisible, InvisibleEquippables,
            InvisibleToEnemies, InvisibleToEnemyNonPlayers, InvisibleToOwner, Invulnerable, JumpForceModifier,
            JumpMovementSlow, MinimapBlinded, MinimumAboveMaxSpeedDecayRateReduction, FallDamageReduction, LockMovement,
            MagazineBonus, MapVisibleToAll, MaxHealthModifier, MaxShieldModifier, MaxTurnRate, MinError,
            MinimapDetectionDelay, MinimapDisabled, MinimapInvisible, MinimapViewDistance, MaxVisionDistance,
            MoneyKillRewardModifier, MovementBonus, MovementBonusCrouch, MovementBonusFlying, MovementBonusJump,
            MovementBonusRun, MovementBonusWalk, MovementErrorModifier, MovementSlow, OffensiveDetectionDuration,
            PickupAmmoBonus, PreventAbilities, PreventCrouch, PreventDroppingEquippables, PreventJump, PreventFiring,
            PreventFiringPrimaryWeapon, PreventFiringSecondaryWeapon, PreventMeleeAttacking, PreventMovementInput,
            PreventReloading, PreventSwitchingEquippables, PreventUseCancelling, PreventUsing, PreventPickup,
            PrimarySlotDisabled, ReduceAbilityMovementPenalty, ReduceTaggingMovementPenalty, ReloadTimeModifier,
            SpreadRecoveryModifier, Stealthed, Untrackable, RecoilModifier, ThirdPerson, TurnRatePenalty,
            UltimatePointsDeathModifier, UltimatePointsDefuseModifier, UltimatePointsKillModifier,
            UltimatePointsPickUpModifier, UltimatePointsPlantModifier, UsingTimeModifier, WallPenetrationDistanceModifier,
            WeaponDrawTimeModifier, FastEquipPrimaryWeapon, FastEquipSecondaryWeapon, WeaponsDisabled, WeaponsLowered,
            Disarmed, GrenadeDisabled, QDisabled, EDisabled, UltimateDisabled, ZoomDisabled, EquipmentDisabled,
            TemporaryDamage, IncomingDamageShieldPenetrationModifier, IncomingSelfDamageModifier,
            IncomingAllyDamageModifier, PreventDeathFromDamage, BlindImmune, PreventUsingAbilities,
            PreventUsingAscenders, PreventUsingLoreItems, OverrideEquippableBaseMovement,
            DisableRegionalDamageMultipliers, DisableIncomingDamageCombatTracking, HealsFromAllyFlames, Marked,
            Suppressed, PreventDowned, PreventPlanting, PreventDefusing, PreventFollowing, InPeril,
            PreventMinimapFocusing, SensitivityModifier, ShowObserverKeybindsWhileHidden, PreventSkinFinisherIfVictim,
            PreventTeamWipeCondition, GroundedFootstepMute, DelayDeathUltPointReward, PreventKillUltPointReward,
            DashSpeedMultiplier, DisablePrimaryWeaponFocusMode, AbilityInvulnerable, DisplacementImmunity,
            ImpairmentImmunity, BombPlantTime, BombDefuseTime, FootstepPlayTimeMultiplier, HeadshotDamageMultiplier,
            NormalDamageMultiplier, LegshotDamageMultiplier,
        ];
        TABLE.get(index as usize).copied()
    }

    /// Mirrors TS `EAresAttributeIndex[index]` (reverse numeric-enum lookup)
    /// used for `AttributeValue.AttributeName`.
    pub fn name(index: u32) -> String {
        match Self::from_index(index) {
            Some(v) => format!("{v:?}"),
            None => index.to_string(),
        }
    }

    /// Mirrors the TS `booleanAttributes` Set literal.
    pub fn is_boolean(index: EAresAttributeIndex) -> bool {
        use EAresAttributeIndex::*;
        matches!(
            index,
            AllowFiringWhileUsing
                | CanSeeOthersHealth
                | DetectionDisabled
                | ForceCrouch
                | Frozen
                | HeavyWeaponsDisabled
                | Hide1P
                | Hide3P
                | HideCrosshair
                | HudVisibleToAll
                | HudVisibleToInstigator
                | InDanger
                | Intangible
                | Invisible
                | InvisibleEquippables
                | InvisibleToEnemies
                | InvisibleToEnemyNonPlayers
                | InvisibleToOwner
                | Invulnerable
                | MinimapBlinded
                | LockMovement
                | MapVisibleToAll
                | MinimapDisabled
                | MinimapInvisible
                | PreventAbilities
                | PreventCrouch
                | PreventDroppingEquippables
                | PreventJump
                | PreventFiring
                | PreventFiringPrimaryWeapon
                | PreventFiringSecondaryWeapon
                | PreventMeleeAttacking
                | PreventMovementInput
                | PreventReloading
                | PreventSwitchingEquippables
                | PreventUseCancelling
                | PreventUsing
                | PreventPickup
                | PrimarySlotDisabled
                | Stealthed
                | Untrackable
                | ThirdPerson
                | WeaponsDisabled
                | WeaponsLowered
                | Disarmed
                | GrenadeDisabled
                | QDisabled
                | EDisabled
                | UltimateDisabled
                | ZoomDisabled
                | EquipmentDisabled
                | PreventDeathFromDamage
                | BlindImmune
                | PreventUsingAbilities
                | PreventUsingAscenders
                | PreventUsingLoreItems
                | DisableRegionalDamageMultipliers
                | DisableIncomingDamageCombatTracking
                | HealsFromAllyFlames
                | Marked
                | Suppressed
                | PreventDowned
                | PreventPlanting
                | PreventDefusing
                | PreventFollowing
                | InPeril
                | PreventMinimapFocusing
                | ShowObserverKeybindsWhileHidden
                | PreventSkinFinisherIfVictim
                | PreventTeamWipeCondition
                | GroundedFootstepMute
                | DelayDeathUltPointReward
                | PreventKillUltPointReward
                | DisablePrimaryWeaponFocusMode
                | AbilityInvulnerable
                | DisplacementImmunity
                | ImpairmentImmunity
                | FastEquipPrimaryWeapon
                | FastEquipSecondaryWeapon
        )
    }
}
