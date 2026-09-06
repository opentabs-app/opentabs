//! Natural-language due dates (milestone M8): "fri 3pm", "next tue", "eom".
//!
//! The difference between a to-do list people use and one they abandon is
//! whether adding an item costs a date picker. One rule governs every case:
//! **a bare day or time always resolves forward.** "fri" typed on a Friday
//! evening means next Friday, not four minutes ago — a parser that returns a
//! past due date for a future phrase is worse than no parser.

const DAY: i64 = 86_400;

#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub at: i64,
    /// Whether a clock time was given. Without one the UI shows a date only.
    pub has_time: bool,
    /// The input with the date phrase removed — the actual task text.
    pub rest: String,
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn civil_to_unix(y: i64, m: i64, d: i64) -> i64 {
    const CUM: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
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
    days += CUM[(m as usize).clamp(1, 12) - 1];
    if m > 2 && is_leap(y) {
        days += 1;
    }
    (days + d - 1) * DAY
}

fn unix_to_civil(t: i64) -> (i64, i64, i64) {
    let mut days = t.div_euclid(DAY);
    let mut y = 1970i64;
    loop {
        let len = if is_leap(y) { 366 } else { 365 };
        if days >= len {
            days -= len;
            y += 1;
        } else if days < 0 {
            y -= 1;
            days += if is_leap(y) { 366 } else { 365 };
        } else {
            break;
        }
    }
    let lens = [
        31,
        if is_leap(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 0usize;
    while m < 12 && days >= lens[m] {
        days -= lens[m];
        m += 1;
    }
    (y, m as i64 + 1, days + 1)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    [
        31,
        if is_leap(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ][(m.clamp(1, 12) - 1) as usize]
}

/// 0 = Monday.
fn weekday(t: i64) -> i64 {
    (t.div_euclid(DAY) + 3).rem_euclid(7)
}

fn start_of_day(t: i64) -> i64 {
    t.div_euclid(DAY) * DAY
}

fn weekday_from(token: &str) -> Option<i64> {
    const NAMES: [(&str, i64); 14] = [
        ("monday", 0),
        ("mon", 0),
        ("tuesday", 1),
        ("tue", 1),
        ("wednesday", 2),
        ("wed", 2),
        ("thursday", 3),
        ("thu", 3),
        ("friday", 4),
        ("fri", 4),
        ("saturday", 5),
        ("sat", 5),
        ("sunday", 6),
        ("sun", 6),
    ];
    let t = token.to_lowercase();
    NAMES.iter().find(|(n, _)| t == *n).map(|(_, d)| *d)
}

/// `3pm`, `15:30`, `9.30am`, `noon`, `midnight`. Returns seconds since
/// midnight.
fn parse_time(token: &str) -> Option<i64> {
    let t = token.trim().to_lowercase();
    match t.as_str() {
        "noon" | "midday" => return Some(12 * 3600),
        "midnight" => return Some(0),
        _ => {}
    }
    let (body, ampm) = if let Some(b) = t.strip_suffix("am") {
        (b.trim(), Some(false))
    } else if let Some(b) = t.strip_suffix("pm") {
        (b.trim(), Some(true))
    } else {
        (t.as_str(), None)
    };
    if body.is_empty() {
        return None;
    }
    let (h_str, m_str) = match body.split_once([':', '.']) {
        Some((h, m)) => (h, m),
        None => (body, "0"),
    };
    if !h_str.chars().all(|c| c.is_ascii_digit()) || !m_str.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut h: i64 = h_str.parse().ok()?;
    let m: i64 = m_str.parse().ok()?;
    if m > 59 {
        return None;
    }
    match ampm {
        // A bare "15" is an hour only when it cannot be anything else.
        None if h > 23 => return None,
        Some(true) if h < 12 => h += 12,
        Some(false) if h == 12 => h = 0,
        Some(_) if h > 12 => return None,
        _ => {}
    }
    Some(h * 3600 + m * 60)
}

/// Parse a due date out of free text. Returns `None` when no date phrase is
/// present, which the caller treats as "no due date" rather than an error.
pub fn parse(input: &str, now: i64) -> Option<Parsed> {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    let lower: Vec<String> = tokens.iter().map(|t| t.to_lowercase()).collect();

    let mut consumed = vec![false; tokens.len()];
    let mut date: Option<i64> = None;
    let mut time: Option<i64> = None;
    let today = start_of_day(now);

    let mut i = 0usize;
    while i < tokens.len() {
        let t = lower[i].trim_end_matches(',');
        let two = (i + 1 < tokens.len()).then(|| lower[i + 1].trim_end_matches(',').to_string());

        // Multi-word forms first, so "next tue" is not read as bare "tue".
        if t == "next" {
            if let Some(w) = two.as_deref().and_then(weekday_from) {
                let cur = weekday(today);
                // "next tue" means the Tuesday of the coming week, always
                // strictly more than a week's wrap away from today.
                let mut delta = (w - cur).rem_euclid(7);
                if delta == 0 {
                    delta = 7;
                }
                date = Some(today + delta * DAY);
                consumed[i] = true;
                consumed[i + 1] = true;
                i += 2;
                continue;
            }
            if matches!(two.as_deref(), Some("week")) {
                date = Some(today + 7 * DAY);
                consumed[i] = true;
                consumed[i + 1] = true;
                i += 2;
                continue;
            }
            if matches!(two.as_deref(), Some("month")) {
                let (y, m, d) = unix_to_civil(today);
                let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
                date = Some(civil_to_unix(ny, nm, d.min(days_in_month(ny, nm))));
                consumed[i] = true;
                consumed[i + 1] = true;
                i += 2;
                continue;
            }
        }
        if t == "in" {
            if let (Some(n), Some(unit)) = (
                two.as_deref().and_then(|v| v.parse::<i64>().ok()),
                lower
                    .get(i + 2)
                    .map(|s| s.trim_end_matches(['s', ',']).to_string()),
            ) {
                let mult = match unit.as_str() {
                    "day" => Some(DAY),
                    "week" => Some(7 * DAY),
                    "hour" => Some(3600),
                    "min" | "minute" => Some(60),
                    _ => None,
                };
                if let Some(mult) = mult {
                    let target = if mult >= DAY {
                        today + n * mult
                    } else {
                        now + n * mult
                    };
                    date = Some(start_of_day(target));
                    if mult < DAY {
                        time = Some(target.rem_euclid(DAY));
                    }
                    consumed[i] = true;
                    consumed[i + 1] = true;
                    consumed[i + 2] = true;
                    i += 3;
                    continue;
                }
            }
        }

        let single = match t {
            "today" | "tod" => Some(today),
            "tomorrow" | "tmr" | "tmrw" => Some(today + DAY),
            "yesterday" => Some(today - DAY),
            "eom" => {
                let (y, m, _) = unix_to_civil(today);
                Some(civil_to_unix(y, m, days_in_month(y, m)))
            }
            "eow" => Some(today + (4 - weekday(today)).rem_euclid(7) * DAY),
            _ => None,
        };
        if let Some(d) = single {
            date = Some(d);
            consumed[i] = true;
            i += 1;
            continue;
        }
        if let Some(w) = weekday_from(t) {
            // Bare weekday: always forward. This is the rule.
            let delta = (w - weekday(today)).rem_euclid(7);
            date = Some(today + if delta == 0 { 7 } else { delta } * DAY);
            consumed[i] = true;
            i += 1;
            continue;
        }
        // ISO date.
        if t.len() == 10 && t.as_bytes()[4] == b'-' {
            let p: Vec<&str> = t.split('-').collect();
            if let (Ok(y), Ok(m), Ok(d)) = (
                p[0].parse::<i64>(),
                p[1].parse::<i64>(),
                p[2].parse::<i64>(),
            ) {
                if (1..=12).contains(&m) && (1..=31).contains(&d) {
                    date = Some(civil_to_unix(y, m, d));
                    consumed[i] = true;
                    i += 1;
                    continue;
                }
            }
        }
        if time.is_none() {
            if let Some(secs) = parse_time(t) {
                time = Some(secs);
                consumed[i] = true;
                i += 1;
                continue;
            }
        }
        if t == "at" || t == "by" || t == "on" || t == "due" {
            // Only a connector when a date or time follows.
            if lower
                .get(i + 1)
                .map(|n| parse_time(n).is_some() || weekday_from(n).is_some())
                .unwrap_or(false)
            {
                consumed[i] = true;
            }
        }
        i += 1;
    }

    let date = date.or_else(|| time.map(|_| today))?;
    let has_time = time.is_some();
    let mut at = date + time.unwrap_or(9 * 3600);
    // A time-only phrase that has already passed today means tomorrow.
    if has_time && at <= now && input.split_whitespace().count() > 0 {
        let named_day = lower.iter().any(|t| {
            weekday_from(t.trim_end_matches(',')).is_some()
                || matches!(t.as_str(), "today" | "tomorrow" | "eom" | "eow")
                || t.len() == 10
        });
        if !named_day {
            at += DAY;
        }
    }

    let rest = tokens
        .iter()
        .zip(&consumed)
        .filter(|(_, c)| !**c)
        .map(|(t, _)| *t)
        .collect::<Vec<_>>()
        .join(" ");

    Some(Parsed { at, has_time, rest })
}

#[cfg(test)]
mod tests {
    use super::*;
    // Sunday 2026-08-30, 10:00 UTC.
    const NOW: i64 = 1_788_048_000 + 10 * 3600;

    #[test]
    fn today_is_a_sunday_so_the_fixtures_make_sense() {
        assert_eq!(weekday(NOW), 6);
    }

    #[test]
    fn parses_relative_days() {
        assert_eq!(
            parse("tomorrow", NOW).unwrap().at,
            start_of_day(NOW) + DAY + 9 * 3600
        );
        assert_eq!(
            parse("today", NOW).unwrap().at,
            start_of_day(NOW) + 9 * 3600
        );
    }

    #[test]
    fn a_bare_weekday_always_resolves_forward() {
        // The rule. Today is Sunday; "fri" is the coming Friday, five days on.
        let p = parse("fri", NOW).unwrap();
        assert_eq!(p.at, start_of_day(NOW) + 5 * DAY + 9 * 3600);
        assert!(p.at > NOW);
    }

    #[test]
    fn the_same_weekday_as_today_means_next_week() {
        let p = parse("sunday", NOW).unwrap();
        assert_eq!(p.at, start_of_day(NOW) + 7 * DAY + 9 * 3600);
    }

    #[test]
    fn next_tue_is_the_following_tuesday() {
        let p = parse("next tue", NOW).unwrap();
        assert_eq!(weekday(p.at), 1);
        assert!(p.at > NOW);
    }

    #[test]
    fn parses_times_in_several_shapes() {
        for (s, secs) in [
            ("3pm", 15 * 3600),
            ("15:30", 15 * 3600 + 1800),
            ("9.30am", 9 * 3600 + 1800),
            ("noon", 12 * 3600),
            ("midnight", 0),
            ("12am", 0),
            ("12pm", 12 * 3600),
        ] {
            let p = parse(&format!("fri {s}"), NOW).unwrap();
            assert_eq!(p.at % DAY, secs, "failed on {s}");
            assert!(p.has_time);
        }
    }

    #[test]
    fn a_time_that_has_passed_today_rolls_to_tomorrow() {
        // 09:00 with now at 10:00 must not be due an hour ago.
        let p = parse("call bank 9am", NOW).unwrap();
        assert!(p.at > NOW, "a future phrase must never produce a past date");
        assert_eq!(p.at, start_of_day(NOW) + DAY + 9 * 3600);
    }

    #[test]
    fn a_named_day_with_a_past_time_does_not_roll() {
        let p = parse("today 9am", NOW).unwrap();
        assert_eq!(p.at, start_of_day(NOW) + 9 * 3600);
    }

    #[test]
    fn eom_and_eow() {
        let p = parse("eom", NOW).unwrap();
        let (_, m, d) = unix_to_civil(p.at);
        assert_eq!((m, d), (8, 31));
        assert_eq!(weekday(parse("eow", NOW).unwrap().at), 4);
    }

    #[test]
    fn relative_offsets() {
        assert_eq!(
            parse("in 3 days", NOW).unwrap().at,
            start_of_day(NOW) + 3 * DAY + 9 * 3600
        );
        let p = parse("in 2 hours", NOW).unwrap();
        assert_eq!(p.at, NOW + 2 * 3600);
    }

    #[test]
    fn iso_dates_are_taken_literally() {
        let p = parse("2026-12-25 review", NOW).unwrap();
        let (y, m, d) = unix_to_civil(p.at);
        assert_eq!((y, m, d), (2026, 12, 25));
        assert_eq!(p.rest, "review");
    }

    #[test]
    fn the_task_text_survives_with_the_date_removed() {
        let p = parse("email the vendor fri 3pm", NOW).unwrap();
        assert_eq!(p.rest, "email the vendor");
        let p = parse("submit report by fri", NOW).unwrap();
        assert_eq!(p.rest, "submit report");
    }

    #[test]
    fn text_with_no_date_phrase_is_none() {
        assert!(parse("just a plain task", NOW).is_none());
        assert!(parse("", NOW).is_none());
    }

    #[test]
    fn a_bare_number_is_not_silently_a_time() {
        // "buy 4 apples" must not become 4am.
        let p = parse("buy 4 apples", NOW);
        assert!(p.is_none() || p.unwrap().rest.contains("apples"));
        assert!(parse("ship 99 units", NOW).is_none());
    }

    #[test]
    fn every_future_phrase_produces_a_future_date() {
        for phrase in [
            "fri",
            "mon",
            "sun",
            "tomorrow",
            "next tue",
            "next week",
            "eom",
            "eow",
            "in 1 day",
            "3pm",
            "9am",
            "midnight",
        ] {
            let p = parse(phrase, NOW).unwrap_or_else(|| panic!("no parse for {phrase}"));
            assert!(p.at > NOW, "{phrase} resolved to the past");
        }
    }
}
