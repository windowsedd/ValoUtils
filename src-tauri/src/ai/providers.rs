use super::{AiConfig, AiError, AiProviderKind, AiRequest};
use serde_json::{json, Value};

#[derive(Clone, Debug, serde::Serialize)]
pub struct AiModel {
    pub id: String,
    pub name: String,
}

pub fn model_list_url(cfg: &AiConfig, cursor: Option<&str>) -> Result<reqwest::Url, AiError> {
    let kind = cfg.provider.ok_or(AiError::NotConfigured)?;
    if kind != AiProviderKind::Compatible && cfg.api_key.is_empty() {
        return Err(AiError::NotConfigured);
    }
    let mut url = match kind {
        AiProviderKind::Anthropic => {
            reqwest::Url::parse("https://api.anthropic.com/v1/models").unwrap()
        }
        AiProviderKind::OpenAi => reqwest::Url::parse("https://api.openai.com/v1/models").unwrap(),
        AiProviderKind::Gemini => {
            reqwest::Url::parse("https://generativelanguage.googleapis.com/v1beta/models").unwrap()
        }
        AiProviderKind::Compatible => {
            let base = validate_base_url(&cfg.base_url)?;
            reqwest::Url::parse(&format!("{}/models", base.as_str().trim_end_matches('/')))
                .map_err(|_| AiError::InvalidBaseUrl)?
        }
    };
    match kind {
        AiProviderKind::Anthropic => {
            url.query_pairs_mut().append_pair("limit", "1000");
            if let Some(cursor) = cursor {
                url.query_pairs_mut().append_pair("after_id", cursor);
            }
        }
        AiProviderKind::Gemini => {
            url.query_pairs_mut().append_pair("pageSize", "1000");
            if let Some(cursor) = cursor {
                url.query_pairs_mut().append_pair("pageToken", cursor);
            }
        }
        _ => {}
    }
    Ok(url)
}

pub fn parse_models_page(
    kind: AiProviderKind,
    body: &Value,
) -> Result<(Vec<AiModel>, Option<String>), AiError> {
    let gemini = kind == AiProviderKind::Gemini;
    let entries = body[if gemini { "models" } else { "data" }]
        .as_array()
        .ok_or_else(|| AiError::Unavailable("Invalid model list response".into()))?;
    let models = entries
        .iter()
        .filter_map(|entry| {
            if gemini
                && !entry["supportedGenerationMethods"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|method| method == "generateContent"))
            {
                return None;
            }
            let raw_id = entry[if gemini { "name" } else { "id" }].as_str()?.trim();
            let id = if gemini {
                raw_id.strip_prefix("models/").unwrap_or(raw_id)
            } else {
                raw_id
            };
            if id.is_empty() {
                return None;
            }
            // The OpenAI catalog also lists models for endpoints this app doesn't use.
            // Compatible servers may assign arbitrary aliases, so don't filter those.
            if kind == AiProviderKind::OpenAi
                && ([
                    "text-",
                    "whisper-",
                    "tts-",
                    "dall-e-",
                    "sora-",
                    "davinci-",
                    "babbage-",
                    "computer-use-",
                    "codex-mini-",
                    "omni-moderation-",
                ]
                .iter()
                .any(|prefix| id.starts_with(prefix))
                    || [
                        "-image",
                        "-audio",
                        "-realtime",
                        "-transcribe",
                        "-tts",
                        "-codex",
                        "-pro",
                        "-deep-research",
                        "-instruct",
                    ]
                    .iter()
                    .any(|token| {
                        id.split(token)
                            .skip(1)
                            .any(|tail| tail.is_empty() || tail.starts_with('-'))
                    }))
            {
                return None;
            }
            let name = entry[match kind {
                AiProviderKind::Anthropic => "display_name",
                AiProviderKind::Gemini => "displayName",
                _ => "name",
            }]
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(id);
            Some(AiModel {
                id: id.into(),
                name: name.into(),
            })
        })
        .collect();
    let cursor = match kind {
        AiProviderKind::Anthropic if body["has_more"] == true => Some(
            body["last_id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| AiError::Unavailable("Invalid model pagination".into()))?
                .to_string(),
        ),
        AiProviderKind::Gemini => body["nextPageToken"]
            .as_str()
            .filter(|token| !token.is_empty())
            .map(str::to_string),
        _ => None,
    };
    Ok((models, cursor))
}

pub fn validate_base_url(value: &str) -> Result<reqwest::Url, AiError> {
    let url = reqwest::Url::parse(value).map_err(|_| AiError::InvalidBaseUrl)?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.host_str().is_none()
        || !(url.scheme() == "https" || url.scheme() == "http" && local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AiError::InvalidBaseUrl);
    }
    Ok(url)
}
pub fn build_request(cfg: &AiConfig, req: &AiRequest<'_>) -> Result<(String, Value), AiError> {
    let kind = cfg.provider.ok_or(AiError::NotConfigured)?;
    let messages =
        json!([{"role":"system","content":req.system},{"role":"user","content":req.prompt}]);
    Ok(match kind {
        AiProviderKind::Anthropic => (
            "https://api.anthropic.com/v1/messages".into(),
            json!({"model":cfg.model,"max_tokens":req.max_tokens,"system":req.system,"messages":[{"role":"user","content":req.prompt}]}),
        ),
        AiProviderKind::OpenAi => {
            let mut body = json!({"model":cfg.model,"max_completion_tokens":req.max_tokens,"messages":messages});
            if cfg.model == "gpt-5-mini" || cfg.model.starts_with("gpt-5-mini-") {
                // Completion budgets include reasoning as well as visible text.
                body["reasoning_effort"] = json!("minimal");
                body["max_completion_tokens"] = json!(req.max_tokens.saturating_add(1024));
            }
            ("https://api.openai.com/v1/chat/completions".into(), body)
        }
        AiProviderKind::Gemini => {
            let mut url =
                reqwest::Url::parse("https://generativelanguage.googleapis.com/v1beta/models/")
                    .unwrap();
            url.path_segments_mut()
                .unwrap()
                .pop_if_empty()
                .push(&format!("{}:generateContent", cfg.model));
            let mut body = json!({"systemInstruction":{"parts":[{"text":req.system}]},"contents":[{"role":"user","parts":[{"text":req.prompt}]}],"generationConfig":{"maxOutputTokens":req.max_tokens}});
            if cfg.model.starts_with("gemini-2.5-flash") {
                body["generationConfig"]["thinkingConfig"] = json!({"thinkingBudget":0});
            }
            (url.to_string(), body)
        }
        AiProviderKind::Compatible => {
            let url = validate_base_url(&cfg.base_url)?;
            (
                format!("{}/chat/completions", url.as_str().trim_end_matches('/')),
                json!({"model":cfg.model,"max_tokens":req.max_tokens,"messages":messages}),
            )
        }
    })
}
pub fn extract_text(kind: AiProviderKind, body: &Value) -> Result<String, AiError> {
    let text = match kind {
        AiProviderKind::Anthropic => body["content"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default(),
        AiProviderKind::Gemini => body["candidates"][0]["content"]["parts"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p["thought"] != true)
                    .filter_map(|p| p["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default(),
        _ => body["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        Err(AiError::EmptyResponse)
    } else {
        Ok(text)
    }
}
pub fn status_error(status: u16, body: &Value) -> AiError {
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or("Request failed")
        .chars()
        .take(200)
        .collect();
    match status {
        401 | 403 => AiError::Auth(message),
        429 => AiError::RateLimited,
        _ => AiError::Unavailable(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiConfig, AiProviderKind, AiRequest};
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn openai_model_list_skips_known_non_chat_models_but_keeps_compatible_aliases() {
        let body = json!({"data":[{"id":"gpt-5-mini"},{"id":"gpt-4.1"},{"id":"o3-mini"},{"id":"text-embedding-3-small"},{"id":"gpt-image-1"},{"id":"gpt-4o-audio-preview"},{"id":"gpt-5-pro"},{"id":"gpt-5-codex"},{"id":"o3-deep-research"}]});
        let (models, _) = parse_models_page(AiProviderKind::OpenAi, &body).unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["gpt-5-mini", "gpt-4.1", "o3-mini"]
        );
        assert_eq!(
            parse_models_page(AiProviderKind::Compatible, &body)
                .unwrap()
                .0
                .len(),
            9
        );
    }

    #[test]
    fn model_lists_use_provider_endpoints_without_requiring_a_model() {
        let mut cfg = AiConfig {
            provider: Some(AiProviderKind::Compatible),
            api_key: String::new(),
            model: String::new(),
            base_url: "http://localhost:11434/v1/".into(),
        };
        assert_eq!(
            model_list_url(&cfg, None).unwrap().as_str(),
            "http://localhost:11434/v1/models"
        );
        cfg.base_url = "http://remote.example/v1".into();
        assert_eq!(
            model_list_url(&cfg, None).unwrap_err().code(),
            "invalidBaseUrl"
        );
        cfg.provider = Some(AiProviderKind::Anthropic);
        cfg.api_key = "secret".into();
        let url = model_list_url(&cfg, Some("last model")).unwrap();
        assert_eq!(url.path(), "/v1/models");
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "after_id" && value == "last model"));
        assert!(!url.as_str().contains("secret"));
        cfg.provider = Some(AiProviderKind::Gemini);
        assert!(model_list_url(&cfg, Some("next"))
            .unwrap()
            .query_pairs()
            .any(|(key, value)| key == "pageToken" && value == "next"));
        cfg.provider = Some(AiProviderKind::OpenAi);
        assert_eq!(
            model_list_url(&cfg, None).unwrap().as_str(),
            "https://api.openai.com/v1/models"
        );
        cfg.api_key.clear();
        assert_eq!(
            model_list_url(&cfg, None).unwrap_err().code(),
            "notConfigured"
        );
    }

    #[test]
    fn model_pages_extract_ids_labels_and_pagination() {
        let (models, next) = parse_models_page(AiProviderKind::Anthropic, &json!({"data":[{"id":"claude-model","display_name":"Claude Model"}],"has_more":true,"last_id":"claude-model"})).unwrap();
        assert_eq!(models[0].name, "Claude Model");
        assert_eq!(next.as_deref(), Some("claude-model"));
        for kind in [AiProviderKind::OpenAi, AiProviderKind::Compatible] {
            let (models, next) = parse_models_page(
                kind,
                &json!({"data":[{"id":"model-1"},{"id":""},{"id":123}]}),
            )
            .unwrap();
            assert_eq!(models.len(), 1);
            assert_eq!(models[0].id, "model-1");
            assert_eq!(models[0].name, "model-1");
            assert!(next.is_none());
        }
        let (models, next) = parse_models_page(AiProviderKind::Gemini, &json!({"models":[{"name":"models/gemini-flash","displayName":"Flash","supportedGenerationMethods":["generateContent"]},{"name":"models/embedding","supportedGenerationMethods":["embedContent"]}],"nextPageToken":"next"})).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-flash");
        assert_eq!(models[0].name, "Flash");
        assert_eq!(next.as_deref(), Some("next"));
        assert!(parse_models_page(AiProviderKind::OpenAi, &json!({})).is_err());
        assert!(
            parse_models_page(AiProviderKind::OpenAi, &json!({"data":[]}))
                .unwrap()
                .0
                .is_empty()
        );
    }

    #[test]
    fn short_requests_reserve_reasoning_budget_only_for_supported_models() {
        let req = AiRequest {
            system: "Reply OK",
            prompt: "OK",
            max_tokens: 16,
            timeout: Duration::from_secs(20),
        };
        let mut cfg = AiConfig {
            provider: Some(AiProviderKind::OpenAi),
            api_key: "key".into(),
            model: "gpt-5-mini".into(),
            base_url: String::new(),
        };
        let (_, body) = build_request(&cfg, &req).unwrap();
        assert_eq!(body["reasoning_effort"], "minimal");
        assert_eq!(body["max_completion_tokens"], 1040);
        cfg.provider = Some(AiProviderKind::Gemini);
        cfg.model = "gemini-2.5-pro".into();
        let (_, body) = build_request(&cfg, &req).unwrap();
        assert!(body["generationConfig"].get("thinkingConfig").is_none());
        cfg.model = "gemini-2.5-flash".into();
        let (_, body) = build_request(&cfg, &req).unwrap();
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            0
        );
    }

    #[test]
    fn provider_bodies_and_text() {
        let req = AiRequest {
            system: "system",
            prompt: "hello",
            max_tokens: 16,
            timeout: Duration::from_secs(20),
        };
        for kind in [
            AiProviderKind::Anthropic,
            AiProviderKind::OpenAi,
            AiProviderKind::Gemini,
            AiProviderKind::Compatible,
        ] {
            let cfg = AiConfig {
                provider: Some(kind),
                api_key: "secret".into(),
                model: "model".into(),
                base_url: "http://localhost:11434/v1/".into(),
            };
            let (url, body) = build_request(&cfg, &req).unwrap();
            assert!(!url.contains("secret"));
            match kind {
                AiProviderKind::Anthropic => {
                    assert_eq!(body["system"], "system");
                    assert_eq!(body["max_tokens"], 16);
                    assert_eq!(extract_text(kind, &json!({"content":[{"type":"text","text":"A"},{"type":"tool_use","text":"skip"},{"type":"text","text":"B"}]})).unwrap(), "AB");
                }
                AiProviderKind::Gemini => {
                    assert_eq!(body["generationConfig"]["maxOutputTokens"], 16);
                    assert_eq!(body["contents"][0]["parts"][0]["text"], "hello");
                    assert_eq!(extract_text(kind, &json!({"candidates":[{"content":{"parts":[{"text":"A"},{"text":"B"}]}}]})).unwrap(), "AB");
                }
                _ => {
                    assert_eq!(body["messages"][1]["content"], "hello");
                    assert_eq!(
                        body[if kind == AiProviderKind::OpenAi {
                            "max_completion_tokens"
                        } else {
                            "max_tokens"
                        }],
                        16
                    );
                    assert_eq!(
                        extract_text(kind, &json!({"choices":[{"message":{"content":" OK "}}]}))
                            .unwrap(),
                        "OK"
                    );
                }
            }
            assert_eq!(
                extract_text(kind, &json!({})).unwrap_err().code(),
                "emptyResponse"
            );
        }
    }

    #[test]
    fn validates_urls_and_maps_statuses() {
        for url in [
            "https://example.com/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1/v1",
            "http://[::1]/v1",
        ] {
            assert!(validate_base_url(url).is_ok(), "{url}");
        }
        for url in [
            "garbage",
            "http://example.com/v1",
            "ftp://localhost",
            "https://user:password@example.com",
            "https://example.com/?key=secret",
        ] {
            assert!(validate_base_url(url).is_err(), "{url}");
        }
        assert_eq!(status_error(401, &json!({})).code(), "auth");
        assert_eq!(status_error(403, &json!({})).code(), "auth");
        assert_eq!(status_error(429, &json!({})).code(), "rateLimited");
        assert_eq!(status_error(503, &json!({})).code(), "unavailable");
    }
}
