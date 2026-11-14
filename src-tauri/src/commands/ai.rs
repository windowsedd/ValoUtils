use crate::ai::{self, AiRequest};
use serde_json::{json, Value};
fn failure(error: ai::AiError) -> Value {
    json!({"success":false,"error":error.to_string(),"code":error.code()})
}
/// The first JSON object in a model reply (models sometimes add fences or prose).
fn json_object(text: &str) -> Option<Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| serde_json::from_str(&text[start..=end]).ok()).flatten()
}

/// Generates a crosshair from a description with the configured AI provider
/// (`args: [description]`): `{ success, code, name, settings }`. The model
/// only describes settings; the code is built and clamped by ValoUtils.
#[tauri::command]
pub async fn ai_crosshair_generate(args: Vec<Value>) -> Value {
    let Some(description) = args
        .first()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= 500)
    else {
        return json!({"success":false,"error":"Describe the crosshair (up to 500 characters).","code":"invalidInput"});
    };
    let prompt = ai::prompts::crosshair_request(description);
    match ai::complete(AiRequest {
        system: ai::prompts::CROSSHAIR_DESIGNER,
        prompt: &prompt,
        max_tokens: 500,
        timeout: ai::REQUEST_TIMEOUT,
    })
    .await
    {
        Ok(text) => match json_object(&text) {
            Some(spec) => {
                let (code, settings) = crate::crosshair_code::code_from_spec(&spec);
                let name = spec
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.chars().take(24).collect::<String>());
                json!({"success": true, "code": code, "name": name, "settings": settings})
            }
            None => json!({"success":false,"error":"The AI reply wasn't crosshair settings. Try rewording.","code":"emptyResponse"}),
        },
        Err(error) => failure(error),
    }
}

#[tauri::command]
pub async fn ai_models(provider: Value, settings: Value) -> Value {
    let id = provider.as_str().unwrap_or("none");
    let mut providers = serde_json::Map::new();
    providers.insert(id.to_string(), settings);
    let cfg = ai::AiConfig::parse(&provider, &Value::Object(providers));
    match ai::list_models(&cfg).await {
        Ok(models) => json!({"success":true,"models":models}),
        Err(error) => failure(error),
    }
}
#[tauri::command]
pub async fn ai_test() -> Value {
    let cfg = ai::config();
    match ai::complete_with_config(
        &cfg,
        AiRequest {
            system: "Reply with OK",
            prompt: "Reply with OK",
            max_tokens: 16,
            timeout: ai::REQUEST_TIMEOUT,
        },
    )
    .await
    {
        Ok(text) => {
            json!({"success":true,"provider":cfg.provider.map(|p| p.id()),"model":cfg.model,"text":text})
        }
        Err(error) => failure(error),
    }
}
#[tauri::command]
pub async fn ai_match_analyze(args: Vec<Value>) -> Value {
    let Some(context) = args
        .first()
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 20_000)
    else {
        return json!({"success":false,"error":"Invalid match context (maximum 20,000 characters).","code":"invalidInput"});
    };
    let language = match args.get(1).and_then(Value::as_str) {
        Some("Korean") => "Korean",
        Some("Traditional Chinese") => "Traditional Chinese",
        _ => "English",
    };
    let system = ai::prompts::MATCH_COACH.replace("{language}", language);
    let prompt = ai::prompts::match_request(context);
    match ai::complete(AiRequest {
        system: &system,
        prompt: &prompt,
        max_tokens: 900,
        timeout: ai::REQUEST_TIMEOUT,
    })
    .await
    {
        Ok(text) => json!({"success":true,"text":text}),
        Err(error) => failure(error),
    }
}

#[cfg(test)]
mod crosshair_tests {
    use super::*;

    #[test]
    fn finds_the_json_object_inside_a_fenced_reply() {
        let reply = "Sure!\n```json\n{ \"color\": \"cyan\", \"centerDot\": true }\n```";
        assert_eq!(json_object(reply).unwrap()["color"], "cyan");
        assert!(json_object("no json here").is_none());
    }
}
