//! Integration tests against real pages, checked in verbatim.
//!
//! `techcrunch-ai-category.html` is the page that crashed a shipped build:
//! the scanner sliced a `&str` at a byte index that landed inside a `·` in a
//! CSS `content:"···"` rule at byte 26523. Unit tests with hand-written
//! markup never produce a document like this, which is why the real bytes
//! are here.

use tabs_core::feed::discover;

const TECHCRUNCH: &str = include_str!("fixtures/techcrunch-ai-category.html");
const BASE: &str = "https://techcrunch.com/category/artificial-intelligence/";

#[test]
fn the_page_that_crashed_parses_without_panicking() {
    let candidates = discover::from_html(TECHCRUNCH, BASE);
    assert!(!candidates.is_empty(), "TechCrunch advertises two feeds");
}

#[test]
fn the_fixture_really_does_contain_the_bytes_that_broke_it() {
    // A guard on the fixture itself: if someone re-saves it as ASCII the
    // regression test above silently stops testing anything.
    assert!(
        TECHCRUNCH.bytes().any(|b| b > 127),
        "fixture must retain its multi-byte characters"
    );
    assert!(
        TECHCRUNCH.contains('·'),
        "the exact character that panicked"
    );
}

#[test]
fn pasting_the_ai_category_gives_the_ai_feed_not_the_firehose() {
    let candidates = discover::from_html(TECHCRUNCH, BASE);
    assert_eq!(
        candidates[0].url, "https://techcrunch.com/category/artificial-intelligence/feed/",
        "someone who pasted the AI section asked for AI, not everything"
    );
    // The site-wide feed is still offered, just not first.
    assert!(candidates
        .iter()
        .any(|c| c.url == "https://techcrunch.com/feed/"));
}

#[test]
fn scanning_is_stable_at_every_truncation_point() {
    // Truncating mid-character is exactly what a partial fetch looks like.
    // None of these may panic; a wrong answer is fine, a crash is not.
    for cut in (0..TECHCRUNCH.len()).step_by(997) {
        let mut end = cut;
        while end < TECHCRUNCH.len() && !TECHCRUNCH.is_char_boundary(end) {
            end += 1;
        }
        let _ = discover::from_html(&TECHCRUNCH[..end], BASE);
    }
}

#[test]
fn a_feed_document_is_told_apart_from_a_web_page() {
    assert!(!discover::looks_like_feed(TECHCRUNCH));
}

/// A realistic Google Calendar export, in the shapes it actually emits.
const GOOGLE_ICS: &str = "\
BEGIN:VCALENDAR\r\n\
PRODID:-//Google Inc//Google Calendar 70.9054//EN\r\n\
VERSION:2.0\r\n\
X-WR-TIMEZONE:Asia/Singapore\r\n\
BEGIN:VTIMEZONE\r\n\
TZID:Asia/Singapore\r\n\
BEGIN:STANDARD\r\n\
TZOFFSETFROM:+0800\r\n\
TZOFFSETTO:+0800\r\n\
TZNAME:+08\r\n\
DTSTART:19700101T000000\r\n\
END:STANDARD\r\n\
END:VTIMEZONE\r\n\
BEGIN:VEVENT\r\n\
DTSTART;TZID=Asia/Singapore:20260901T090000\r\n\
DTEND;TZID=Asia/Singapore:20260901T100000\r\n\
SUMMARY:Local timed event at 9am\r\n\
UID:a@google.com\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
DTSTART:20260901T013000Z\r\n\
DTEND:20260901T023000Z\r\n\
SUMMARY:UTC timed event\r\n\
UID:b@google.com\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
DTSTART;VALUE=DATE:20260902\r\n\
DTEND;VALUE=DATE:20260903\r\n\
SUMMARY:All day event\r\n\
UID:c@google.com\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

#[test]
fn a_real_google_export_parses_to_the_right_instants() {
    // Window: all of September 2026.
    let from = 1_788_220_800; // 2026-09-01T00:00:00Z
    let events = tabs_core::ical::parse(GOOGLE_ICS, from - 86_400, from + 10 * 86_400);
    assert_eq!(events.len(), 3, "all three shapes must parse");

    let by = |name: &str| {
        events
            .iter()
            .find(|e| e.summary.contains(name))
            .unwrap_or_else(|| panic!("missing {name}"))
    };

    // A TZID= local time is wall clock: stamped as if UTC and flagged, so the
    // UI shows 09:00 without converting it a second time.
    let local = by("Local timed");
    assert!(local.floating, "TZID= must be flagged floating");
    assert_eq!(
        local.start,
        1_788_220_800 + 9 * 3600,
        "09:00 read as wall clock"
    );

    // A Z-suffixed time is a real instant and must NOT be flagged.
    let utc = by("UTC timed");
    assert!(!utc.floating);
    assert_eq!(utc.start, 1_788_220_800 + 90 * 60);

    // VALUE=DATE is all-day, midnight, a whole day long.
    let allday = by("All day");
    assert!(allday.all_day);
    assert_eq!(allday.end - allday.start, 86_400);
}

#[test]
fn the_vtimezone_block_is_not_mistaken_for_an_event() {
    // VTIMEZONE contains its own DTSTART:19700101T000000. Reading it as an
    // event would put a phantom entry at the epoch.
    let events = tabs_core::ical::parse(GOOGLE_ICS, 0, 2_000_000_000);
    assert!(
        events.iter().all(|e| e.start > 1_000_000_000),
        "a 1970 entry means VTIMEZONE leaked into the event list"
    );
}
