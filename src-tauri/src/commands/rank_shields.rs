use serde_json::Value;

const RANK_SHIELD_TIERS: [i64; 8] = [3, 6, 9, 12, 15, 18, 21, 24];

pub(crate) fn is_rank_shield_tier(tier: i64) -> bool {
    RANK_SHIELD_TIERS.contains(&tier)
}

fn integer(row: &Value, key: &str) -> Option<i64> {
    row.get(key)
        .and_then(|value| value.as_i64().or_else(|| value.as_u64().map(|n| n as i64)))
}

pub(crate) fn remaining_rank_shields(
    current_tier: i64,
    current_season_id: Option<&str>,
    updates: &Value,
) -> Option<u8> {
    if !is_rank_shield_tier(current_tier) {
        return None;
    }

    let current_season_id = current_season_id.filter(|id| !id.is_empty())?;
    let rows = updates.get("Matches")?.as_array()?;
    let mut consumed = 0u8;

    for row in rows {
        if row.get("SeasonID").and_then(Value::as_str) != Some(current_season_id) {
            continue;
        }

        let Some(tier_before) = integer(row, "TierBeforeUpdate") else {
            continue;
        };
        let Some(tier_after) = integer(row, "TierAfterUpdate") else {
            continue;
        };

        if tier_after != current_tier {
            continue;
        }
        if tier_before != current_tier {
            return Some(2u8.saturating_sub(consumed.min(2)));
        }
        if integer(row, "RankedRatingBeforeUpdate") == Some(0)
            && integer(row, "RankedRatingAfterUpdate") == Some(0)
            && integer(row, "RankedRatingEarned").is_some_and(|rr| rr < 0)
        {
            consumed = consumed.saturating_add(1).min(2);
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn updates(matches: Value) -> Value {
        json!({ "Matches": matches })
    }

    #[test]
    fn starts_with_two_shields_after_entering_division_one() {
        let history = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 11, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 80, "RankedRatingAfterUpdate": 10,
              "RankedRatingEarned": 30 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &history), Some(2));
    }

    #[test]
    fn consumes_shields_only_on_losses_that_begin_at_zero_rr() {
        let one_left = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 },
            { "SeasonID": "act", "TierBeforeUpdate": 11, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 90, "RankedRatingAfterUpdate": 10,
              "RankedRatingEarned": 20 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &one_left), Some(1));

        let zero_left = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -16 },
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 },
            { "SeasonID": "act", "TierBeforeUpdate": 11, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 90, "RankedRatingAfterUpdate": 10,
              "RankedRatingEarned": 20 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &zero_left), Some(0));
    }

    #[test]
    fn uses_the_latest_reentry_and_ignores_other_seasons_and_malformed_rows() {
        let history = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 13, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 70,
              "RankedRatingEarned": -20 },
            { "SeasonID": "act", "TierAfterUpdate": 12 },
            { "SeasonID": "old", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 }
        ]));
        assert_eq!(remaining_rank_shields(12, Some("act"), &history), Some(2));
    }

    #[test]
    fn returns_none_when_ineligible_or_the_entry_boundary_is_missing() {
        let history = updates(json!([
            { "SeasonID": "act", "TierBeforeUpdate": 12, "TierAfterUpdate": 12,
              "RankedRatingBeforeUpdate": 0, "RankedRatingAfterUpdate": 0,
              "RankedRatingEarned": -18 }
        ]));
        assert_eq!(remaining_rank_shields(13, Some("act"), &history), None);
        assert_eq!(remaining_rank_shields(12, Some("act"), &history), None);
        assert_eq!(remaining_rank_shields(12, None, &history), None);
    }
}
