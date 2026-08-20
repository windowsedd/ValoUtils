//! Owned cosmetics for the Inventory tab.
//!
//! Same trio the in-game API client uses: entitlements, wallet, loadout.
//! Riot removed `GET /store/v1/offers/`, so list prices come from content-tier
//! tables on the frontend instead of that catalog.

use crate::commands::store::{parse_price, Currency, Price};
use crate::riot::api;
use crate::riot::client::RiotState;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

const ITEM_SKINS: &str = "e7c63390-eda7-46e0-bb7a-a6abdacd2433";
const ITEM_SPRAYS: &str = "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475";
const ITEM_SPRAY_LEVELS: &str = "290f8769-97c6-492a-a1a8-caacf3d5b325";
const ITEM_BUDDIES: &str = "dd3bf334-87f3-40bd-b043-682a57a8dc3a";
const ITEM_CARDS: &str = "3f296c07-64c3-494c-923b-fe692a4fa1bd";
const ITEM_TITLES: &str = "de7caa6b-adf7-4588-bbd1-143831e786c6";
const ITEM_FLEX: &str = "03a572de-4234-31ed-d344-ababa488f981";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Skins,
    Sprays,
    Buddies,
    Cards,
    Titles,
    Flex,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    pub item_id: String,
    pub item_type_id: String,
    pub kind: ItemKind,
    pub price: Option<Price>,
}

fn as_str(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Item ids from either the per-type `{ Entitlements }` shape or the bulk
/// `{ EntitlementsByTypes }` envelope.
pub fn parse_owned_ids(body: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(entries) = body.get("Entitlements").and_then(Value::as_array) {
        for entry in entries {
            let id = as_str(entry.get("ItemID"));
            if !id.is_empty() {
                ids.push(id);
            }
        }
    }
    if let Some(groups) = body.get("EntitlementsByTypes").and_then(Value::as_array) {
        for group in groups {
            ids.extend(parse_owned_ids(group));
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn push_id(ids: &mut Vec<String>, value: Option<&Value>) {
    let id = as_str(value);
    if !id.is_empty() {
        ids.push(id);
    }
}

/// Flex slots live on the player loadout (`Expressions`), not only on the
/// totem entitlements type — that type 404s or comes back empty on some shards.
pub fn parse_loadout_flex_ids(loadout: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    let expressions = loadout
        .get("Expressions")
        .or_else(|| loadout.get("expressions"));
    let containers = [
        expressions.and_then(|value| value.get("FlexSelections")),
        expressions.and_then(|value| value.get("flexSelections")),
        expressions.and_then(|value| value.get("FlexLoadouts")),
        expressions.and_then(|value| value.get("TotemSelections")),
        loadout.get("Flex"),
        loadout.get("FlexLoadout"),
        loadout.get("Totems"),
    ];
    for container in containers.into_iter().flatten() {
        if let Some(entries) = container.as_array() {
            for entry in entries {
                push_id(&mut ids, entry.get("FlexID"));
                push_id(&mut ids, entry.get("ItemID"));
                push_id(&mut ids, entry.get("TotemID"));
                push_id(&mut ids, entry.get("ExpressionID"));
                if entry.is_string() {
                    push_id(&mut ids, Some(entry));
                }
            }
        } else {
            push_id(&mut ids, container.get("FlexID"));
            push_id(&mut ids, container.get("ItemID"));
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

/// Cheapest non-zero catalog price per reward item id.
pub fn parse_offer_prices(body: &Value) -> HashMap<String, Price> {
    let mut prices = HashMap::new();
    let Some(offers) = body.get("Offers").and_then(Value::as_array) else {
        return prices;
    };
    for offer in offers {
        let price = parse_price(offer.get("Cost"));
        if price.amount == 0 || price.currency == Currency::Unknown {
            continue;
        }
        let Some(rewards) = offer.get("Rewards").and_then(Value::as_array) else {
            continue;
        };
        for reward in rewards {
            let id = as_str(reward.get("ItemID"));
            if id.is_empty() {
                continue;
            }
            let key = id.to_ascii_lowercase();
            match prices.get(&key) {
                Some(existing) if existing.amount <= price.amount => {}
                _ => {
                    prices.insert(key, price.clone());
                }
            }
        }
    }
    prices
}

pub fn build_inventory(
    owned_by_type: &[(&str, ItemKind, &Value)],
    offers: &Value,
) -> Vec<InventoryItem> {
    let prices = parse_offer_prices(offers);
    let mut items = Vec::new();
    for (type_id, kind, body) in owned_by_type {
        for item_id in parse_owned_ids(body) {
            let price = prices.get(&item_id.to_ascii_lowercase()).cloned();
            items.push(InventoryItem {
                item_id,
                item_type_id: (*type_id).to_string(),
                kind: *kind,
                price,
            });
        }
    }
    items
}

#[tauri::command]
pub async fn inventory_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    let result = api::with_api(&riot, |api| async move {
        let puuid = api.puuid.clone();
        let (skins, sprays, spray_levels, buddies, cards, titles, flex, _wallet, loadout) =
            tokio::join!(
                api.get_entitlements(&puuid, ITEM_SKINS),
                api.get_entitlements(&puuid, ITEM_SPRAYS),
                api.get_entitlements(&puuid, ITEM_SPRAY_LEVELS),
                api.get_entitlements(&puuid, ITEM_BUDDIES),
                api.get_entitlements(&puuid, ITEM_CARDS),
                api.get_entitlements(&puuid, ITEM_TITLES),
                api.get_entitlements(&puuid, ITEM_FLEX),
                api.get_wallet(&puuid),
                api.get_player_loadout(&puuid),
            );
        let skins = skins.unwrap_or_else(|_| json!({}));
        let sprays = sprays.unwrap_or_else(|_| json!({}));
        let spray_levels = spray_levels.unwrap_or_else(|_| json!({}));
        let buddies = buddies.unwrap_or_else(|_| json!({}));
        let cards = cards.unwrap_or_else(|_| json!({}));
        let titles = titles.unwrap_or_else(|_| json!({}));
        let flex = flex.unwrap_or_else(|_| json!({}));
        let loadout = loadout.unwrap_or_else(|_| json!({}));
        let mut items = build_inventory(
            &[
                (ITEM_SKINS, ItemKind::Skins, &skins),
                (ITEM_SPRAYS, ItemKind::Sprays, &sprays),
                (ITEM_SPRAY_LEVELS, ItemKind::Sprays, &spray_levels),
                (ITEM_BUDDIES, ItemKind::Buddies, &buddies),
                (ITEM_CARDS, ItemKind::Cards, &cards),
                (ITEM_TITLES, ItemKind::Titles, &titles),
                (ITEM_FLEX, ItemKind::Flex, &flex),
            ],
            &json!({}),
        );
        for item_id in parse_loadout_flex_ids(&loadout) {
            let exists = items
                .iter()
                .any(|item| item.item_id.eq_ignore_ascii_case(&item_id));
            if exists {
                continue;
            }
            items.push(InventoryItem {
                item_id,
                item_type_id: ITEM_FLEX.to_string(),
                kind: ItemKind::Flex,
                price: None,
            });
        }
        Ok(items)
    })
    .await;

    Ok(match result {
        Ok(items) => match serde_json::to_value(&items) {
            Ok(items) => json!({ "success": true, "items": items }).to_string(),
            Err(error) => json!({ "success": false, "error": error.to_string() }).to_string(),
        },
        Err(error) if error.contains("lockfile") => {
            json!({ "success": false, "code": "loginRequired" }).to_string()
        }
        Err(error) => json!({ "success": false, "error": error }).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entitlements(ids: &[&str]) -> Value {
        json!({
            "Entitlements": ids.iter().map(|id| json!({ "ItemID": id })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn loadout_expressions_carry_equipped_flex_ids() {
        let loadout = json!({
            "Expressions": {
                "FlexSelections": [
                    { "FlexID": "1ff7899e-4c5b-1e49-e2d3-479a6b61c1a0", "SlotID": "a" },
                    { "ItemID": "fc33f376-4a58-687c-6961-bd8a7e529346" }
                ]
            }
        });
        assert_eq!(
            parse_loadout_flex_ids(&loadout),
            [
                "1ff7899e-4c5b-1e49-e2d3-479a6b61c1a0",
                "fc33f376-4a58-687c-6961-bd8a7e529346"
            ]
        );
    }

    #[test]
    fn owned_ids_come_from_either_envelope() {
        assert_eq!(parse_owned_ids(&entitlements(&["a", "b", "a"])), ["a", "b"]);
        let bulk = json!({
            "EntitlementsByTypes": [
                { "ItemTypeID": ITEM_SPRAYS, "Entitlements": [{ "ItemID": "spray-1" }] },
                { "ItemTypeID": ITEM_CARDS, "Entitlements": [{ "ItemID": "card-1" }, { "ItemID": "spray-1" }] }
            ]
        });
        assert_eq!(parse_owned_ids(&bulk), ["card-1", "spray-1"]);
        assert!(parse_owned_ids(&json!({})).is_empty());
    }

    #[test]
    fn offer_prices_keep_the_cheapest_recognised_cost() {
        let offers = json!({
            "Offers": [
                {
                    "Cost": { "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": 1775 },
                    "Rewards": [{ "ItemID": "Skin-1" }]
                },
                {
                    "Cost": { "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": 875 },
                    "Rewards": [{ "ItemID": "skin-1" }]
                },
                {
                    "Cost": { "85ca954a-41f2-ce94-9b45-8ca3dd39a00d": 4250 },
                    "Rewards": [{ "ItemID": "spray-1" }]
                },
                {
                    "Cost": { "not-a-currency": 9 },
                    "Rewards": [{ "ItemID": "ignored" }]
                }
            ]
        });
        let prices = parse_offer_prices(&offers);
        assert_eq!(prices.get("skin-1").unwrap().amount, 875);
        assert_eq!(
            prices.get("skin-1").unwrap().currency,
            Currency::ValorantPoints
        );
        assert_eq!(prices.get("spray-1").unwrap().amount, 4250);
        assert_eq!(
            prices.get("spray-1").unwrap().currency,
            Currency::KingdomCredits
        );
        assert!(!prices.contains_key("ignored"));
    }

    #[test]
    fn inventory_joins_owned_items_to_catalog_prices() {
        let items = build_inventory(
            &[
                (
                    ITEM_SKINS,
                    ItemKind::Skins,
                    &entitlements(&["skin-1", "free-skin"]),
                ),
                (ITEM_SPRAYS, ItemKind::Sprays, &entitlements(&["spray-1"])),
            ],
            &json!({
                "Offers": [{
                    "Cost": { "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741": 1775 },
                    "Rewards": [{ "ItemID": "skin-1" }]
                }]
            }),
        );
        assert_eq!(items.len(), 3);
        let skin = items.iter().find(|item| item.item_id == "skin-1").unwrap();
        assert_eq!(skin.kind, ItemKind::Skins);
        assert_eq!(skin.price.as_ref().unwrap().amount, 1775);
        let free = items
            .iter()
            .find(|item| item.item_id == "free-skin")
            .unwrap();
        assert!(free.price.is_none(), "an item with no offer stays unpriced");
        let spray = items.iter().find(|item| item.item_id == "spray-1").unwrap();
        assert_eq!(spray.kind, ItemKind::Sprays);
        assert!(spray.price.is_none());
    }

    #[test]
    fn missing_offers_still_return_owned_items() {
        // Riot removed GET /store/v1/offers/; the frontend then uses rarity list prices.
        let items = build_inventory(
            &[(ITEM_SKINS, ItemKind::Skins, &entitlements(&["skin-1"]))],
            &json!({}),
        );
        assert_eq!(items.len(), 1);
        assert!(items[0].price.is_none());
    }
}
