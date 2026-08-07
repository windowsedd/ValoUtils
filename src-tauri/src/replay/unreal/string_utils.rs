//! String helpers from Unreal.Core/Extensions/StringExtensions.cs.
//! Ported from `package/ts-replay-parser/src/unreal/string-utils.ts`.

/// see UObjectBaseUtility — strip everything up to the last '.', stop at '/'.
pub fn remove_all_path_prefixes(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    for i in (0..chars.len()).rev() {
        let c = chars[i];
        if c == '.' {
            return chars[i + 1..].iter().collect();
        }
        if c == '/' {
            return path.to_string();
        }
    }
    remove_path_prefix(path, "Default__")
}

pub fn remove_path_prefix(path: &str, to_remove: &str) -> String {
    if to_remove.len() > path.len() {
        return path.to_string();
    }
    let path_chars: Vec<char> = path.chars().collect();
    let remove_chars: Vec<char> = to_remove.chars().collect();
    for i in 0..remove_chars.len() {
        if path_chars.get(i) != Some(&remove_chars[i]) {
            return path.to_string();
        }
    }
    path_chars[remove_chars.len()..].iter().collect()
}

/// Strip trailing digits and underscores.
pub fn clean_path_suffix(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    for i in (0..chars.len()).rev() {
        let c = chars[i];
        if !(c.is_ascii_digit()) && c != '_' {
            return chars[..i + 1].iter().collect();
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_all_path_prefixes_strips_after_last_dot() {
        assert_eq!(remove_all_path_prefixes("/Game/Foo.Bar"), "Bar");
        assert_eq!(remove_all_path_prefixes("/Game/Foo"), "/Game/Foo");
    }

    #[test]
    fn remove_all_path_prefixes_falls_back_to_default_prefix() {
        assert_eq!(remove_all_path_prefixes("Default__Weapon"), "Weapon");
        assert_eq!(remove_all_path_prefixes("Weapon"), "Weapon");
    }

    #[test]
    fn remove_path_prefix_only_strips_matching_prefix() {
        assert_eq!(remove_path_prefix("Default__Weapon", "Default__"), "Weapon");
        assert_eq!(remove_path_prefix("Weapon", "Default__"), "Weapon");
        assert_eq!(remove_path_prefix("abc", "abcdef"), "abc");
    }

    #[test]
    fn clean_path_suffix_strips_trailing_digits_and_underscores() {
        assert_eq!(clean_path_suffix("Weapon_C_123"), "Weapon_C");
        assert_eq!(clean_path_suffix("Weapon"), "Weapon");
        // All-digit paths never hit the early return, so the TS fallthrough
        // (`return path;`) yields the original string unchanged.
        assert_eq!(clean_path_suffix("123"), "123");
    }
}
