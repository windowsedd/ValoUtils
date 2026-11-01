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
/// Kingdom Credits. A recruitment agent's Kingdom Credit offer opens when the
/// recruitment event ends.
const KINGDOM_CREDITS: &str = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";

/// The account's agent recruitment event progress, as Riot reports it at the
/// top of the contracts document (`ActiveRecruitmentEventProgress`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecruitmentProgress {
    pub agent_id: String,
    pub earned: u64,
    /// When the event ends (ISO 8601), from the agent store; `None` if unknown.
    pub ends_at: Option<String>,
}

pub fn parse_recruitment(contracts: &Value) -> Option<RecruitmentProgress> {
    let event = contracts.get("ActiveRecruitmentEventProgress")?;
    let agent_id = as_str(event.get("AgentID")).to_ascii_lowercase();
    if agent_id.is_empty() {
        return None;
    }
    Some(RecruitmentProgress {
        agent_id,
        earned: as_u64(event.get("ProgressionEarned")),
        ends_at: None,
    })
}

/// Start of the agent's Kingdom Credit offer, which is when recruitment ends.
pub fn recruitment_end(agent_store: &Value, agent_id: &str) -> Option<String> {
    agent_store
        .pointer("/AgentStore/AgentStoreOffers")?
        .as_array()?
        .iter()
        .find(|entry| as_str(entry.get("AgentID")).eq_ignore_ascii_case(agent_id))?
        .get("StoreOffers")?
        .as_array()?
        .iter()
        .find(|offer| {
            offer
                .get("Cost")
                .and_then(Value::as_object)
                .is_some_and(|cost| {
                    cost.keys()
                        .any(|id| id.eq_ignore_ascii_case(KINGDOM_CREDITS))
                })
        })
        .map(|offer| as_str(offer.get("StartDate")))
        .filter(|date| !date.is_empty())
}

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
        .and_then(|entry| {
            entry
                .as_u64()
                .or_else(|| entry.as_i64().map(|n| n.max(0) as u64))
        })
        .unwrap_or(0)
}

fn as_str(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
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
pub async fn battlepass_get(riot: State<'_, RiotState>) -> Result<Value, ()> {
    let result = api::with_api(&riot, |api| async move {
        let puuid = api.puuid.clone();
        let contracts = api.get_contracts(&puuid).await?;
        let entitlements = api.get_entitlements(&puuid, CONTRACT_ITEM_TYPE).await.ok();
        // Only during a recruitment event, and optional: the card still shows
        // progress without an end date.
        let mut recruitment = parse_recruitment(&contracts);
        if let Some(event) = recruitment.as_mut() {
            if let Ok(store) = api.get_agent_storefront().await {
                event.ends_at = recruitment_end(&store, &event.agent_id);
            }
        }
        Ok((puuid, contracts, entitlements, recruitment))
    })
    .await;

    Ok(match result {
        Ok((puuid, contracts, entitlements, recruitment)) => json!({
            "recruitment": recruitment,
            "success": true,
            "puuid": puuid,
            "contracts": parse_contract_progress(&contracts),
            "premiumContractIds": entitlements
                .as_ref()
                .map(parse_premium_contract_ids)
                .unwrap_or_default(),
        }),
        Err(error) if error.is_login_required() => {
            json!({ "success": false, "code": "loginRequired" })
        }
        Err(error) => match super::rate_limited_reply(&error.to_string()).await {
            Some(reply) => reply,
            None => json!({ "success": false, "code": error.code(), "error": error }),
        },
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
    fn reads_active_recruitment_progress() {
        let contracts = json!({
            "ActiveRecruitmentEventProgress": {
                "AgentID": "DDD5A15C-4FBE-42FA-3789-11A55CA5EE04",
                "CounterID": "ddd5a15c-4fbe-42fa-3789-11a55ca5ee04",
                "ProgressionEarned": 172300,
                "Version": 21
            },
            "Contracts": []
        });
        assert_eq!(
            parse_recruitment(&contracts),
            Some(RecruitmentProgress {
                agent_id: "ddd5a15c-4fbe-42fa-3789-11a55ca5ee04".into(),
                earned: 172300,
                ends_at: None,
            })
        );
        assert_eq!(parse_recruitment(&json!({ "Contracts": [] })), None);
        assert_eq!(
            parse_recruitment(&json!({ "ActiveRecruitmentEventProgress": { "AgentID": "" } })),
            None
        );
    }

    #[test]
    fn recruitment_ends_when_the_kingdom_credit_offer_opens() {
        let store = json!({ "AgentStore": { "AgentStoreOffers": [
            { "AgentID": "other", "StoreOffers": [
                { "Cost": { KINGDOM_CREDITS: 8000 }, "StartDate": "2020-06-02T00:00:00Z" }
            ]},
            { "AgentID": "DDD5A15C", "StoreOffers": [
                { "Cost": { "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": 1000 }, "StartDate": "2026-10-27T21:00:00Z" },
                { "Cost": { KINGDOM_CREDITS: 8000 }, "StartDate": "2026-11-25T22:00:00Z" }
            ]}
        ]}});
        assert_eq!(
            recruitment_end(&store, "ddd5a15c").as_deref(),
            Some("2026-11-25T22:00:00Z")
        );
        assert_eq!(recruitment_end(&store, "missing"), None);
        assert_eq!(recruitment_end(&json!({}), "ddd5a15c"), None);
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
