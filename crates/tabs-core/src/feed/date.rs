//! Feed date parsing — RFC 822/1123 (RSS) and RFC 3339/ISO 8601 (Atom).
//!
//! Everything is reduced to a Unix timestamp in seconds. There is no date
//! *type* here on purpose: the only questions asked of a publication date
//! are "how old" and "which is newer", and a plain integer answers both
//! without a calendar library in the wasm bundle.
//!
//! Publishers get this wrong in predictable ways — single-digit days, no
//! leading zeros, missing seconds, `GMT` vs `+0000`, and named zones that
//! are ambiguous by definition. Anything unparseable returns `None`, and the
//! caller substitutes fetch time rather than dropping the item.

const DAYS_BEFORE_MONTH: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Days from the Unix epoch to Y-M-D (proleptic Gregorian).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let mut days = 0i64;
    if y >= 1970 {
        for year in 1970..y {
            days += if is_leap(year) { 366 } else { 365 };
        }
    } else {
        for year in y..1970 {
            days -= if is_leap(year) { 366 } else { 365 };
        }
    }
    days += DAYS_BEFORE_MONTH[(m as usize).clamp(1, 12) - 1];
    if m > 2 && is_leap(y) {
        days += 1;
    }
    days + d - 1
}

fn to_unix(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, offset_secs: i64) -> i64 {
    days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s - offset_secs
}

fn month_from_name(name: &str) -> Option<i64> {
    const M: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let lower = name.to_ascii_lowercase();
    M.iter()
        .position(|m| lower.starts_with(m))
        .map(|i| i as i64 + 1)
}

/// Named zones seen in RSS. Anything military or ambiguous resolves to UTC,
/// which is what RFC 822 says to do with an unrecognised zone.
fn zone_offset(z: &str) -> i64 {
    let z = z.trim();
    if let Some(rest) = z.strip_prefix('+').or_else(|| z.strip_prefix('-')) {
        let sign = if z.starts_with('-') { -1 } else { 1 };
        let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() >= 4 {
            let h: i64 = digits[..2].parse().unwrap_or(0);
            let m: i64 = digits[2..4].parse().unwrap_or(0);
            return sign * (h * 3600 + m * 60);
        }
        if digits.len() == 2 {
            return sign * digits.parse::<i64>().unwrap_or(0) * 3600;
        }
        return 0;
    }
    match z.to_ascii_uppercase().as_str() {
        "GMT" | "UT" | "UTC" | "Z" => 0,
        "EST" => -5 * 3600,
        "EDT" => -4 * 3600,
        "CST" => -6 * 3600,
        "CDT" => -5 * 3600,
        "MST" => -7 * 3600,
        "MDT" => -6 * 3600,
        "PST" => -8 * 3600,
        "PDT" => -7 * 3600,
        _ => 0,
    }
}

/// RFC 3339 / ISO 8601: `2026-08-30T14:05:00Z`, `2026-08-30T14:05:00+08:00`,
/// `2026-08-30` (midnight UTC).
fn parse_iso(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let mo: i64 = s[5..7].parse().ok()?;
    let d: i64 = s[8..10].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    if bytes.len() == 10 {
        return Some(to_unix(y, mo, d, 0, 0, 0, 0));
    }
    let rest = &s[11..];
    let (h, mi, sec, off) = {
        let hh: i64 = rest.get(0..2)?.parse().ok()?;
        let mm: i64 = rest.get(3..5)?.parse().ok()?;
        let (ss, tail) = if rest.len() >= 8 && rest.as_bytes()[5] == b':' {
            (rest[6..8].parse::<i64>().ok()?, &rest[8..])
        } else {
            (0, &rest[5..])
        };
        // Drop fractional seconds before reading the zone.
        let tail = match tail.strip_prefix('.') {
            Some(f) => {
                let n = f.chars().take_while(|c| c.is_ascii_digit()).count();
                &f[n..]
            }
            None => tail,
        };
        (
            hh,
            mm,
            ss,
            zone_offset(if tail.is_empty() { "Z" } else { tail }),
        )
    };
    Some(to_unix(y, mo, d, h, mi, sec, off))
}

/// RFC 822 / 1123: `Sat, 30 Aug 2026 14:05:00 +0000`. The leading day name
/// is optional in the wild, and so are the seconds.
fn parse_rfc822(s: &str) -> Option<i64> {
    let s = s.trim();
    let s = match s.split_once(", ") {
        Some((_, rest)) => rest,
        None => s.split_once(',').map_or(s, |(_, r)| r.trim_start()),
    };
    let mut it = s.split_whitespace();
    let first = it.next()?;
    // Both `30 Aug 2026` and `Aug 30 2026` occur.
    let (d, mo) = match first.parse::<i64>() {
        Ok(d) => (d, month_from_name(it.next()?)?),
        Err(_) => {
            let mo = month_from_name(first)?;
            (it.next()?.trim_end_matches(',').parse().ok()?, mo)
        }
    };
    let mut y: i64 = it.next()?.parse().ok()?;
    if y < 100 {
        y += if y < 70 { 2000 } else { 1900 };
    }
    let time = it.next().unwrap_or("00:00:00");
    let mut tp = time.split(':');
    let h: i64 = tp.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mi: i64 = tp.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let sec: i64 = tp.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let off = zone_offset(it.next().unwrap_or("GMT"));
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    Some(to_unix(y, mo, d, h, mi, sec, off))
}

/// Parse any date shape a feed might carry. `None` means "unparseable" —
/// callers substitute fetch time rather than discard the item.
pub fn parse(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    parse_iso(t).or_else(|| parse_rfc822(t))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-08-30T00:00:00Z, computed independently of the code under test.
    const AUG30_2026: i64 = 1788048000;

    #[test]
    fn epoch_anchor_is_right() {
        assert_eq!(parse("1970-01-01T00:00:00Z").unwrap(), 0);
        assert_eq!(parse("2000-01-01T00:00:00Z").unwrap(), 946_684_800);
        assert_eq!(parse("2026-08-30T00:00:00Z").unwrap(), AUG30_2026);
    }

    #[test]
    fn rfc822_and_iso_agree_on_the_same_instant() {
        let a = parse("Sat, 30 Aug 2026 14:05:00 +0000").unwrap();
        let b = parse("2026-08-30T14:05:00Z").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn offsets_are_applied_in_the_right_direction() {
        // +08:00 is ahead of UTC, so the same wall clock is an earlier instant.
        let sg = parse("2026-08-30T20:00:00+08:00").unwrap();
        let utc = parse("2026-08-30T12:00:00Z").unwrap();
        assert_eq!(sg, utc);
        let ny = parse("Sat, 30 Aug 2026 08:00:00 -0400").unwrap();
        assert_eq!(ny, parse("2026-08-30T12:00:00Z").unwrap());
    }

    #[test]
    fn tolerates_the_shapes_publishers_actually_ship() {
        assert!(parse("2026-08-30").is_some());
        assert!(parse("30 Aug 2026 14:05 GMT").is_some());
        assert!(parse("Sat, 30 Aug 2026 14:05:00 EST").is_some());
        assert!(parse("2026-08-30T14:05:00.123456Z").is_some());
        assert!(parse("2026-08-30T14:05Z").is_some());
        assert!(parse("Aug 30 2026 14:05:00 GMT").is_some());
    }

    #[test]
    fn fractional_seconds_do_not_shift_the_zone() {
        let a = parse("2026-08-30T14:05:00.999+08:00").unwrap();
        let b = parse("2026-08-30T06:05:00Z").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn leap_years_are_handled() {
        let feb29 = parse("2024-02-29T00:00:00Z").unwrap();
        let mar1 = parse("2024-03-01T00:00:00Z").unwrap();
        assert_eq!(mar1 - feb29, 86_400);
    }

    #[test]
    fn garbage_is_none_not_a_wrong_answer() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("last tuesday"), None);
        assert_eq!(parse("2026-13-45"), None);
    }

    #[test]
    fn ordering_is_what_ranking_relies_on() {
        let older = parse("2026-08-29T23:59:59Z").unwrap();
        let newer = parse("2026-08-30T00:00:01Z").unwrap();
        assert!(newer > older);
    }
}
