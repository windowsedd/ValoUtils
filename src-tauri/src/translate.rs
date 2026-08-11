use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
struct LanguageEntry {
    provider: String,
    code: String,
    source: bool,
    target: bool,
}

pub struct TranslationResult {
    pub text: String,
    pub source_language: String,
    pub target_language: String,
}

fn language_catalog() -> &'static Vec<LanguageEntry> {
    static CATALOG: OnceLock<Vec<LanguageEntry>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/data/translation-languages.json"))
            .expect("translation language catalog must be valid JSON")
    })
}

fn normalize_language(provider: &str, role: &str, code: &str) -> Result<String, String> {
    if role == "source" && code.eq_ignore_ascii_case("auto") {
        return Ok("auto".into());
    }
    language_catalog()
        .iter()
        .find(|entry| {
            entry.provider == provider
                && entry.code.eq_ignore_ascii_case(code)
                && match role {
                    "source" => entry.source,
                    "target" => entry.target,
                    _ => false,
                }
        })
        .map(|entry| entry.code.clone())
        .ok_or_else(|| format!("Unsupported {role} language '{code}' for {provider}."))
}

fn google_query(text: &str, source: &str, target: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client", "gtx".into()),
        ("sl", source.into()),
        ("tl", target.into()),
        ("dt", "t".into()),
        ("q", text.into()),
    ]
}

fn deepl_form(text: &str, source: &str, target: &str) -> Vec<(&'static str, String)> {
    let mut form = vec![("text", text.into()), ("target_lang", target.into())];
    if source != "auto" {
        form.push(("source_lang", source.into()));
    }
    form
}

/// Mirrors electron/util/translate.ts, minus the unofficial
/// `google-translate-api` npm path — standardized on the raw Google web
/// endpoint it already used as its fallback (per migration decision).
pub async fn translate_text(
    text: &str,
    provider: &str,
    source_language: &str,
    target_language: &str,
    deepl_api_key: &str,
) -> Result<TranslationResult, String> {
    if provider != "google" && provider != "deepl" {
        return Err(format!("Unsupported translation provider '{provider}'."));
    }
    let source = if source_language.trim().is_empty() {
        "auto"
    } else {
        source_language.trim()
    };
    let target = if target_language.trim().is_empty() {
        if provider == "deepl" {
            "en-US"
        } else {
            "en"
        }
    } else {
        target_language.trim()
    };
    let source = normalize_language(provider, "source", source)?;
    let target = normalize_language(provider, "target", target)?;
    if text.trim().is_empty() {
        return Ok(TranslationResult {
            text: String::new(),
            source_language: source,
            target_language: target,
        });
    }

    let translated_text = if provider == "deepl" {
        if deepl_api_key.trim().is_empty() {
            return Err("DeepL API key is required.".into());
        }
        let endpoint = if deepl_api_key.ends_with(":fx") {
            "https://api-free.deepl.com/v2/translate"
        } else {
            "https://api.deepl.com/v2/translate"
        };
        let client = reqwest::Client::new();
        let response = client
            .post(endpoint)
            .header("Authorization", format!("DeepL-Auth-Key {deepl_api_key}"))
            .form(&deepl_form(text, &source, &target))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        body.pointer("/translations/0/text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    } else {
        translate_with_google_web(text, &source, &target).await?
    };

    Ok(TranslationResult {
        text: translated_text,
        source_language: source,
        target_language: target,
    })
}

async fn translate_with_google_web(
    text: &str,
    source_language: &str,
    target_language: &str,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&google_query(text, source_language, target_language))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_roles_from_shared_catalog() {
        assert_eq!(
            normalize_language("google", "source", "ZH-tw").unwrap(),
            "zh-TW"
        );
        assert_eq!(
            normalize_language("google", "source", "auto").unwrap(),
            "auto"
        );
        assert!(normalize_language("deepl", "source", "en-US").is_err());
        assert_eq!(
            normalize_language("deepl", "target", "EN-us").unwrap(),
            "en-US"
        );
        assert!(normalize_language("google", "target", "auto").is_err());
        assert!(normalize_language("google", "target", "not-real").is_err());
        assert!(normalize_language("unknown", "target", "en").is_err());
    }

    #[test]
    fn google_query_contains_explicit_or_auto_source() {
        let explicit = google_query("hello", "en", "zh-TW");
        assert!(explicit.contains(&("sl", "en".to_string())));
        assert!(explicit.contains(&("tl", "zh-TW".to_string())));
        let automatic = google_query("hello", "auto", "zh-TW");
        assert!(automatic.contains(&("sl", "auto".to_string())));
    }

    #[test]
    fn deepl_form_omits_auto_and_includes_explicit_source() {
        let automatic = deepl_form("hello", "auto", "en-US");
        assert!(!automatic.iter().any(|(key, _)| *key == "source_lang"));
        assert!(automatic.contains(&("target_lang", "en-US".to_string())));
        let explicit = deepl_form("hello", "ja", "en-US");
        assert!(explicit.contains(&("source_lang", "ja".to_string())));
    }
}
