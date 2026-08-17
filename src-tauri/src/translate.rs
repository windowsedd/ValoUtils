use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
struct LanguageEntry {
    provider: String,
    #[serde(rename = "canonicalId")]
    canonical_id: String,
    code: String,
    #[serde(rename = "englishName")]
    english_name: String,
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

/// Resolves a human-typed target language to a provider code.
///
/// The `.send {channel} {language} {message}` command is typed by a player
/// mid-match, so it accepts the English name (`german`, `Brazilian Portuguese`)
/// as well as the code (`de`, `pt-BR`, `ko-KR`). Matching is case- and
/// separator-insensitive because nobody types `pt-BR` correctly under fire.
/// Regioned BCP-47 tags fall back to the primary subtag when the catalog
/// only lists the language (`ko-KR` → `ko`); exact codes still win (`zh-TW`).
pub fn resolve_target_language(provider: &str, input: &str) -> Option<String> {
    let wanted = fold_language_key(input);
    if wanted.is_empty() {
        return None;
    }
    if let Some(code) = match_provider_target(provider, &wanted) {
        return Some(code);
    }
    // `zh_tw` is Google's `zh-TW` and DeepL's `zh-HANT`. If the typed token
    // only exists on the other provider, map through the shared canonical id.
    if let Some(matched) = language_catalog().iter().find(|entry| {
        fold_language_key(&entry.code) == wanted
            || fold_language_key(&entry.english_name) == wanted
    }) {
        if let Some(code) = match_provider_canonical(provider, &matched.canonical_id) {
            return Some(code);
        }
    }
    let primary = fold_language_key(primary_language_subtag(input)?);
    if primary.is_empty() || primary == wanted {
        return None;
    }
    match_provider_target(provider, &primary).or_else(|| {
        language_catalog()
            .iter()
            .find(|entry| {
                fold_language_key(&entry.code) == primary
                    || fold_language_key(&entry.english_name) == primary
            })
            .and_then(|matched| match_provider_canonical(provider, &matched.canonical_id))
    })
}

/// First subtag of a BCP-47-shaped token (`ko-KR`, `zh_Hant_TW`).
///
/// Rejects hyphenated English (`in-game`, `no-scope`) so those stay message
/// text instead of becoming a language.
fn primary_language_subtag(input: &str) -> Option<&str> {
    let input = input.trim();
    let mut parts = input.split(|c: char| matches!(c, '-' | '_' | '/'));
    let primary = parts.next()?;
    if !is_ascii_alpha_len(primary, 2, 3) {
        return None;
    }
    let rest: Vec<&str> = parts.filter(|part| !part.is_empty()).collect();
    if rest.is_empty() {
        return None;
    }
    if !rest
        .iter()
        .all(|part| is_script_subtag(part) || is_region_subtag(part))
    {
        return None;
    }
    Some(primary)
}

fn is_ascii_alpha_len(value: &str, min: usize, max: usize) -> bool {
    let len = value.len();
    (min..=max).contains(&len) && value.bytes().all(|b| b.is_ascii_alphabetic())
}

fn is_script_subtag(value: &str) -> bool {
    is_ascii_alpha_len(value, 4, 4)
}

fn is_region_subtag(value: &str) -> bool {
    let len = value.len();
    (len == 2 && value.bytes().all(|b| b.is_ascii_alphabetic()))
        || (len == 3 && value.bytes().all(|b| b.is_ascii_digit()))
}

fn match_provider_target(provider: &str, wanted: &str) -> Option<String> {
    language_catalog()
        .iter()
        .find(|entry| {
            entry.provider == provider
                && entry.target
                && (fold_language_key(&entry.code) == wanted
                    || fold_language_key(&entry.english_name) == wanted)
        })
        .map(|entry| entry.code.clone())
}

fn match_provider_canonical(provider: &str, canonical_id: &str) -> Option<String> {
    language_catalog()
        .iter()
        .find(|entry| {
            entry.provider == provider
                && entry.target
                && entry.canonical_id.eq_ignore_ascii_case(canonical_id)
        })
        .map(|entry| entry.code.clone())
}

/// Lowercases and drops separators so `pt-BR`, `pt br` and `ptbr` all agree,
/// as do `Chinese (Traditional)` and `chinese traditional`.
fn fold_language_key(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
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
    fn target_language_accepts_english_names_and_codes_alike() {
        assert_eq!(resolve_target_language("google", "german").unwrap(), "de");
        assert_eq!(resolve_target_language("google", "German").unwrap(), "de");
        assert_eq!(resolve_target_language("google", "de").unwrap(), "de");
        assert_eq!(resolve_target_language("google", "french").unwrap(), "fr");
        assert_eq!(resolve_target_language("google", "japanese").unwrap(), "ja");
        // Separator-insensitive, so a hyphen typed as a space still resolves.
        assert_eq!(
            resolve_target_language("google", "zh tw"),
            resolve_target_language("google", "zh-TW")
        );
        assert_eq!(
            resolve_target_language("google", "zh_tw").unwrap(),
            "zh-TW"
        );
        assert_eq!(
            resolve_target_language("google", "zh_cn").unwrap(),
            "zh-CN"
        );
        assert_eq!(
            resolve_target_language("google", "zhtw").unwrap(),
            "zh-TW"
        );
        assert_eq!(
            resolve_target_language("google", "zhcn").unwrap(),
            "zh-CN"
        );
        assert_eq!(
            resolve_target_language("google", "zh/tw").unwrap(),
            "zh-TW"
        );
        assert_eq!(
            resolve_target_language("google", "zh/cn").unwrap(),
            "zh-CN"
        );
        // DeepL uses a different code for the same Chinese variants.
        assert_eq!(
            resolve_target_language("deepl", "zh_tw").unwrap(),
            "zh-HANT"
        );
        assert_eq!(
            resolve_target_language("deepl", "zh_cn").unwrap(),
            "zh-HANS"
        );
        assert_eq!(
            resolve_target_language("deepl", "zh-TW").unwrap(),
            "zh-HANT"
        );
    }

    #[test]
    fn target_language_accepts_regioned_bcp47_codes() {
        // Google's catalog is `ko` / `ja` / `en`, not `ko-KR`. Players still
        // type the locale they see in Windows or Valorant.
        assert_eq!(resolve_target_language("google", "ko-KR").unwrap(), "ko");
        assert_eq!(resolve_target_language("google", "ko_KR").unwrap(), "ko");
        assert_eq!(resolve_target_language("google", "ko/KR").unwrap(), "ko");
        assert_eq!(resolve_target_language("google", "ja-JP").unwrap(), "ja");
        assert_eq!(resolve_target_language("google", "en-US").unwrap(), "en");
        assert_eq!(resolve_target_language("deepl", "ko-KR").unwrap(), "ko");
        // Exact regioned codes still win over the primary subtag.
        assert_eq!(
            resolve_target_language("google", "zh-TW").unwrap(),
            "zh-TW"
        );
        assert_eq!(
            resolve_target_language("deepl", "en-US").unwrap(),
            "en-US"
        );
        // Hyphenated English is not a language tag.
        assert!(resolve_target_language("google", "in-game").is_none());
        assert!(resolve_target_language("google", "no-scope").is_none());
    }

    #[test]
    fn target_language_rejects_unknown_and_source_only_values() {
        assert!(resolve_target_language("google", "klingon").is_none());
        assert!(resolve_target_language("google", "").is_none());
        // `auto` is a source-side concept only; it must never be a target.
        assert!(resolve_target_language("google", "auto").is_none());
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
