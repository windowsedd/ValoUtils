//! Valorant-specific concrete reader + replicated models. Ported from
//! `package/ts-replay-parser/src/valorant/`. Depends on `crate::replay::unreal`
//! (never the other way — see `PORTING.md`'s layering rule:
//! `valorant -> unreal -> {io, ooz, transform}`).

pub mod app_parser;
pub mod enums;
pub mod models;
pub mod replay_reader;

pub use app_parser::{
    parse_replay_for_app, AppChannelOpen, AppExportRecord, AppParseResult, MovementSample,
};
pub use replay_reader::{
    ExportRecord, ValorantHooks, ValorantReplay, ValorantReplayReader, ValorantReplayResult,
};
