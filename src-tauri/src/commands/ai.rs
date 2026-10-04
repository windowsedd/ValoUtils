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
