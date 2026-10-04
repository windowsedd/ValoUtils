use crate::ai::{self, AiRequest};
use serde_json::{json, Value};
fn failure(error: ai::AiError) -> Value {
    json!({"success":false,"error":error.to_string(),"code":error.code()})
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
    match ai::complete(AiRequest {
        system: &system,
        prompt: context,
        max_tokens: 900,
        timeout: ai::REQUEST_TIMEOUT,
    })
    .await
    {
        Ok(text) => json!({"success":true,"text":text}),
        Err(error) => failure(error),
    }
}
