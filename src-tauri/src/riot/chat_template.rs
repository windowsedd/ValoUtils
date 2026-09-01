use serde::Deserialize;
use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateVariable {
    id: String,
    data_level: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct TemplatePlan {
    pub variables: BTreeSet<String>,
    pub needs_roster: bool,
    pub needs_recent: bool,
    pub needs_content: bool,
}

impl TemplatePlan {
    pub fn merge(&mut self, other: &Self) {
        self.variables.extend(other.variables.iter().cloned());
        self.needs_roster |= other.needs_roster;
        self.needs_recent |= other.needs_recent;
        self.needs_content |= other.needs_content;
    }
}

fn catalog() -> &'static [TemplateVariable] {
    static CATALOG: OnceLock<Vec<TemplateVariable>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../src/shared/bot-template-variables.json"
        ))
        .expect("bot template variable catalog must be valid JSON")
    })
}

fn definition(id: &str) -> Option<&'static TemplateVariable> {
    catalog().iter().find(|item| item.id == id)
}

pub fn plan_template(message: &str) -> TemplatePlan {
    let mut plan = TemplatePlan::default();
    let mut cursor = 0;
    while let Some(open_offset) = message[cursor..].find("{{") {
        let open = cursor + open_offset;
        let value_start = open + 2;
        let Some(close_offset) = message[value_start..].find("}}") else {
            break;
        };
        let close = value_start + close_offset;
        let id = &message[value_start..close];
        if let Some(item) = definition(id) {
            plan.variables.insert(id.to_string());
            plan.needs_roster = true;
            match item.data_level.as_str() {
                "recent" => plan.needs_recent = true,
                "content" => plan.needs_content = true,
                _ => {}
            }
        }
        cursor = close + 2;
    }
    plan
}

pub fn render_template(message: &str, values: &HashMap<String, String>) -> String {
    let mut output = String::with_capacity(message.len());
    let mut cursor = 0;
    while let Some(open_offset) = message[cursor..].find("{{") {
        let open = cursor + open_offset;
        output.push_str(&message[cursor..open]);
        let value_start = open + 2;
        let Some(close_offset) = message[value_start..].find("}}") else {
            output.push_str(&message[open..]);
            return output;
        };
        let close = value_start + close_offset;
        let id = &message[value_start..close];
        if definition(id).is_some() {
            output.push_str(values.get(id).map(String::as_str).unwrap_or("N/A"));
        } else {
            output.push_str(&message[open..close + 2]);
        }
        cursor = close + 2;
    }
    output.push_str(&message[cursor..]);
    output
}

pub fn format_decimal(value: f64, places: usize) -> String {
    let formatted = format!("{value:.places$}");
    formatted
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

pub fn format_percent(value: f64) -> String {
    format!("{}%", value.round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn catalog_contains_all_approved_variables() {
        let ids: Vec<_> = catalog().iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids.len(), 34);
        assert!(ids.contains(&"enemy_team_kda"));
        assert!(ids.contains(&"roster_count"));
        assert!(ids.contains(&"server"));
    }

    #[test]
    fn planning_deduplicates_known_variables_and_ignores_unknown_ones() {
        let plan = plan_template("{{map}} {{enemy_team_kd}} {{map}} {{future_value}}");
        assert_eq!(
            plan.variables,
            ["enemy_team_kd", "map"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
        assert!(plan.needs_roster);
        assert!(plan.needs_recent);
        assert!(plan.needs_content);
    }

    #[test]
    fn rendering_replaces_known_missing_values_and_preserves_unknown_syntax() {
        let values = HashMap::from([("map".to_string(), "Ascent".to_string())]);
        assert_eq!(
            render_template("{{map}} {{my_rank}} {{future_value}} {{broken", &values),
            "Ascent N/A {{future_value}} {{broken"
        );
    }

    #[test]
    fn rendering_replaces_repeated_variables_from_one_value() {
        let values = HashMap::from([("my_rank".to_string(), "Diamond 1".to_string())]);
        assert_eq!(
            render_template("{{my_rank}} vs {{my_rank}}", &values),
            "Diamond 1 vs Diamond 1"
        );
    }

    #[test]
    fn merging_template_plans_unions_all_data_requirements() {
        let mut merged = plan_template("{{map}}");
        merged.merge(&plan_template("{{enemy_team_kda}} {{roster_count}}"));

        assert_eq!(
            merged.variables,
            ["enemy_team_kda", "map", "roster_count"]
                .into_iter()
                .map(str::to_string)
                .collect()
        );
        assert!(merged.needs_roster);
        assert!(merged.needs_recent);
        assert!(merged.needs_content);
    }

    #[test]
    fn numeric_formatting_is_chat_compact() {
        assert_eq!(format_decimal(1.20, 2), "1.2");
        assert_eq!(format_decimal(16.0, 1), "16");
        assert_eq!(format_percent(53.6), "54%");
    }
}
