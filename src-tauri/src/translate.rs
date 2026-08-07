use serde_json::Value;

/// Mirrors electron/util/translate.ts, minus the unofficial
/// `google-translate-api` npm path — standardized on the raw Google web
/// endpoint it already used as its fallback (per migration decision).
pub async fn translate_text(text: &str, provider: &str, target_language: &str, deepl_api_key: &str) -> Result<String, String> {
    let target = if target_language.trim().is_empty() { "en" } else { target_language.trim() };
    if text.trim().is_empty() {
        return Ok(String::new());
    }

    if provider == "deepl" {
        if deepl_api_key.trim().is_empty() {
            return Err("DeepL API key is required.".into());
        }
        let endpoint = if deepl_api_key.ends_with(":fx") { "https://api-free.deepl.com/v2/translate" } else { "https://api.deepl.com/v2/translate" };
        let params = [("text", text), ("target_lang", &target.to_uppercase())];
        let client = reqwest::Client::new();
        let response = client
            .post(endpoint)
            .header("Authorization", format!("DeepL-Auth-Key {deepl_api_key}"))
            .form(&params)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        return Ok(body.pointer("/translations/0/text").and_then(|v| v.as_str()).unwrap_or_default().to_string());
    }

    translate_with_google_web(text, target).await
}

async fn translate_with_google_web(text: &str, target_language: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[("client", "gtx"), ("sl", "auto"), ("tl", target_language), ("dt", "t"), ("q", text)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: Value = response.json().await.map_err(|e| e.to_string())?;
    let translated: String = body
        .get(0)
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|part| part.get(0).and_then(|v| v.as_str()))
        .collect();
    if translated.is_empty() {
        return Err("Google translation returned no text.".into());
    }
    Ok(translated)
}
