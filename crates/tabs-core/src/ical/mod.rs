//! ICS calendar subscriptions (milestone M7).
//!
//! One parser covers Google, Outlook, iCloud, Fastmail, Proton, Notion,
//! Linear and Cal.com, because they all publish the same iCalendar file.
//! That is decision D7: no OAuth, no per-provider integration, no backend.
//!
//! **Timezone scope, stated plainly.** UTC (`Z`-suffixed) and date-only
//! values are exact. A `TZID=` local time is read as wall-clock and treated
//! as UTC, because carrying real VTIMEZONE rules would mean shipping a
//! zone database in the wasm bundle. In practice the display is "next up in
//! N hours", and the error is bounded by the user's own offset — the field
//! `floating` marks these so the UI can render them as wall-clock times
//! rather than converting.

use serde::{Deserialize, Serialize};

const DAY: i64 = 86_400;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub uid: String,
    pub summary: String,
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    /// True when the time came from a `TZID=` local value — see module docs.
    pub floating: bool,
    /// The IANA zone named by `DTSTART;TZID=`, when there was one.
    ///
    /// Carried rather than resolved: a zone database has no business in a
    /// wasm bundle, and the browser already ships one. The renderer converts
    /// with `Intl`, which is how an event written in New York shows at the
    /// right hour for a reader in Singapore.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tzid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Meet/Zoom/Teams URL pulled out of location, description or the
    /// Google-specific `X-GOOGLE-CONFERENCE` property. The most-used control
    /// in any calendar widget.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub join_url: Option<String>,
}

/// Unfold RFC 5545 line continuations: a line beginning with space or tab
/// continues the previous one. Long URLs are folded constantly, so skipping
/// this loses exactly the join links we most want.
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if (line.starts_with(' ') || line.starts_with('\t')) && !out.is_empty() {
            out.last_mut().unwrap().push_str(&line[1..]);
        } else {
            out.push(line.to_string());
        }
    }
    out
}

/// A content line: property name, its parameters, and its value.
type ContentLine = (String, Vec<(String, String)>, String);

/// Split `DTSTART;TZID=Asia/Singapore:20260830T090000` into name, params, value.
fn split_line(line: &str) -> Option<ContentLine> {
    let colon = find_unquoted_colon(line)?;
    let (head, value) = line.split_at(colon);
    let mut parts = head.split(';');
    let name = parts.next()?.to_ascii_uppercase();
    let params = parts
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.to_ascii_uppercase(), v.trim_matches('"').to_string()))
        .collect();
    Some((name, params, unescape(&value[1..])))
}

fn find_unquoted_colon(s: &str) -> Option<usize> {
    let mut quoted = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some(i),
            _ => {}
        }
    }
    None
}

fn unescape(v: &str) -> String {
    v.replace("\\n", "\n")
        .replace("\\N", "\n")
        .replace("\\,", ",")
        .replace(r"\;", ";")
        .replace("\\\\", "\\")
}

/// `20260830T140000Z`, `20260830T140000`, or `20260830`.
fn parse_dt(value: &str) -> Option<(i64, bool, bool)> {
    let v = value.trim();
    let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let y: i64 = digits[0..4].parse().ok()?;
    let mo: i64 = digits[4..6].parse().ok()?;
    let d: i64 = digits[6..8].parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    if digits.len() < 14 {
        return Some((civil_to_unix(y, mo, d, 0, 0, 0), true, false));
    }
    let h: i64 = digits[8..10].parse().ok()?;
    let mi: i64 = digits[10..12].parse().ok()?;
    let s: i64 = digits[12..14].parse().ok()?;
    let utc = v.ends_with('Z') || v.ends_with('z');
    Some((civil_to_unix(y, mo, d, h, mi, s), false, !utc))
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn civil_to_unix(y: i64, m: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
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
    (days + d - 1) * DAY + h * 3600 + mi * 60 + s
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

/// Day of week, 0 = Monday (ISO). 1970-01-01 was a Thursday.
fn weekday(t: i64) -> i64 {
    (t.div_euclid(DAY) + 3).rem_euclid(7)
}

fn weekday_code(c: &str) -> Option<i64> {
    match c {
        "MO" => Some(0),
        "TU" => Some(1),
        "WE" => Some(2),
        "TH" => Some(3),
        "FR" => Some(4),
        "SA" => Some(5),
        "SU" => Some(6),
        _ => None,
    }
}

fn add_months(t: i64, n: i64) -> i64 {
    let (y, m, d) = unix_to_civil(t);
    let tod = t.rem_euclid(DAY);
    let total = (y * 12 + m - 1) + n;
    let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    let max_d = [
        31,
        if is_leap(ny) { 29 } else { 28 },
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
    ][(nm - 1) as usize];
    civil_to_unix(ny, nm, d.min(max_d), 0, 0, 0) + tod
}

#[derive(Debug, Default, Clone)]
struct Rrule {
    freq: String,
    interval: i64,
    count: Option<usize>,
    until: Option<i64>,
    /// `(ordinal, weekday)` — `3TU` is `(Some(3), 1)`, `-1FR` is `(Some(-1), 4)`,
    /// a bare `TU` is `(None, 1)`. The ordinal was previously stripped and
    /// thrown away, which made `FREQ=MONTHLY;BYDAY=3TU` unexpressible.
    byday: Vec<(Option<i64>, i64)>,
    bymonth: Vec<i64>,
    bymonthday: Vec<i64>,
    /// Week start, 0 = Monday. Decides which dates fall in "the same week".
    wkst: i64,
}

fn parse_rrule(v: &str) -> Option<Rrule> {
    let mut r = Rrule {
        interval: 1,
        ..Default::default()
    };
    for part in v.split(';') {
        let (k, val) = part.split_once('=')?;
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => r.freq = val.to_ascii_uppercase(),
            "INTERVAL" => r.interval = val.parse().unwrap_or(1).max(1),
            "COUNT" => r.count = val.parse().ok(),
            "UNTIL" => r.until = parse_dt(val).map(|(t, _, _)| t),
            "WKST" => r.wkst = weekday_code(val).unwrap_or(0),
            "BYMONTH" => {
                r.bymonth = val
                    .split(',')
                    .filter_map(|m| m.trim().parse().ok())
                    .collect()
            }
            "BYMONTHDAY" => {
                r.bymonthday = val
                    .split(',')
                    .filter_map(|m| m.trim().parse().ok())
                    .collect()
            }
            "BYDAY" => {
                r.byday = val
                    .split(',')
                    .filter_map(|d| {
                        let d = d.trim();
                        let split = d.len().saturating_sub(2);
                        let (ord, code) = d.split_at(split);
                        let weekday = weekday_code(code)?;
                        let ordinal = if ord.is_empty() {
                            None
                        } else {
                            ord.parse::<i64>().ok()
                        };
                        Some((ordinal, weekday))
                    })
                    .collect()
            }
            _ => {}
        }
    }
    (!r.freq.is_empty()).then_some(r)
}

/// Midnight on the first day of the week containing `t`.
///
/// Midnight specifically: callers add the occurrence's own time-of-day, and
/// returning `t` minus whole days would keep the original time and count it
/// twice.
fn week_start(t: i64, wkst: i64) -> i64 {
    let midnight = t.div_euclid(DAY) * DAY;
    let days_in = (weekday(midnight) - wkst).rem_euclid(7);
    midnight - days_in * DAY
}

/// The date of the `ord`-th `wd` in a month. Negative counts from the end, so
/// `-1` is the last one. `None` when the month has no such occurrence — a
/// fifth Tuesday does not exist in most months.
fn nth_weekday(y: i64, m: i64, wd: i64, ord: i64, tod: i64) -> Option<i64> {
    let first = civil_to_unix(y, m, 1, 0, 0, 0);
    let len = [
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
    ][(m.clamp(1, 12) - 1) as usize];

    let mut matches = Vec::new();
    for d in 0..len {
        let t = first + d * DAY;
        if weekday(t) == wd {
            matches.push(t + tod);
        }
    }
    let idx = if ord > 0 {
        (ord - 1) as usize
    } else {
        let back = (-ord) as usize;
        matches.len().checked_sub(back)?
    };
    matches.get(idx).copied()
}

/// Does `cursor` match one of the cancelled/overridden instants?
///
/// Exact equality is not enough in practice. A calendar may write `DTSTART`
/// with a `TZID=` local time while writing the matching `EXDATE` or
/// `RECURRENCE-ID` as a `Z`-suffixed instant — the same occurrence, stamped
/// two different ways, differing by the zone offset. Without VTIMEZONE
/// arithmetic those never compare equal, and the cancelled occurrence keeps
/// appearing.
///
/// For anything recurring daily or slower, two occurrences of one series
/// never share a calendar date, so matching on the date is unambiguous and
/// survives the mismatch. Sub-daily rules keep exact matching, where the date
/// alone would wrongly suppress every occurrence that day.
fn is_excluded(cursor: i64, excluded: &[i64], freq: &str) -> bool {
    if excluded.contains(&cursor) {
        return true;
    }
    let coarse = matches!(freq, "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY");
    if !coarse {
        return false;
    }
    let day = |t: i64| t.div_euclid(DAY);
    excluded.iter().any(|e| {
        // Within a day of each other *and* on the same or an adjacent date:
        // a zone offset can never exceed 14 hours.
        (e - cursor).abs() <= 14 * 3600 && (day(*e) - day(cursor)).abs() <= 1
    })
}

/// Expand a recurrence into occurrences within `[from, to]`.
///
/// Walks *periods* — days, weeks, months, years — stepping by `INTERVAL`, and
/// enumerates the candidate dates inside each. The previous version advanced a
/// single cursor one day at a time and filtered by weekday, which silently
/// dropped `INTERVAL` for `FREQ=WEEKLY;BYDAY=…`: a quarterly meeting written
/// as `FREQ=WEEKLY;INTERVAL=13` came out weekly.
///
/// Bounded twice — by the window and by an iteration cap — because a malformed
/// rule with neither `COUNT` nor `UNTIL` is otherwise an infinite loop inside
/// a service worker.
fn expand(start: i64, rule: &Rrule, exdates: &[i64], from: i64, to: i64) -> Vec<i64> {
    const MAX_PERIODS: usize = 1200;
    let tod = start.rem_euclid(DAY);
    let mut out = Vec::new();
    let mut emitted = 0usize;
    let mut anchor = start;

    for _ in 0..MAX_PERIODS {
        let mut candidates = candidates_in_period(anchor, rule, tod);
        candidates.sort_unstable();
        candidates.dedup();

        for c in candidates {
            // A rule never produces anything before its own DTSTART.
            if c < start {
                continue;
            }
            if rule.until.is_some_and(|u| c > u) {
                return out;
            }
            // COUNT counts what the rule generates, including occurrences
            // outside the requested window — otherwise a narrow window would
            // let the series run past its own limit.
            emitted += 1;
            if rule.count.is_some_and(|n| emitted > n) {
                return out;
            }
            if c >= from && c <= to && !is_excluded(c, exdates, &rule.freq) {
                out.push(c);
            }
        }

        if anchor > to {
            break;
        }
        anchor = match rule.freq.as_str() {
            "DAILY" => anchor + DAY * rule.interval,
            "WEEKLY" => anchor + 7 * DAY * rule.interval,
            "MONTHLY" => add_months(anchor, rule.interval),
            "YEARLY" => add_months(anchor, 12 * rule.interval),
            "HOURLY" => anchor + 3600 * rule.interval,
            "MINUTELY" => anchor + 60 * rule.interval,
            _ => break,
        };
    }
    out
}

/// The dates a rule produces within the period containing `anchor`.
fn candidates_in_period(anchor: i64, rule: &Rrule, tod: i64) -> Vec<i64> {
    let (y, m, _) = unix_to_civil(anchor);

    match rule.freq.as_str() {
        "WEEKLY" if !rule.byday.is_empty() => {
            // Every named weekday inside *this* week only, so INTERVAL still
            // governs which weeks are visited at all.
            let ws = week_start(anchor, rule.wkst);
            rule.byday
                .iter()
                .map(|(_, wd)| ws + (wd - rule.wkst).rem_euclid(7) * DAY + tod)
                .collect()
        }
        "MONTHLY" | "YEARLY" if !rule.byday.is_empty() => {
            let months: Vec<i64> = if rule.freq == "YEARLY" && !rule.bymonth.is_empty() {
                rule.bymonth.clone()
            } else {
                vec![m]
            };
            let mut out = Vec::new();
            for mm in months {
                for (ord, wd) in &rule.byday {
                    match ord {
                        Some(n) => out.extend(nth_weekday(y, mm, *wd, *n, tod)),
                        // No ordinal: every such weekday in the month.
                        None => {
                            for n in 1..=5 {
                                out.extend(nth_weekday(y, mm, *wd, n, tod));
                            }
                        }
                    }
                }
            }
            out
        }
        "MONTHLY" | "YEARLY" if !rule.bymonthday.is_empty() => rule
            .bymonthday
            .iter()
            .filter_map(|d| {
                let day = if *d > 0 {
                    *d
                } else {
                    days_in_month(y, m) + d + 1
                };
                (day >= 1 && day <= days_in_month(y, m))
                    .then(|| civil_to_unix(y, m, day, 0, 0, 0) + tod)
            })
            .collect(),
        // No BY* parts: the period's anchor is the occurrence.
        _ => vec![anchor],
    }
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

fn find_join_url(fields: &[&str]) -> Option<String> {
    const HOSTS: &[&str] = &[
        "meet.google.com",
        "zoom.us",
        "teams.microsoft.com",
        "teams.live.com",
        "whereby.com",
        "meet.jit.si",
        "webex.com",
        "around.co",
        "riverside.fm",
    ];
    for f in fields {
        for token in f.split(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"') {
            let t = token.trim_end_matches(['.', ',', ')', ']']);
            if t.starts_with("http") && HOSTS.iter().any(|h| t.contains(h)) {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Parse an ICS document into occurrences inside `[from, to]`, sorted.
/// `UID -> RECURRENCE-ID` for every instance a calendar has rescheduled.
///
/// Collected in a first pass because the override VEVENT can appear either
/// before or after the series it modifies, and the series cannot be expanded
/// correctly without knowing which of its occurrences have been replaced.
fn collect_overrides(text: &str) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    let mut uid = String::new();
    let mut rid: Option<i64> = None;
    for line in unfold(text) {
        let upper = line.trim().to_ascii_uppercase();
        if upper == "BEGIN:VEVENT" {
            uid.clear();
            rid = None;
            continue;
        }
        if upper == "END:VEVENT" {
            if let Some(r) = rid.take() {
                out.push((uid.clone(), r));
            }
            continue;
        }
        if let Some((name, _, value)) = split_line(&line) {
            match name.as_str() {
                "UID" => uid = value,
                "RECURRENCE-ID" => rid = parse_dt(&value).map(|(t, _, _)| t),
                _ => {}
            }
        }
    }
    out
}

pub fn parse(text: &str, from: i64, to: i64) -> Vec<Event> {
    let overrides = collect_overrides(text);
    parse_inner(text, from, to, &overrides)
}

fn parse_inner(text: &str, from: i64, to: i64, overrides: &[(String, i64)]) -> Vec<Event> {
    let lines = unfold(text);
    let mut events = Vec::new();
    let mut in_event = false;
    let (mut uid, mut summary, mut location, mut description, mut conference) = (
        String::new(),
        String::new(),
        None::<String>,
        String::new(),
        None::<String>,
    );
    let (mut start, mut end) = (None::<(i64, bool, bool)>, None::<(i64, bool, bool)>);
    let mut tzid: Option<String> = None;
    let (mut rrule, mut exdates) = (None::<Rrule>, Vec::<i64>::new());
    let mut cancelled = false;

    for line in &lines {
        let upper = line.trim().to_ascii_uppercase();
        if upper == "BEGIN:VEVENT" {
            in_event = true;
            uid.clear();
            summary.clear();
            cancelled = false;
            tzid = None;
            description.clear();
            location = None;
            conference = None;
            start = None;
            end = None;
            rrule = None;
            exdates.clear();
            continue;
        }
        if upper == "END:VEVENT" {
            in_event = false;
            // A cancelled instance is described, not omitted — rendering it
            // would put a meeting on the calendar that is not happening.
            if cancelled {
                continue;
            }
            let Some((s, all_day, floating)) = start else {
                continue;
            };
            let dur =
                end.map(|(e, _, _)| (e - s).max(0))
                    .unwrap_or(if all_day { DAY } else { 3600 });
            let join_url = conference.clone().or_else(|| {
                find_join_url(&[location.as_deref().unwrap_or(""), &description, &summary])
            });

            let starts = match &rrule {
                Some(r) => {
                    // Drop occurrences a RECURRENCE-ID override replaces. A
                    // moved meeting is described as two components — the
                    // original series and a separate VEVENT for the instance
                    // that moved — so expanding the series alone shows it on
                    // the days it *was* going to happen as well as the day it
                    // actually does.
                    let mut skip: Vec<i64> = exdates.clone();
                    for (o_uid, o_at) in overrides {
                        if *o_uid == uid {
                            skip.push(*o_at);
                        }
                    }
                    expand(s, r, &skip, from, to)
                }
                None => (s <= to && s + dur >= from)
                    .then_some(s)
                    .into_iter()
                    .collect(),
            };
            for st in starts {
                events.push(Event {
                    uid: uid.clone(),
                    summary: if summary.is_empty() {
                        "(no title)".into()
                    } else {
                        summary.clone()
                    },
                    start: st,
                    end: st + dur,
                    all_day,
                    floating,
                    location: location.clone(),
                    join_url: join_url.clone(),
                    tzid: tzid.clone(),
                });
            }
            continue;
        }
        if !in_event {
            continue;
        }
        let Some((name, params, value)) = split_line(line) else {
            continue;
        };
        match name.as_str() {
            "UID" => uid = value,
            "SUMMARY" => summary = value,
            "LOCATION" => location = Some(value).filter(|v| !v.is_empty()),
            "DESCRIPTION" => description = value,
            "DTSTART" => {
                start = parse_dt(&value);
                tzid = params
                    .iter()
                    .find(|(k, _)| k == "TZID")
                    .map(|(_, v)| v.clone())
                    .filter(|v| !v.is_empty());
            }
            "DTEND" => end = parse_dt(&value),
            "RRULE" => rrule = parse_rrule(&value),
            "STATUS" => cancelled = value.eq_ignore_ascii_case("CANCELLED"),
            "EXDATE" => exdates.extend(
                value
                    .split(',')
                    .filter_map(|v| parse_dt(v).map(|(t, _, _)| t)),
            ),
            "DURATION" => {
                if let (Some((s, _, _)), Some(d)) = (start, parse_duration(&value)) {
                    end = Some((s + d, false, false));
                }
            }
            n if n.starts_with("X-GOOGLE-CONFERENCE") => conference = Some(value),
            _ => {
                let _ = &params;
            }
        }
    }
    events.sort_by_key(|e| (e.start, e.uid.clone()));
    // One meeting, once. A series occurrence and a RECURRENCE-ID override can
    // legitimately land on the same instant; listing both reports a fact
    // about the file format, not about the reader's day.
    events.dedup_by(|a, b| a.uid == b.uid && a.start == b.start);
    events
}

/// ISO 8601 duration, the subset calendars emit: `PT1H30M`, `P1D`.
fn parse_duration(v: &str) -> Option<i64> {
    let s = v.trim().strip_prefix('P')?;
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, t),
        None => (s, ""),
    };
    let mut total = 0i64;
    let mut num = String::new();
    for c in date.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else {
            let n: i64 = num.parse().unwrap_or(0);
            num.clear();
            total += match c {
                'D' => n * DAY,
                'W' => n * 7 * DAY,
                _ => 0,
            };
        }
    }
    for c in time.chars() {
        if c.is_ascii_digit() {
            num.push(c);
        } else {
            let n: i64 = num.parse().unwrap_or(0);
            num.clear();
            total += match c {
                'H' => n * 3600,
                'M' => n * 60,
                'S' => n,
                _ => 0,
            };
        }
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 2026-08-30T00:00:00Z
    const AUG30: i64 = 1_788_048_000;

    fn ics(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}\r\nEND:VCALENDAR\r\n")
    }

    #[test]
    fn parses_a_single_timed_event() {
        let e = parse(
            &ics("BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Standup\r\nDTSTART:20260830T090000Z\r\nDTEND:20260830T093000Z\r\nEND:VEVENT"),
            AUG30 - DAY,
            AUG30 + DAY,
        );
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].summary, "Standup");
        assert_eq!(e[0].end - e[0].start, 1800);
        assert!(!e[0].all_day && !e[0].floating);
    }

    #[test]
    fn folded_lines_are_rejoined_so_join_urls_survive() {
        // Providers fold long URLs; not unfolding loses the link entirely.
        let body = "BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Sync\r\nDTSTART:20260830T090000Z\r\n\
                    DESCRIPTION:Join at https://meet.google.com/abc\r\n -defg-hij\r\nEND:VEVENT";
        let e = parse(&ics(body), AUG30 - DAY, AUG30 + DAY);
        assert_eq!(
            e[0].join_url.as_deref(),
            Some("https://meet.google.com/abc-defg-hij")
        );
    }

    #[test]
    fn finds_zoom_and_teams_links_in_location() {
        for (url, _) in [
            ("https://zoom.us/j/123456", "zoom"),
            ("https://teams.microsoft.com/l/meetup-join/x", "teams"),
        ] {
            let body = format!(
                "BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:M\r\nDTSTART:20260830T090000Z\r\nLOCATION:{url}\r\nEND:VEVENT"
            );
            assert_eq!(
                parse(&ics(&body), AUG30 - DAY, AUG30 + DAY)[0]
                    .join_url
                    .as_deref(),
                Some(url)
            );
        }
    }

    #[test]
    fn all_day_events_are_marked_and_last_a_day() {
        let e = parse(
            &ics("BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260830\r\nEND:VEVENT"),
            AUG30 - DAY,
            AUG30 + DAY,
        );
        assert!(e[0].all_day);
        assert_eq!(e[0].end - e[0].start, DAY);
    }

    #[test]
    fn daily_recurrence_expands_within_the_window_only() {
        let body = "BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Daily\r\nDTSTART:20260830T090000Z\r\n\
                    RRULE:FREQ=DAILY;COUNT=10\r\nEND:VEVENT";
        // Window ends at AUG30+3d; the 09:00 occurrence on day 3 falls
        // outside it, so three occurrences is correct.
        let e = parse(&ics(body), AUG30, AUG30 + 3 * DAY);
        assert_eq!(e.len(), 3);
        assert_eq!(e[1].start - e[0].start, DAY);
    }

    #[test]
    fn weekly_byday_picks_the_right_weekdays() {
        // 2026-08-30 is a Sunday; Mon/Wed of the following week.
        let body = "BEGIN:VEVENT\r\nUID:f\r\nSUMMARY:MW\r\nDTSTART:20260830T090000Z\r\n\
                    RRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nEND:VEVENT";
        let e = parse(&ics(body), AUG30, AUG30 + 7 * DAY);
        assert!(!e.is_empty());
        for occ in &e {
            let wd = weekday(occ.start);
            assert!(wd == 0 || wd == 2, "unexpected weekday {wd}");
        }
    }

    #[test]
    fn exdate_removes_a_cancelled_occurrence() {
        let body = "BEGIN:VEVENT\r\nUID:g\r\nSUMMARY:D\r\nDTSTART:20260830T090000Z\r\n\
                    RRULE:FREQ=DAILY;COUNT=5\r\nEXDATE:20260831T090000Z\r\nEND:VEVENT";
        let e = parse(&ics(body), AUG30, AUG30 + 5 * DAY);
        assert!(e.iter().all(|x| x.start != AUG30 + DAY + 9 * 3600));
    }

    #[test]
    fn until_stops_the_series() {
        let body = "BEGIN:VEVENT\r\nUID:h\r\nSUMMARY:D\r\nDTSTART:20260830T090000Z\r\n\
                    RRULE:FREQ=DAILY;UNTIL=20260901T000000Z\r\nEND:VEVENT";
        let e = parse(&ics(body), AUG30, AUG30 + 30 * DAY);
        assert_eq!(e.len(), 2);
    }

    #[test]
    fn a_meeting_moved_to_one_date_does_not_also_show_on_the_old_ones() {
        // The reported bug: an event the reader sees only on 15 Sep appeared
        // on 1, 8 and 15 Sep. A moved instance is two components — the weekly
        // series, and an override VEVENT carrying RECURRENCE-ID — so
        // expanding the series alone shows every date it was going to fall on.
        let body = "BEGIN:VEVENT\r\nUID:series@g\r\nSUMMARY:LnFi x UTXO Quarterly\r\n\
                    DTSTART:20260901T150000Z\r\nDTEND:20260901T160000Z\r\n\
                    RRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:series@g\r\nRECURRENCE-ID:20260901T150000Z\r\n\
                    SUMMARY:LnFi x UTXO Quarterly\r\nDTSTART:20260922T150000Z\r\n\
                    DTEND:20260922T160000Z\r\nEND:VEVENT";
        let sep = 1_788_220_800; // 2026-09-01T00:00:00Z
        let e = parse(&ics(body), sep - 86_400, sep + 30 * DAY);

        let starts: Vec<i64> = e.iter().map(|x| x.start).collect();
        assert!(
            !starts.contains(&(sep + 15 * 3600)),
            "1 Sep was replaced by the override and must not appear"
        );
        // 8 Sep is a genuine occurrence of the series and stays.
        assert!(starts.contains(&(sep + 7 * DAY + 15 * 3600)));
        // And the moved instance appears once, on the day it was moved to.
        assert_eq!(
            starts
                .iter()
                .filter(|t| **t == sep + 21 * DAY + 15 * 3600)
                .count(),
            1
        );
    }

    #[test]
    fn the_same_meeting_is_never_listed_twice_at_the_same_time() {
        // A series occurrence and an override can legitimately coincide; the
        // reader should see one meeting, not two.
        let body = "BEGIN:VEVENT\r\nUID:s@g\r\nSUMMARY:Weekly\r\n\
                    DTSTART:20260901T150000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:s@g\r\nRECURRENCE-ID:20260901T150000Z\r\n\
                    SUMMARY:Weekly\r\nDTSTART:20260915T150000Z\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep - DAY, sep + 30 * DAY);
        let fifteenth = sep + 14 * DAY + 15 * 3600;
        assert_eq!(
            e.iter().filter(|x| x.start == fifteenth).count(),
            1,
            "one meeting on the 15th, not two"
        );
    }

    #[test]
    fn an_exdate_written_in_utc_still_cancels_a_tzid_occurrence() {
        // Google writes DTSTART with TZID= and the matching EXDATE as a
        // Z-suffixed instant. Compared exactly, they differ by the zone
        // offset and the cancelled occurrence keeps showing up.
        let body = "BEGIN:VEVENT\r\nUID:m@g\r\nSUMMARY:Weekly\r\n\
                    DTSTART;TZID=Asia/Singapore:20260901T150000\r\n\
                    RRULE:FREQ=WEEKLY;COUNT=3\r\n\
                    EXDATE:20260901T070000Z\r\nEND:VEVENT";
        let sep = 1_788_220_800; // 2026-09-01T00:00:00Z
        let e = parse(&ics(body), sep - DAY, sep + 30 * DAY);
        assert_eq!(e.len(), 2, "the first occurrence was cancelled");
        assert!(
            e.iter().all(|x| x.start > sep + DAY),
            "1 Sep must not survive an EXDATE written in another frame"
        );
    }

    #[test]
    fn a_recurrence_id_in_utc_still_replaces_a_tzid_occurrence() {
        let body = "BEGIN:VEVENT\r\nUID:r@g\r\nSUMMARY:Weekly\r\n\
                    DTSTART;TZID=Asia/Singapore:20260901T150000\r\n\
                    RRULE:FREQ=WEEKLY;COUNT=3\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:r@g\r\nRECURRENCE-ID:20260901T070000Z\r\n\
                    SUMMARY:Weekly\r\nDTSTART;TZID=Asia/Singapore:20260929T150000\r\n\
                    END:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep - DAY, sep + 40 * DAY);
        let firsts = e.iter().filter(|x| x.start < sep + DAY).count();
        assert_eq!(firsts, 0, "the replaced occurrence must not remain");
    }

    #[test]
    fn a_sub_daily_rule_still_matches_exactly() {
        // Matching by date would delete every occurrence that day.
        let body = "BEGIN:VEVENT\r\nUID:h@g\r\nSUMMARY:Hourly\r\n\
                    DTSTART:20260901T000000Z\r\nRRULE:FREQ=HOURLY;COUNT=5\r\n\
                    EXDATE:20260901T020000Z\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep - DAY, sep + DAY);
        assert_eq!(e.len(), 4, "one of five removed, not all five");
    }

    #[test]
    fn a_cancelled_instance_is_not_shown() {
        let body = "BEGIN:VEVENT\r\nUID:c@g\r\nSUMMARY:Called off\r\n\
                    DTSTART:20260901T150000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        assert!(parse(&ics(body), sep - DAY, sep + DAY).is_empty());
    }

    #[test]
    fn a_confirmed_status_is_not_mistaken_for_a_cancellation() {
        let body = "BEGIN:VEVENT\r\nUID:k@g\r\nSUMMARY:Going ahead\r\n\
                    DTSTART:20260901T150000Z\r\nSTATUS:CONFIRMED\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        assert_eq!(parse(&ics(body), sep - DAY, sep + DAY).len(), 1);
    }

    #[test]
    fn an_override_for_a_different_series_does_not_suppress_this_one() {
        // Matching on RECURRENCE-ID alone, ignoring UID, would delete an
        // unrelated meeting that happens to start at the same time.
        let body = "BEGIN:VEVENT\r\nUID:mine@g\r\nSUMMARY:Mine\r\n\
                    DTSTART:20260901T150000Z\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\nEND:VEVENT\r\n\
                    BEGIN:VEVENT\r\nUID:theirs@g\r\nRECURRENCE-ID:20260901T150000Z\r\n\
                    SUMMARY:Theirs\r\nDTSTART:20260920T150000Z\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep - DAY, sep + 30 * DAY);
        assert!(
            e.iter()
                .any(|x| x.summary == "Mine" && x.start == sep + 15 * 3600),
            "another series' override must not cancel this one"
        );
    }

    #[test]
    fn a_quarterly_meeting_does_not_come_out_weekly() {
        // The reported bug: "LnFi x UTXO Quarterly" appeared on 1, 8, 15 and
        // 22 September. FREQ=WEEKLY with BYDAY advanced one day at a time and
        // ignored INTERVAL entirely, so every Tuesday matched.
        let body = "BEGIN:VEVENT\r\nUID:q@g\r\nSUMMARY:Quarterly\r\n\
                    DTSTART:20260901T030000Z\r\n\
                    RRULE:FREQ=WEEKLY;INTERVAL=13;BYDAY=TU\r\nEND:VEVENT";
        let sep = 1_788_220_800; // 2026-09-01, a Tuesday
        let e = parse(&ics(body), sep - DAY, sep + 60 * DAY);
        assert_eq!(e.len(), 1, "13-week interval means once, not five times");
        assert_eq!(e[0].start, sep + 3 * 3600);
    }

    #[test]
    fn a_weekly_interval_is_honoured_with_byday() {
        let body = "BEGIN:VEVENT\r\nUID:f@g\r\nSUMMARY:Fortnightly\r\n\
                    DTSTART:20260901T030000Z\r\n\
                    RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep - DAY, sep + 40 * DAY);
        let gaps: Vec<i64> = e
            .windows(2)
            .map(|w| (w[1].start - w[0].start) / DAY)
            .collect();
        assert!(
            gaps.iter().all(|g| *g == 14),
            "every fortnight, not every week: {gaps:?}"
        );
    }

    #[test]
    fn a_plain_weekly_rule_still_runs_weekly() {
        let body = "BEGIN:VEVENT\r\nUID:w@g\r\nSUMMARY:Weekly\r\n\
                    DTSTART:20260901T030000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=TU\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        // The window must reach past the fourth occurrence's 03:00, not stop
        // at midnight on its day.
        let e = parse(&ics(body), sep - DAY, sep + 22 * DAY);
        assert_eq!(e.len(), 4);
        assert!(e.windows(2).all(|w| w[1].start - w[0].start == 7 * DAY));
    }

    #[test]
    fn the_third_tuesday_of_every_third_month() {
        // The other way a quarterly meeting is written, and one the old
        // parser could not express at all: it stripped the ordinal off 3TU.
        let body = "BEGIN:VEVENT\r\nUID:m@g\r\nSUMMARY:Third Tuesday\r\n\
                    DTSTART:20260915T030000Z\r\n\
                    RRULE:FREQ=MONTHLY;INTERVAL=3;BYDAY=3TU\r\nEND:VEVENT";
        let sep15 = 1_788_220_800 + 14 * DAY; // 2026-09-15, the third Tuesday
        let e = parse(&ics(body), sep15 - DAY, sep15 + 200 * DAY);
        assert!(e.len() >= 2, "should recur quarterly");
        for occ in &e {
            assert_eq!(weekday(occ.start), 1, "always a Tuesday");
            let (_, _, d) = unix_to_civil(occ.start);
            assert!(
                (15..=21).contains(&d),
                "third Tuesday falls on the 15th-21st, got {d}"
            );
        }
        let months: Vec<i64> = e.iter().map(|x| unix_to_civil(x.start).1).collect();
        assert_eq!(months[1] - months[0], 3, "three months apart");
    }

    #[test]
    fn the_last_friday_of_the_month() {
        let body = "BEGIN:VEVENT\r\nUID:l@g\r\nSUMMARY:Last Friday\r\n\
                    DTSTART:20260925T030000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=-1FR\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep, sep + 100 * DAY);
        assert!(!e.is_empty());
        for occ in &e {
            assert_eq!(weekday(occ.start), 4, "a Friday");
            let (y, m, d) = unix_to_civil(occ.start);
            assert!(
                d + 7 > days_in_month(y, m),
                "must be the last one: {d} of {m}"
            );
        }
    }

    #[test]
    fn count_limits_the_series_even_when_the_window_is_narrow() {
        // COUNT bounds what the rule generates, not what the window shows.
        let body = "BEGIN:VEVENT\r\nUID:c2@g\r\nSUMMARY:Five\r\n\
                    DTSTART:20260901T030000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        // A window starting after the series ends must be empty, not restart.
        assert!(parse(&ics(body), sep + 10 * DAY, sep + 40 * DAY).is_empty());
        assert_eq!(parse(&ics(body), sep - DAY, sep + 40 * DAY).len(), 3);
    }

    #[test]
    fn a_runaway_rrule_cannot_hang_the_worker() {
        // No COUNT, no UNTIL, huge window — must terminate on the iteration cap.
        let body = "BEGIN:VEVENT\r\nUID:i\r\nSUMMARY:Forever\r\nDTSTART:20260830T090000Z\r\n\
                    RRULE:FREQ=HOURLY\r\nEND:VEVENT";
        let e = parse(&ics(body), AUG30, AUG30 + 3650 * DAY);
        assert!(e.len() <= 2000);
    }

    #[test]
    fn monthly_recurrence_clamps_short_months() {
        let body = "BEGIN:VEVENT\r\nUID:j\r\nSUMMARY:EOM\r\nDTSTART:20260131T090000Z\r\n\
                    RRULE:FREQ=MONTHLY;COUNT=3\r\nEND:VEVENT";
        let start = civil_to_unix(2026, 1, 1, 0, 0, 0);
        let e = parse(&ics(body), start, start + 120 * DAY);
        assert_eq!(e.len(), 3);
        let (_, m, d) = unix_to_civil(e[1].start);
        assert_eq!((m, d), (2, 28), "Jan 31 + 1 month clamps to Feb 28 in 2026");
    }

    #[test]
    fn duration_substitutes_for_a_missing_dtend() {
        let body = "BEGIN:VEVENT\r\nUID:k\r\nSUMMARY:D\r\nDTSTART:20260830T090000Z\r\n\
                    DURATION:PT1H30M\r\nEND:VEVENT";
        let e = parse(&ics(body), AUG30, AUG30 + DAY);
        assert_eq!(e[0].end - e[0].start, 5400);
    }

    #[test]
    fn the_named_zone_is_carried_so_the_client_can_convert() {
        // A calendar with New York events read in Singapore is only right if
        // the zone travels with the time. Resolving it here would mean a zone
        // database in the wasm bundle; the browser already has one.
        let body = "BEGIN:VEVENT\r\nUID:z@g\r\nSUMMARY:NY meeting\r\n\
                    DTSTART;TZID=America/New_York:20260901T150000\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep - DAY, sep + DAY);
        assert_eq!(e[0].tzid.as_deref(), Some("America/New_York"));
        assert!(
            e[0].floating,
            "still wall clock until the client converts it"
        );
        // The stamp is the wall clock, 15:00, not an instant.
        assert_eq!(e[0].start, sep + 15 * 3600);
    }

    #[test]
    fn a_utc_time_carries_no_zone_because_it_needs_none() {
        let body = "BEGIN:VEVENT\r\nUID:u@g\r\nSUMMARY:UTC\r\n\
                    DTSTART:20260901T150000Z\r\nEND:VEVENT";
        let sep = 1_788_220_800;
        let e = parse(&ics(body), sep - DAY, sep + DAY);
        assert_eq!(e[0].tzid, None);
        assert!(!e[0].floating);
    }

    #[test]
    fn tzid_local_times_are_flagged_floating() {
        let body = "BEGIN:VEVENT\r\nUID:l\r\nSUMMARY:Local\r\n\
                    DTSTART;TZID=Asia/Singapore:20260830T090000\r\nEND:VEVENT";
        let e = parse(&ics(body), AUG30 - DAY, AUG30 + DAY);
        assert!(e[0].floating, "the UI must know not to convert this");
    }

    #[test]
    fn escaped_commas_and_newlines_are_unescaped() {
        let body =
            "BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:A\\, B\\nC\r\nDTSTART:20260830T090000Z\r\nEND:VEVENT";
        assert_eq!(
            parse(&ics(body), AUG30 - DAY, AUG30 + DAY)[0].summary,
            "A, B\nC"
        );
    }

    #[test]
    fn an_empty_or_garbage_document_yields_nothing() {
        assert!(parse("", 0, DAY).is_empty());
        assert!(parse("not a calendar at all", 0, DAY).is_empty());
    }
}
