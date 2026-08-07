/// Civil-from-days algorithm (Howard Hinnant), UTC, no timezone-database
/// dependency needed since the app only ever renders UTC-based labels.
pub fn civil_from_unix_secs(secs: i64) -> (i64, u32, u32, i64, i64, i64) {
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (h, m, s) = (time_of_day / 3600, (time_of_day % 3600) / 60, time_of_day % 60);

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
