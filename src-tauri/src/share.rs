const BASE_URL: &str = "https://api.pastes.dev/";

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

pub async fn get_data(id: &str) -> Result<String, String> {
    let response = client()
        .get(format!("{BASE_URL}{}", crate::riot::client::urlencoding_encode(id)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("pastes.dev returned {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}

pub async fn save_data(data: String) -> Result<String, String> {
    let response = client()
        .post(format!("{BASE_URL}post"))
        .body(data)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    body.get("key")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "missing key in pastes.dev response".to_string())
}
