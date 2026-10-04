pub mod prompts;
pub mod providers;
use serde_json::Value;
use std::{
    sync::{OnceLock, RwLock},
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiProviderKind {
    Anthropic,
    OpenAi,
    Gemini,
    Compatible,
}
impl AiProviderKind {
    pub fn id(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Gemini => "gemini",
            Self::Compatible => "compatible",
        }
    }
    pub fn default_model(self) -> &'static str {
        match self {
            Self::Anthropic => "claude-sonnet-5-5",
            Self::OpenAi => "gpt-5-mini",
            Self::Gemini => "gemini-2.5-flash",
            Self::Compatible => "",
        }
    }
}
#[derive(Clone, Default)]
pub struct AiConfig {
    pub provider: Option<AiProviderKind>,
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}
impl AiConfig {
    pub(crate) fn parse(provider: &Value, providers: &Value) -> Self {
        let kind = match provider.as_str() {
            Some("anthropic") => AiProviderKind::Anthropic,
            Some("openai") => AiProviderKind::OpenAi,
            Some("gemini") => AiProviderKind::Gemini,
            Some("compatible") => AiProviderKind::Compatible,
            _ => return Self::default(),
        };
        let settings = &providers[kind.id()];
        let text = |key: &str| {
            settings[key]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        let model = text("model");
        Self {
            provider: Some(kind),
            api_key: text("apiKey"),
            model: if model.is_empty() {
                kind.default_model().into()
            } else {
                model
            },
            base_url: text("baseUrl"),
        }
    }
    pub fn is_configured(&self) -> bool {
        match self.provider {
            None => false,
            Some(AiProviderKind::Compatible) => !self.model.is_empty() && !self.base_url.is_empty(),
            Some(_) => !self.api_key.is_empty(),
        }
    }
}
fn config_lock() -> &'static RwLock<AiConfig> {
    static CONFIG: OnceLock<RwLock<AiConfig>> = OnceLock::new();
    CONFIG.get_or_init(|| RwLock::new(AiConfig::default()))
}
pub fn set_config(provider: &Value, providers: &Value) {
    *config_lock().write().unwrap_or_else(|e| e.into_inner()) =
        AiConfig::parse(provider, providers);
}
pub fn config() -> AiConfig {
    config_lock()
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
pub fn is_configured() -> bool {
    config().is_configured()
}
/// Per-request cap for interactive AI calls. Self-hosted and reasoning models
/// routinely take 30s+ even for one short line.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

pub struct AiRequest<'a> {
    pub system: &'a str,
    pub prompt: &'a str,
    pub max_tokens: u32,
    pub timeout: Duration,
}
#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("AI provider is not configured. Set one up in Settings → AI.")]
    NotConfigured,
    #[error("AI authentication failed: {0}")]
    Auth(String),
    #[error("AI provider rate limit reached.")]
    RateLimited,
    #[error("AI request timed out.")]
    Timeout,
    #[error("Use HTTPS, or HTTP on localhost, for the AI base URL.")]
    InvalidBaseUrl,
    #[error("AI provider unavailable: {0}")]
    Unavailable(String),
    #[error("AI provider returned no text.")]
    EmptyResponse,
}
impl AiError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => "notConfigured",
            Self::Auth(_) => "auth",
            Self::RateLimited => "rateLimited",
            Self::Timeout => "timeout",
            Self::InvalidBaseUrl => "invalidBaseUrl",
            Self::Unavailable(_) => "unavailable",
            Self::EmptyResponse => "emptyResponse",
        }
    }
}
pub async fn complete(req: AiRequest<'_>) -> Result<String, AiError> {
    complete_with_config(&config(), req).await
}
pub async fn complete_with_config(cfg: &AiConfig, req: AiRequest<'_>) -> Result<String, AiError> {
    if !cfg.is_configured() {
        return Err(AiError::NotConfigured);
    }
    let (url, body) = providers::build_request(cfg, &req)?;
    let body = request_json(
        cfg,
        http_client().post(url).timeout(req.timeout).json(&body),
    )
    .await?;
    providers::extract_text(cfg.provider.unwrap(), &body)
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("AI HTTP client")
    })
}

async fn request_json(
    cfg: &AiConfig,
    mut request: reqwest::RequestBuilder,
) -> Result<Value, AiError> {
    match cfg.provider.unwrap() {
        AiProviderKind::Anthropic => {
            request = request
                .header("x-api-key", &cfg.api_key)
                .header("anthropic-version", "2023-06-01")
        }
        AiProviderKind::Gemini => request = request.header("x-goog-api-key", &cfg.api_key),
        _ if !cfg.api_key.is_empty() => request = request.bearer_auth(&cfg.api_key),
        _ => {}
    }
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            AiError::Timeout
        } else {
            AiError::Unavailable("Request failed".into())
        }
    })?;
    let status = response.status();
    let body = response.json::<Value>().await.map_err(|e| {
        if e.is_timeout() {
            AiError::Timeout
        } else {
            AiError::Unavailable("Invalid response".into())
        }
    });
    if !status.is_success() {
        return Err(providers::status_error(
            status.as_u16(),
            &body.unwrap_or(Value::Null),
        ));
    }
    body
}

pub async fn list_models(cfg: &AiConfig) -> Result<Vec<providers::AiModel>, AiError> {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen_cursors = std::collections::HashSet::new();
        loop {
            let url = providers::model_list_url(cfg, cursor.as_deref())?;
            let body =
                request_json(cfg, http_client().get(url).timeout(Duration::from_secs(20))).await?;
            let (page, next) = providers::parse_models_page(cfg.provider.unwrap(), &body)?;
            models.extend(page);
            let Some(next) = next else {
                break;
            };
            if !seen_cursors.insert(next.clone()) {
                return Err(AiError::Unavailable(
                    "Repeated model pagination cursor".into(),
                ));
            }
            cursor = Some(next);
        }
        models.sort_by(|a, b| a.id.cmp(&b.id));
        models.dedup_by(|a, b| a.id == b.id);
        Ok(models)
    })
    .await
    .map_err(|_| AiError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn lists_local_models_without_a_selected_model_or_api_key() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                request.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            assert!(request.starts_with("GET /v1/models HTTP/1.1"));
            assert!(!request.to_lowercase().contains("authorization:"));
            let body = r#"{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"z-model"}]}"#;
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            reader
                .into_inner()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        });
        let cfg = AiConfig {
            provider: Some(AiProviderKind::Compatible),
            api_key: String::new(),
            model: String::new(),
            base_url: format!("http://{address}/v1"),
        };
        let models = list_models(&cfg).await.unwrap();
        server.await.unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["a-model", "z-model"]
        );
    }
    #[test]
    fn garbage_config_is_disabled_and_provider_settings_are_selected() {
        for provider in [json!(null), json!(false), json!("unknown"), json!({})] {
            assert!(AiConfig::parse(&provider, &json!({})).provider.is_none());
        }
        let cfg = AiConfig::parse(
            &json!("openai"),
            &json!({"openai":{"apiKey":" key ","model":""}}),
        );
        assert_eq!(cfg.model, "gpt-5-mini");
        assert_eq!(cfg.api_key, "key");
        assert!(!AiConfig::parse(&json!("compatible"), &json!({})).is_configured());
    }
}
