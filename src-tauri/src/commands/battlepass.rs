//! The signed-in player's battle pass progress.
//!
//! Riot's contracts document mixes agent gear, event passes and every act
//! battle pass the account has ever touched. This command flattens that into
//! per-contract XP/level plus the contract ids the account has bought premium
//! for. The frontend joins those ids to the public valorant-api.com catalog
//! so reward art can stay off the game API.

use crate::riot::api;
use crate::riot::client::RiotState;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

/// Item type for purchased contract / battle-pass upgrades.
const CONTRACT_ITEM_TYPE: &str = "f85cb6f7-33e5-4dc8-b609-ec7212301948";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractProgress {
    pub id: String,
    pub level: u64,
    pub xp_toward_next: u64,
    pub total_xp: u64,
}

fn as_u64(value: Option<&Value>) -> u64 {
    value
        .and_then(|entry| entry.as_u64().or_else(|| entry.as_i64().map(|n| n.max(0) as u64)))
        .unwrap_or(0)
}

fn as_str(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn parse_contract_progress(contracts: &Value) -> Vec<ContractProgress> {
    contracts
        .get("Contracts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = as_str(entry.get("ContractDefinitionID"));
            if id.is_empty() {
                return None;
            }
            Some(ContractProgress {
                id,
                level: as_u64(entry.get("ProgressionLevelReached")),
                xp_toward_next: as_u64(entry.get("ProgressionTowardsNextLevel")),
                total_xp: as_u64(
                    entry
                        .get("ContractProgression")
                        .and_then(|progress| progress.get("TotalProgressionEarned")),
                ),
            })
        })
        .collect()
}

pub fn parse_premium_contract_ids(entitlements: &Value) -> Vec<String> {
    let mut ids = entitlements
        .get("Entitlements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = as_str(entry.get("ItemID"));
            if id.is_empty() {
                None
            } else {
                Some(id)
            }
        })
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids
}

#[tauri::command]
pub async fn battlepass_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    let result = api::with_api(&riot, |api| async move {
        let puuid = api.puuid.clone();
        let contracts = api.get_contracts(&puuid).await?;
        let entitlements = api.get_entitlements(&puuid, CONTRACT_ITEM_TYPE).await.ok();
        Ok((puuid, contracts, entitlements))
    })
    .await;

    Ok(match result {
        Ok((puuid, contracts, entitlements)) => json!({
            "success": true,
            "puuid": puuid,
            "contracts": parse_contract_progress(&contracts),
            "premiumContractIds": entitlements
                .as_ref()
                .map(parse_premium_contract_ids)
                .unwrap_or_default(),
        })
        .to_string(),
        Err(error) if error.contains("lockfile") => {
            json!({ "success": false, "code": "loginRequired" }).to_string()
        }
        Err(error) => json!({ "success": false, "error": error }).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_level_and_xp_from_each_contract() {
        let contracts = json!({
            "Contracts": [
                {
                    "ContractDefinitionID": "bp-current",
                    "ProgressionLevelReached": 23,
                    "ProgressionTowardsNextLevel": 1400,
                    "ContractProgression": { "TotalProgressionEarned": 81234 }
                },
                {
                    "ContractDefinitionID": "",
                    "ProgressionLevelReached": 1
                },
                {
                    "ContractDefinitionID": "agent-gear",
                    "ProgressionLevelReached": 4,
                    "ProgressionTowardsNextLevel": 200
                }
            ]
        });
        let parsed = parse_contract_progress(&contracts);
        assert_eq!(
            parsed,
            vec![
                ContractProgress {
                    id: "bp-current".into(),
                    level: 23,
                    xp_toward_next: 1400,
                    total_xp: 81234,
                },
                ContractProgress {
                    id: "agent-gear".into(),
                    level: 4,
                    xp_toward_next: 200,
                    total_xp: 0,
                }
            ]
        );
    }

    #[test]
    fn collects_unique_premium_contract_ids() {
        let entitlements = json!({
            "Entitlements": [
                { "ItemID": "bp-current" },
                { "ItemID": "bp-old" },
                { "ItemID": "bp-current" },
                { "ItemID": "" }
            ]
        });
        assert_eq!(
            parse_premium_contract_ids(&entitlements),
            vec!["bp-current", "bp-old"]
        );
        assert!(parse_premium_contract_ids(&json!({})).is_empty());
    }
}
