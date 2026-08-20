//! The player's storefront, flattened for the Store page.
//!
//! Riot's `/store/*/storefront` document is four unrelated shops in one
//! envelope, each with its own nesting and its own idea of where a price
//! lives. Everything here turns that into four flat lists the frontend can
//! render without reaching back into Riot's shape.
//!
//! Prices are a map keyed by a currency UUID rather than a number, so every
//! offer resolves to an amount plus a [`Currency`] tag. An unrecognised
//! currency is reported as [`Currency::Unknown`] rather than dropped - a new
//! currency should render as a number with no symbol, not make the offer
//! vanish.

use crate::riot::api;
use crate::riot::client::RiotState;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

// Currency UUIDs. These are stable ids baked into the game's item catalogue.
const CURRENCY_VP: &str = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
const CURRENCY_RADIANITE: &str = "e59aa87c-4cbf-517a-5983-6e81511be9b7";
const CURRENCY_KINGDOM: &str = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Currency {
    ValorantPoints,
    Radianite,
    KingdomCredits,
    Unknown,
}

impl Currency {
    fn from_uuid(uuid: &str) -> Self {
        match uuid.to_ascii_lowercase().as_str() {
            CURRENCY_VP => Currency::ValorantPoints,
            CURRENCY_RADIANITE => Currency::Radianite,
            CURRENCY_KINGDOM => Currency::KingdomCredits,
            _ => Currency::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wallet {
    pub valorant_points: u64,
    pub radianite: u64,
    pub kingdom_credits: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub amount: u64,
    pub currency: Currency,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyOffer {
    pub offer_id: String,
    /// Skin *level* uuid — a different id space from a skin uuid, so the
    /// frontend resolves it through `/weapons/skinlevels/`.
    pub item_id: String,
    pub price: Price,
}

// No `Eq`: `discount_percent` is a float, which Riot sends fractional.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleItem {
    pub item_id: String,
    pub item_type_id: String,
    pub amount: u64,
    pub base_price: u64,
    pub discounted_price: u64,
    pub discount_percent: f64,
    pub is_promo: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturedBundle {
    pub bundle_id: String,
    /// The uuid the art is keyed by (`/bundles/{id}`), which is not the
    /// bundle's own id.
    pub data_asset_id: String,
    pub remaining_seconds: u64,
    pub items: Vec<BundleItem>,
    pub total_base: u64,
    pub total_discounted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NightMarketOffer {
    pub offer_id: String,
    pub item_id: String,
    pub base_price: u64,
    pub discounted_price: u64,
    pub discount_percent: u64,
    /// Whether the card has been flipped in-game. A card the player has not
    /// turned over yet should stay face-down here too.
    pub is_seen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessoryOffer {
    pub offer_id: String,
    pub item_id: String,
    /// Sprays, cards, buddies and titles share this shop, so the frontend
    /// needs the type to know which asset endpoint to ask.
    pub item_type_id: String,
    pub amount: u64,
    pub price: Price,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStore {
    pub remaining_seconds: u64,
    pub offers: Vec<DailyOffer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NightMarket {
    pub remaining_seconds: u64,
    pub offers: Vec<NightMarketOffer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessoryStore {
    pub remaining_seconds: u64,
    pub offers: Vec<AccessoryOffer>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storefront {
    pub wallet: Wallet,
    pub daily: DailyStore,
    /// Absent between bundle rotations rather than empty, so the frontend can
    /// omit the section instead of drawing an empty one.
    pub featured_bundle: Option<FeaturedBundle>,
    /// Absent except during a Night Market window, which is most of the time.
    pub night_market: Option<NightMarket>,
    pub accessory: Option<AccessoryStore>,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn as_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn as_str(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Pulls the single entry out of a `{ "<currency-uuid>": amount }` map.
///
/// Riot models cost as a one-entry map keyed by currency. A missing or empty
/// map is a free item, not a parse failure.
pub(crate) fn parse_price(cost: Option<&Value>) -> Price {
    let Some(map) = cost.and_then(Value::as_object) else {
        return Price {
            amount: 0,
            currency: Currency::Unknown,
        };
    };
    // Prefer a currency we recognise: some offers list a token alongside the
    // real price, and picking the first key would be arbitrary.
    let entry = map
        .iter()
        .find(|(uuid, _)| Currency::from_uuid(uuid) != Currency::Unknown)
        .or_else(|| map.iter().next());
    match entry {
        Some((uuid, amount)) => Price {
            amount: amount.as_u64().unwrap_or(0),
            currency: Currency::from_uuid(uuid),
        },
        None => Price {
            amount: 0,
            currency: Currency::Unknown,
        },
    }
}

pub fn parse_wallet(wallet: &Value) -> Wallet {
    let balances = wallet.get("Balances");
    let read = |uuid: &str| as_u64(balances.and_then(|b| b.get(uuid)));
    Wallet {
        valorant_points: read(CURRENCY_VP),
        radianite: read(CURRENCY_RADIANITE),
        kingdom_credits: read(CURRENCY_KINGDOM),
    }
}

/// The first reward of an offer is the item being sold.
fn first_reward(offer: &Value) -> Option<&Value> {
    offer.get("Rewards")?.as_array()?.first()
}

pub fn parse_daily(storefront: &Value) -> DailyStore {
    let panel = storefront.get("SkinsPanelLayout");
    let offers = panel
        .and_then(|panel| panel.get("SingleItemStoreOffers"))
        .and_then(Value::as_array)
        .map(|offers| {
            offers
                .iter()
                .map(|offer| DailyOffer {
                    offer_id: as_str(offer.get("OfferID")),
                    item_id: first_reward(offer)
                        .map(|reward| as_str(reward.get("ItemID")))
                        .unwrap_or_default(),
                    price: parse_price(offer.get("Cost")),
                })
                .collect()
        })
        .unwrap_or_default();

    DailyStore {
        remaining_seconds: as_u64(
            panel.and_then(|panel| panel.get("SingleItemOffersRemainingDurationInSeconds")),
        ),
        offers,
    }
}

pub fn parse_featured_bundle(storefront: &Value) -> Option<FeaturedBundle> {
    let featured = storefront.get("FeaturedBundle")?;
    // `Bundles` is the current shape; `Bundle` is the older singular one.
    let bundle = featured
        .get("Bundles")
        .and_then(Value::as_array)
        .and_then(|bundles| bundles.first())
        .or_else(|| featured.get("Bundle"))?;

    let items = bundle
        .get("Items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|entry| {
                    let item = entry.get("Item");
                    BundleItem {
                        item_id: as_str(item.and_then(|item| item.get("ItemID"))),
                        item_type_id: as_str(item.and_then(|item| item.get("ItemTypeID"))),
                        amount: as_u64(item.and_then(|item| item.get("Amount"))),
                        base_price: as_u64(entry.get("BasePrice")),
                        discounted_price: as_u64(entry.get("DiscountedPrice")),
                        discount_percent: entry
                            .get("DiscountPercent")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0),
                        is_promo: entry
                            .get("IsPromoItem")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    Some(FeaturedBundle {
        bundle_id: as_str(bundle.get("ID")),
        data_asset_id: as_str(bundle.get("DataAssetID")),
        // The duration sits on the bundle in the current shape and on the
        // envelope in the old one.
        remaining_seconds: as_u64(
            bundle
                .get("DurationRemainingInSeconds")
                .or_else(|| featured.get("BundleRemainingDurationInSeconds")),
        ),
        total_base: parse_price(bundle.get("TotalBaseCost")).amount,
        total_discounted: parse_price(bundle.get("TotalDiscountedCost")).amount,
        items,
    })
}

pub fn parse_night_market(storefront: &Value) -> Option<NightMarket> {
    let bonus = storefront.get("BonusStore")?;
    let offers: Vec<NightMarketOffer> = bonus
        .get("BonusStoreOffers")
        .and_then(Value::as_array)?
        .iter()
        .map(|entry| {
            let offer = entry.get("Offer");
            NightMarketOffer {
                offer_id: as_str(offer.and_then(|offer| offer.get("OfferID"))),
                item_id: offer
                    .and_then(first_reward)
                    .map(|reward| as_str(reward.get("ItemID")))
                    .unwrap_or_default(),
                base_price: parse_price(offer.and_then(|offer| offer.get("Cost"))).amount,
                discounted_price: parse_price(entry.get("DiscountCosts")).amount,
                discount_percent: as_u64(entry.get("DiscountPercent")),
                is_seen: entry
                    .get("IsSeen")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        })
        .collect();

    // A present-but-empty BonusStore is a closed Night Market.
    if offers.is_empty() {
        return None;
    }
    Some(NightMarket {
        remaining_seconds: as_u64(bonus.get("BonusStoreRemainingDurationInSeconds")),
        offers,
    })
}

pub fn parse_accessory_store(storefront: &Value) -> Option<AccessoryStore> {
    let accessory = storefront.get("AccessoryStore")?;
    let offers: Vec<AccessoryOffer> = accessory
        .get("AccessoryStoreOffers")
        .and_then(Value::as_array)?
        .iter()
        .map(|entry| {
            let offer = entry.get("Offer");
            let reward = offer.and_then(first_reward);
            AccessoryOffer {
                offer_id: as_str(offer.and_then(|offer| offer.get("OfferID"))),
                item_id: reward
                    .map(|reward| as_str(reward.get("ItemID")))
                    .unwrap_or_default(),
                item_type_id: reward
                    .map(|reward| as_str(reward.get("ItemTypeID")))
                    .unwrap_or_default(),
                amount: reward
                    .map(|reward| as_u64(reward.get("Quantity")))
                    .unwrap_or(0),
                price: parse_price(offer.and_then(|offer| offer.get("Cost"))),
            }
        })
        .collect();

    if offers.is_empty() {
        return None;
    }
    Some(AccessoryStore {
        remaining_seconds: as_u64(accessory.get("AccessoryStoreRemainingDurationInSeconds")),
        offers,
    })
}

pub fn parse_storefront(storefront: &Value, wallet: &Value) -> Storefront {
    Storefront {
        wallet: parse_wallet(wallet),
        daily: parse_daily(storefront),
        featured_bundle: parse_featured_bundle(storefront),
        night_market: parse_night_market(storefront),
        accessory: parse_accessory_store(storefront),
    }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn store_get(riot: State<'_, RiotState>) -> Result<String, ()> {
    // `with_api` retries once with fresh tokens if the cached one has been
    // invalidated (expired, or the player switched accounts).
    let result = api::with_api(&riot, |api| async move {
        let puuid = api.puuid.clone();
        let (storefront, wallet) =
            tokio::try_join!(api.get_storefront(&puuid), api.get_wallet(&puuid))?;
        Ok((storefront, wallet))
    })
    .await;

    Ok(match result {
        Ok((storefront, wallet)) => {
            let parsed = parse_storefront(&storefront, &wallet);
            match serde_json::to_value(&parsed) {
                Ok(mut value) => {
                    if let Some(object) = value.as_object_mut() {
                        object.insert("success".into(), Value::Bool(true));
                    }
                    value.to_string()
                }
                Err(e) => json!({ "success": false, "error": e.to_string() }).to_string(),
            }
        }
        Err(e) if e.contains("lockfile") => {
            json!({ "success": false, "code": "loginRequired" }).to_string()
        }
        Err(e) => json!({ "success": false, "error": e }).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A storefront with every section populated, in the current (v3) shape.
    fn storefront() -> Value {
        json!({
            "SkinsPanelLayout": {
                "SingleItemOffers": ["skin-level-1", "skin-level-2"],
                "SingleItemStoreOffers": [
                    {
                        "OfferID": "offer-1",
                        "Cost": { CURRENCY_VP: 1775 },
                        "Rewards": [{ "ItemTypeID": "skin-type", "ItemID": "skin-level-1", "Quantity": 1 }]
                    },
                    {
                        "OfferID": "offer-2",
                        "Cost": { CURRENCY_VP: 875 },
                        "Rewards": [{ "ItemTypeID": "skin-type", "ItemID": "skin-level-2", "Quantity": 1 }]
                    }
                ],
                "SingleItemOffersRemainingDurationInSeconds": 43_200
            },
            "FeaturedBundle": {
                "Bundles": [{
                    "ID": "bundle-1",
                    "DataAssetID": "bundle-art-1",
                    "DurationRemainingInSeconds": 518_400,
                    "TotalBaseCost": { CURRENCY_VP: 7_100 },
                    "TotalDiscountedCost": { CURRENCY_VP: 5_330 },
                    "Items": [{
                        "Item": { "ItemTypeID": "skin-type", "ItemID": "bundle-skin-1", "Amount": 1 },
                        "BasePrice": 1775,
                        "DiscountedPrice": 1331,
                        "DiscountPercent": 25.0,
                        "IsPromoItem": false
                    }]
                }]
            },
            "BonusStore": {
                "BonusStoreOffers": [{
                    "BonusOfferID": "bonus-1",
                    "Offer": {
                        "OfferID": "night-1",
                        "Cost": { CURRENCY_VP: 1775 },
                        "Rewards": [{ "ItemTypeID": "skin-type", "ItemID": "night-skin-1", "Quantity": 1 }]
                    },
                    "DiscountPercent": 47,
                    "DiscountCosts": { CURRENCY_VP: 940 },
                    "IsSeen": false
                }],
                "BonusStoreRemainingDurationInSeconds": 216_000
            },
            "AccessoryStore": {
                "AccessoryStoreOffers": [{
                    "Offer": {
                        "OfferID": "acc-1",
                        "Cost": { CURRENCY_KINGDOM: 4000 },
                        "Rewards": [{ "ItemTypeID": "spray-type", "ItemID": "spray-1", "Quantity": 1 }]
                    },
                    "ContractID": "contract-1"
                }],
                "AccessoryStoreRemainingDurationInSeconds": 43_200
            }
        })
    }

    fn wallet() -> Value {
        json!({ "Balances": { CURRENCY_VP: 4215, CURRENCY_RADIANITE: 78, CURRENCY_KINGDOM: 1200 } })
    }

    #[test]
    fn reads_every_balance_and_defaults_the_missing_ones_to_zero() {
        assert_eq!(
            parse_wallet(&wallet()),
            Wallet {
                valorant_points: 4215,
                radianite: 78,
                kingdom_credits: 1200,
            }
        );
        assert_eq!(
            parse_wallet(&json!({})),
            Wallet {
                valorant_points: 0,
                radianite: 0,
                kingdom_credits: 0,
            }
        );
    }

    #[test]
    fn daily_offers_carry_their_skin_level_id_and_price() {
        let daily = parse_daily(&storefront());
        assert_eq!(daily.remaining_seconds, 43_200);
        assert_eq!(daily.offers.len(), 2);
        assert_eq!(daily.offers[0].offer_id, "offer-1");
        // The *reward* item id is what the art is keyed by — not the offer id.
        assert_eq!(daily.offers[0].item_id, "skin-level-1");
        assert_eq!(daily.offers[0].price.amount, 1775);
        assert_eq!(daily.offers[0].price.currency, Currency::ValorantPoints);
    }

    #[test]
    fn the_bundle_reports_art_id_and_both_totals() {
        let bundle = parse_featured_bundle(&storefront()).unwrap();
        assert_eq!(bundle.bundle_id, "bundle-1");
        // Art is keyed by DataAssetID, so confusing it with ID renders nothing.
        assert_eq!(bundle.data_asset_id, "bundle-art-1");
        assert_eq!(bundle.remaining_seconds, 518_400);
        assert_eq!(bundle.total_base, 7_100);
        assert_eq!(bundle.total_discounted, 5_330);
        assert_eq!(bundle.items.len(), 1);
        assert_eq!(bundle.items[0].item_id, "bundle-skin-1");
        assert_eq!(bundle.items[0].discounted_price, 1331);
    }

    #[test]
    fn the_older_singular_bundle_shape_still_parses() {
        let old = json!({
            "FeaturedBundle": {
                "Bundle": { "ID": "b", "DataAssetID": "art", "Items": [] },
                "BundleRemainingDurationInSeconds": 1234
            }
        });
        let bundle = parse_featured_bundle(&old).unwrap();
        assert_eq!(bundle.data_asset_id, "art");
        // Duration lives on the envelope in this shape, not on the bundle.
        assert_eq!(bundle.remaining_seconds, 1234);
    }

    #[test]
    fn night_market_keeps_both_prices_and_the_unflipped_state() {
        let market = parse_night_market(&storefront()).unwrap();
        assert_eq!(market.remaining_seconds, 216_000);
        assert_eq!(market.offers.len(), 1);
        assert_eq!(market.offers[0].base_price, 1775);
        assert_eq!(market.offers[0].discounted_price, 940);
        assert_eq!(market.offers[0].discount_percent, 47);
        assert!(!market.offers[0].is_seen, "an unflipped card stays hidden");
    }

    #[test]
    fn a_closed_night_market_is_absent_rather_than_empty() {
        // Riot leaves the key present with no offers outside a Night Market
        // window; the section must not render as an empty shelf.
        let closed = json!({ "BonusStore": { "BonusStoreOffers": [] } });
        assert!(parse_night_market(&closed).is_none());
        assert!(parse_night_market(&json!({})).is_none());
    }

    #[test]
    fn accessory_offers_keep_the_item_type_so_art_can_be_resolved() {
        let accessory = parse_accessory_store(&storefront()).unwrap();
        assert_eq!(accessory.offers.len(), 1);
        assert_eq!(accessory.offers[0].item_type_id, "spray-type");
        assert_eq!(accessory.offers[0].price.amount, 4000);
        assert_eq!(accessory.offers[0].price.currency, Currency::KingdomCredits);
    }

    #[test]
    fn an_unknown_currency_keeps_the_amount_instead_of_dropping_the_offer() {
        let price = parse_price(Some(&json!({ "not-a-known-currency": 42 })));
        assert_eq!(price.amount, 42);
        assert_eq!(price.currency, Currency::Unknown);
    }

    #[test]
    fn a_recognised_currency_wins_over_an_unknown_one_in_the_same_map() {
        let price = parse_price(Some(&json!({ "some-token": 1, CURRENCY_VP: 1775 })));
        assert_eq!(price.amount, 1775);
        assert_eq!(price.currency, Currency::ValorantPoints);
    }

    #[test]
    fn an_empty_storefront_parses_to_empty_sections_rather_than_failing() {
        let parsed = parse_storefront(&json!({}), &json!({}));
        assert!(parsed.daily.offers.is_empty());
        assert_eq!(parsed.daily.remaining_seconds, 0);
        assert!(parsed.featured_bundle.is_none());
        assert!(parsed.night_market.is_none());
        assert!(parsed.accessory.is_none());
    }

    #[test]
    fn the_serialized_payload_is_camel_case_for_the_frontend() {
        let parsed = parse_storefront(&storefront(), &wallet());
        let value = serde_json::to_value(&parsed).unwrap();
        assert_eq!(value["wallet"]["valorantPoints"], 4215);
        assert_eq!(value["daily"]["remainingSeconds"], 43_200);
        assert_eq!(value["featuredBundle"]["dataAssetId"], "bundle-art-1");
        assert_eq!(value["daily"]["offers"][0]["price"]["currency"], "valorantPoints");
    }
}
