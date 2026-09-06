//! Most of these are about a hostile pack, because that is what a pack is
//! until proved otherwise: JSON written by someone the reader never met,
//! applied to their configuration and their stylesheet.

use super::*;
use crate::config::{default_config, Config};
use serde_json::json;

fn group(name: &str, opts: Value) -> Pack {
    Pack {
        format: PACK_FORMAT,
        kind: "group".into(),
        id: slugify(name),
        name: name.into(),
        description: "A useful set of sources for testing.".into(),
        author: "someone".into(),
        tags: vec!["ai".into()],
        instances: vec![Instance {
            def: "topic".into(),
            id: slugify(name),
            name: name.into(),
            enabled: true,
            opts,
        }],
        theme: None,
        image: None,
        video: None,
    }
}

// ---------- colours ----------

#[test]
fn accepts_the_colour_notations_a_theme_actually_needs() {
    for c in [
        "#fff",
        "#ffff",
        "#a1b2c3",
        "#a1b2c3ff",
        "rgb(1,2,3)",
        "rgba(1, 2, 3, 0.5)",
        "hsl(200, 50%, 40%)",
        "hsla(200 50% 40% / 0.5)",
        "red",
        "transparent",
    ] {
        assert!(safe_color(c), "{c} should be allowed");
    }
}

#[test]
fn refuses_anything_that_could_leave_the_declaration() {
    // `url()` in a colour is a network request that reports who is reading;
    // a semicolon or a brace is a second declaration or a whole new rule.
    for c in [
        "url(https://tracker.test/p.gif)",
        "red; background: url(https://t.test/x)",
        "#fff}body{display:none",
        "var(--secret)",
        "expression(alert(1))",
        "rgb(1,2,3) /* */ ; color: blue",
        "#ff",
        "#gggggg",
        "",
        "  ",
    ] {
        assert!(!safe_color(c), "{c} must be refused");
    }
}

#[test]
fn refuses_a_colour_long_enough_to_hide_something_in() {
    assert!(!safe_color(&"a".repeat(60)));
}

// ---------- fonts ----------

#[test]
fn accepts_a_stack_of_names() {
    assert!(safe_font_stack("Inter, Helvetica Neue, sans-serif"));
    assert!(safe_font_stack("\"Geist Mono\", ui-monospace, monospace"));
}

#[test]
fn refuses_a_font_stack_that_could_fetch_something() {
    // MV3 blocks a remote font load anyway; the point is that the *syntax*
    // never reaches the stylesheet, so a future relaxation cannot reopen it.
    for f in [
        "url(https://evil.test/f.woff2)",
        "@import url(x)",
        "Inter; } body { display: none",
        "local(Foo)",
        "Inter/**/",
    ] {
        assert!(!safe_font_stack(f), "{f} must be refused");
    }
}

// ---------- media ----------

#[test]
fn media_must_be_https_and_nothing_else() {
    assert!(safe_media_url("https://cdn.test/a.png"));
    for u in [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "http://cdn.test/a.png",
        "HTTPS://cdn.test/a.png",
        " https://cdn.test/a.png\nX",
        "https://cdn.test/\u{0}a.png",
        "",
    ] {
        assert!(!safe_media_url(u), "{u} must be refused");
    }
}

#[test]
fn a_bad_image_is_dropped_with_a_reason_not_a_rejection() {
    let mut p = group("AI", json!({ "query": "ai" }));
    p.image = Some("javascript:alert(1)".into());
    let (clean, problems) = clean_pack(&p);
    assert!(clean.image.is_none());
    assert!(problems.iter().any(|x| x.field == "image"));
}

// ---------- secrets ----------

#[test]
fn an_api_key_never_leaves_the_machine_it_was_typed_on() {
    let opts = json!({
        "query": "ai",
        "apiKey": "sk-live-1234",
        "xToken": "AAAA",
        "some_secret": "x",
        "Authorization": "Bearer y",
    });
    let cleaned = clean_opts(&opts);
    let map = cleaned.as_object().unwrap();
    assert_eq!(map.get("query").unwrap(), "ai");
    for gone in ["apiKey", "xToken", "some_secret", "Authorization"] {
        assert!(!map.contains_key(gone), "{gone} must be stripped");
    }
}

#[test]
fn a_home_address_is_not_part_of_sharing_the_weather() {
    let cleaned = clean_opts(&json!({ "lat": 1.35, "lon": 103.8, "place": "Home", "unit": "c" }));
    let map = cleaned.as_object().unwrap();
    assert_eq!(map.get("unit").unwrap(), "c");
    for gone in ["lat", "lon", "place"] {
        assert!(!map.contains_key(gone));
    }
}

#[test]
fn a_calendar_can_never_be_packed() {
    // Its address is a bearer secret: a shareable calendar is a leaked one.
    assert!(!shareable_def("calendar"));
    let mut p = group("Work", json!({}));
    p.instances[0].def = "calendar".into();
    let (clean, problems) = clean_pack(&p);
    assert!(clean.instances.is_empty());
    assert!(problems.iter().any(|x| x.field == "instances"));
}

#[test]
fn someone_elses_layout_does_not_rearrange_your_page() {
    let cleaned = clean_opts(&json!({ "query": "ai", "span": 3, "rows": 40, "collapsed": true }));
    let map = cleaned.as_object().unwrap();
    assert!(map.contains_key("query"));
    for gone in ["span", "rows", "collapsed"] {
        assert!(!map.contains_key(gone));
    }
}

// ---------- theme cleaning ----------

#[test]
fn a_theme_keeps_only_the_properties_the_stylesheet_reads() {
    let t = Theme {
        base: "dark".into(),
        font: Some("Inter, sans-serif".into()),
        mono: Some("url(evil)".into()),
        colors: BTreeMap::from([
            ("bg".into(), "#101010".into()),
            ("--text-strong".into(), "#fafafa".into()),
            ("display".into(), "none".into()),
            ("border-focus".into(), "url(https://t.test/x)".into()),
        ]),
    };
    let c = clean_theme(&t);
    assert_eq!(c.base, "dark");
    assert_eq!(c.font.as_deref(), Some("Inter, sans-serif"));
    assert_eq!(c.mono, None, "an unsafe stack is dropped, not kept");
    assert_eq!(c.colors.get("bg").unwrap(), "#101010");
    assert_eq!(
        c.colors.get("text-strong").unwrap(),
        "#fafafa",
        "the -- prefix is optional"
    );
    assert!(!c.colors.contains_key("display"), "not a property we read");
    assert!(!c.colors.contains_key("border-focus"), "unsafe value");
}

#[test]
fn an_unknown_base_falls_back_to_following_the_system() {
    let t = Theme {
        base: "neon".into(),
        ..Default::default()
    };
    assert_eq!(clean_theme(&t).base, "auto");
}

#[test]
fn a_theme_that_changes_nothing_is_reported_as_such() {
    let p = Pack {
        kind: "theme".into(),
        name: "Empty".into(),
        description: "Does nothing at all, which is the point.".into(),
        theme: Some(Theme::default()),
        ..Default::default()
    };
    assert!(clean_pack(&p).1.iter().any(|x| x.field == "theme"));
}

// ---------- metadata ----------

#[test]
fn a_description_is_required_because_a_listing_without_one_is_noise() {
    let mut p = group("AI", json!({ "query": "ai" }));
    p.description = "short".into();
    assert!(clean_pack(&p).1.iter().any(|x| x.field == "description"));
    p.description = "Twelve sources for AI research and industry news.".into();
    assert!(pack_ok(&p));
}

#[test]
fn long_text_is_cut_rather_than_refused() {
    let mut p = group("AI", json!({ "query": "ai" }));
    p.name = "N".repeat(500);
    p.description = "D".repeat(5_000);
    let (clean, _) = clean_pack(&p);
    assert_eq!(clean.name.chars().count(), 60);
    assert_eq!(clean.description.chars().count(), 600);
}

#[test]
fn control_characters_are_stripped_from_every_string() {
    let mut p = group("AI", json!({ "query": "ai" }));
    p.name = "A\u{0}I\u{7}".into();
    p.author = "\u{1b}[31mred".into();
    let (clean, _) = clean_pack(&p);
    assert_eq!(clean.name, "AI");
    assert_eq!(clean.author, "[31mred");
}

#[test]
fn tags_keep_the_author_s_order_when_they_are_capped() {
    // Sorting before the cap kept whichever tags began with "a" and dropped
    // the one the author led with, which is the one that mattered.
    let mut p = group("AI", json!({ "query": "ai" }));
    p.tags = vec![
        "Real Estate".into(),
        "real estate".into(),
        "AI".into(),
        "zebra".into(),
        "b".into(),
        "c".into(),
        "d".into(),
        "e".into(),
        "f".into(),
    ];
    let (clean, _) = clean_pack(&p);
    assert_eq!(clean.tags.len(), 6);
    assert_eq!(clean.tags[0], "real-estate");
    assert_eq!(clean.tags.iter().filter(|t| *t == "real-estate").count(), 1);
}

#[test]
fn a_tag_may_be_written_in_any_script() {
    let mut p = group("AI", json!({ "query": "ai" }));
    p.tags = vec!["不動産".into(), "Immobilien".into()];
    let (clean, _) = clean_pack(&p);
    assert_eq!(
        clean.tags,
        vec!["不動産".to_string(), "immobilien".to_string()]
    );
}

#[test]
fn slugify_is_url_safe_and_never_ends_in_a_dash() {
    assert_eq!(
        slugify("Real Estate & Data Centre!"),
        "real-estate-data-centre"
    );
    assert_eq!(slugify("  ...  "), "");
    // An id is machinery and stays ASCII; a tag is a word and does not.
    assert_eq!(slugify("Ünïcode Ok"), "n-code-ok");
    assert_eq!(normalize_tag("Ünïcode Ok"), "ünïcode-ok");
    assert!(!slugify("trailing---").ends_with('-'));
}

// ---------- export ----------

#[test]
fn exporting_a_group_strips_it_on_the_way_out() {
    let mut cfg = default_config();
    let ai = cfg.instances.iter_mut().find(|i| i.def == "topic").unwrap();
    let id = ai.id.clone();
    ai.opts = json!({ "query": "ai", "apiKey": "sk-live", "lat": 1.0, "span": 3 });

    let pack = pack_from_instance(&cfg, &id, "darius", "Twelve good AI sources.").unwrap();
    let opts = pack.instances[0].opts.as_object().unwrap();
    assert!(opts.contains_key("query"));
    assert!(!opts.contains_key("apiKey"));
    assert!(!opts.contains_key("lat"));
    assert!(!opts.contains_key("span"));
    assert!(pack_ok(&pack));
}

#[test]
fn a_group_that_cannot_be_shared_cannot_be_exported() {
    let cfg = default_config();
    assert!(pack_from_instance(&cfg, "calendar", "d", "My work calendar").is_none());
    assert!(pack_from_instance(&cfg, "nope", "d", "Nothing there").is_none());
}

// ---------- install ----------

#[test]
fn installing_adds_the_group() {
    let cfg = default_config();
    let before = cfg.instances.len();
    let pack = group(
        "Semiconductors",
        json!({ "query": "semiconductor", "sources": [] }),
    );
    let (out, res) = apply_pack(&cfg, &pack);
    assert_eq!(out.instances.len(), before + 1);
    assert_eq!(res.added, vec!["semiconductors".to_string()]);
    assert!(res.renamed.is_empty());
    assert!(
        out.instances.last().unwrap().enabled,
        "an installed pack is on"
    );
}

#[test]
fn installing_never_overwrites_a_group_you_already_have() {
    // Someone's "AI" must not silently replace the "AI" you spent an hour on.
    let cfg = default_config();
    let mine = cfg
        .instances
        .iter()
        .find(|i| i.def == "topic")
        .unwrap()
        .clone();
    let mut pack = group(&mine.name, json!({ "query": "theirs" }));
    pack.instances[0].id = mine.id.clone();

    let (out, res) = apply_pack(&cfg, &pack);
    assert_eq!(res.added.len(), 1);
    assert_eq!(res.renamed.len(), 1);
    assert_ne!(res.added[0], mine.id);
    let kept = out.instances.iter().find(|i| i.id == mine.id).unwrap();
    assert_eq!(kept.opts, mine.opts, "the original is untouched");
}

#[test]
fn installing_twice_gives_two_cards_rather_than_a_silent_no_op() {
    let cfg = default_config();
    let pack = group("Semiconductors", json!({ "query": "semi" }));
    let (once, _) = apply_pack(&cfg, &pack);
    let (twice, res) = apply_pack(&once, &pack);
    assert_eq!(twice.instances.len(), once.instances.len() + 1);
    assert_eq!(res.renamed.len(), 1);
}

#[test]
fn a_broken_pack_changes_nothing_at_all() {
    let cfg = default_config();
    let mut pack = group("AI", json!({}));
    pack.description = "x".into();
    let (out, res) = apply_pack(&cfg, &pack);
    assert_eq!(out.instances.len(), cfg.instances.len());
    assert!(res.added.is_empty());
    assert!(!res.problems.is_empty());
}

#[test]
fn installing_a_theme_sets_the_base_and_touches_no_groups() {
    let cfg = default_config();
    let pack = Pack {
        kind: "theme".into(),
        name: "Midnight".into(),
        description: "A calm dark palette for late reading.".into(),
        theme: Some(Theme {
            base: "dark".into(),
            font: Some("Inter, sans-serif".into()),
            mono: None,
            colors: BTreeMap::from([("bg".into(), "#0b0b0d".into())]),
        }),
        ..Default::default()
    };
    let (out, res) = apply_pack(&cfg, &pack);
    assert!(res.theme_applied);
    assert_eq!(out.theme, "dark");
    assert_eq!(out.instances.len(), cfg.instances.len());
}

#[test]
fn a_pack_survives_a_json_round_trip() {
    // It travels as JSON through a server written by nobody in particular.
    let pack = group("AI", json!({ "query": "ai", "limit": 8 }));
    let wire = serde_json::to_string(&pack).unwrap();
    let back: Pack = serde_json::from_str(&wire).unwrap();
    assert_eq!(clean_pack(&pack).0, clean_pack(&back).0);
}

#[test]
fn unknown_fields_in_the_wire_form_do_not_break_reading_it() {
    // A newer publisher, an older reader.
    let wire = r#"{"format":1,"kind":"group","id":"ai","name":"AI",
        "description":"Twelve good sources for AI news.","author":"d",
        "instances":[{"def":"topic","id":"ai","name":"AI","opts":{"query":"ai"}}],
        "somethingNew":{"a":1}}"#;
    let pack: Pack = serde_json::from_str(wire).unwrap();
    assert!(pack_ok(&pack));
}

#[test]
fn an_installed_theme_is_stored_so_it_travels_with_the_config() {
    // The config document is the thing someone copies to another browser
    // (D4). A theme that lived outside it would be the one setting that did
    // not move with everything else.
    let cfg = default_config();
    let pack = Pack {
        kind: "theme".into(),
        name: "Midnight".into(),
        description: "A calm dark palette for late reading.".into(),
        theme: Some(Theme {
            base: "dark".into(),
            font: Some("Inter, sans-serif".into()),
            mono: None,
            colors: BTreeMap::from([("bg".into(), "#0b0b0d".into())]),
        }),
        ..Default::default()
    };
    let (out, _) = apply_pack(&cfg, &pack);
    let stored = out
        .custom_theme
        .clone()
        .expect("the theme is part of the config");
    assert_eq!(stored.base, "dark");
    assert_eq!(stored.colors.get("bg").unwrap(), "#0b0b0d");

    // And it survives the round trip through the config string.
    let wire = serde_json::to_string(&out).unwrap();
    let back: Config = serde_json::from_str(&wire).unwrap();
    assert_eq!(back.custom_theme, out.custom_theme);
}

#[test]
fn a_theme_that_cannot_be_read_is_dropped_rather_than_half_applied() {
    let stored = serde_json::json!({
        "version": 3, "instances": [], "theme": "dark", "assistant": "claude",
        "custom_theme": "not an object at all"
    });
    let cfg = crate::config::migrate(&stored);
    assert_eq!(cfg.custom_theme, None);
    assert_eq!(cfg.theme, "dark");
}
