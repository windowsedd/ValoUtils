/// Civil-from-days algorithm (Howard Hinnant), UTC, no timezone-database
/// dependency needed since the app only ever renders UTC-based labels.
pub fn civil_from_unix_secs(secs: i64) -> (i64, u32, u32, i64, i64, i64) {
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (h, m, s) = (
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    );

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m2 = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y2 = if m2 <= 2 { y + 1 } else { y };

    (y2, m2, d, h, m, s)
}

/// Unix seconds for an ISO-8601 UTC timestamp like `2025-01-08T00:00:00Z`
/// (fractional seconds and the zone suffix are ignored). `None` if malformed.
pub fn iso_to_unix_secs(text: &str) -> Option<i64> {
    let text = text.trim();
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (y, m, d) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (h, mi, s) = if text.len() >= 19 {
        (number(11..13)?, number(14..16)?, number(17..19)?)
    } else {
        (0, 0, 0)
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Days-from-civil (Howard Hinnant), the inverse of `civil_from_unix_secs`.
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + s)
}

#[cfg(test)]
mod iso_tests {
    use super::*;

    #[test]
    fn iso_round_trips_with_civil_from_unix() {
        let secs = iso_to_unix_secs("2025-01-08T13:45:30Z").unwrap();
        assert_eq!(civil_from_unix_secs(secs), (2025, 1, 8, 13, 45, 30));
        assert_eq!(iso_to_unix_secs("1970-01-01T00:00:00.000Z"), Some(0));
        assert!(iso_to_unix_secs("not a date").is_none());
    }
}
