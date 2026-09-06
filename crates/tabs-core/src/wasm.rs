//! The wasm surface — the entire JS-facing API of this crate.
//!
//! Every function here delegates; no logic lives in this file, so the native
//! test suite covers the same code the extension runs.
//!
//! **Callers: this module is loaded by the service worker only.** Importing
//! it from the new tab page would put wasm instantiation on the paint path,
//! which is the one thing the architecture exists to prevent.

use wasm_bindgen::prelude::*;

/// Serialise to a **plain JS object**, not an ES `Map`.
///
/// `serde_wasm_bindgen::to_value` defaults to `serialize_maps_as_objects:
/// false`, so any serde *map* — including every `serde_json::Value::Object`,
/// which is what `Instance.opts` is — arrives in JS as a `Map`. That is
/// invisible until something reads it: `inst.opts.sources` is `undefined` on
/// a Map, assigning to it produces a property `JSON.stringify` discards, and
/// a topic with sources configured reports having none.
///
/// `json_compatible()` is the round-trip-safe setting: plain objects, `null`
/// instead of `undefined`, stringify without data loss. Everything crossing
/// this boundary is stored as JSON, so it is the only correct choice here.
fn to_js<T: serde::Serialize>(v: &T) -> JsValue {
    use serde::Serialize;
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .unwrap_or(JsValue::NULL)
}

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

// ---------- tabs (M1) ----------

/// `tabs` is the array from `chrome.tabs.query({})`.
#[wasm_bindgen(js_name = groupTabs)]
pub fn group_tabs(tabs: JsValue) -> JsValue {
    let parsed: Vec<crate::tabs::Tab> = serde_wasm_bindgen::from_value(tabs).unwrap_or_default();
    to_js(&crate::tabs::group(&parsed))
}

// ---------- feeds and the topic engine (M5) ----------

/// Parse an RSS/Atom/RDF document into items.
#[wasm_bindgen(js_name = parseFeed)]
pub fn parse_feed(doc: &str, binding: &str, fetched_at: f64) -> JsValue {
    to_js(&crate::feed::parse(doc, binding, fetched_at as i64))
}

/// Parse a Bluesky `searchPosts` response into the same item shape.
#[wasm_bindgen(js_name = parseBluesky)]
pub fn parse_bluesky(json: &str, binding: &str, fetched_at: f64) -> JsValue {
    to_js(&crate::feed::social::parse_bluesky(
        json,
        binding,
        fetched_at as i64,
    ))
}

/// Parse a Mastodon status search into the same item shape.
#[wasm_bindgen(js_name = parseMastodon)]
pub fn parse_mastodon(json: &str, binding: &str, fetched_at: f64) -> JsValue {
    to_js(&crate::feed::social::parse_mastodon(
        json,
        binding,
        fetched_at as i64,
    ))
}

/// Parse a Hacker News Algolia response into the same item shape.
#[wasm_bindgen(js_name = parseHackerNews)]
pub fn parse_hacker_news(json: &str, binding: &str, fetched_at: f64) -> JsValue {
    to_js(&crate::feed::hn::parse(json, binding, fetched_at as i64))
}

/// Dedupe and rank a pooled item list. This is D10 — no model, three
/// signals: corroboration, recency, source weight.
#[wasm_bindgen(js_name = rankItems)]
pub fn rank_items(items: JsValue, opts: JsValue, now: f64) -> JsValue {
    let items: Vec<crate::feed::Item> = serde_wasm_bindgen::from_value(items).unwrap_or_default();
    let opts: crate::feed::rank::RankOpts =
        serde_wasm_bindgen::from_value(opts).unwrap_or_default();
    to_js(&crate::feed::rank::rank(&items, &opts, now as i64))
}

// ---------- discovery (M6) ----------

#[wasm_bindgen(js_name = looksLikeFeed)]
pub fn looks_like_feed(body: &str) -> bool {
    crate::feed::discover::looks_like_feed(body)
}

/// Feed candidates advertised by an HTML document, ranked. Comment feeds
/// sort last — see the mingtiandi case in `discover`.
#[wasm_bindgen(js_name = discoverFeeds)]
pub fn discover_feeds(html: &str, base: &str) -> JsValue {
    to_js(&crate::feed::discover::from_html(html, base))
}

#[wasm_bindgen(js_name = wellKnownFeedUrls)]
pub fn well_known_feed_urls(base: &str) -> JsValue {
    to_js(&crate::feed::discover::well_known_for(base))
}

// ---------- calendars (M7) ----------

#[wasm_bindgen(js_name = parseIcs)]
pub fn parse_ics(text: &str, from: f64, to: f64) -> JsValue {
    to_js(&crate::ical::parse(text, from as i64, to as i64))
}

#[wasm_bindgen(js_name = normalizeWebcal)]
pub fn normalize_webcal(url: &str) -> String {
    crate::url::normalize_webcal(url)
}

// ---------- to-dos (M8) ----------

/// Parse a due date out of free text. Returns `null` when the text carries
/// no date phrase, which the caller treats as "no due date".
#[wasm_bindgen(js_name = parseDueDate)]
pub fn parse_due_date(text: &str, now: f64) -> JsValue {
    match crate::nldate::parse(text, now as i64) {
        Some(p) => to_js(&serde_json::json!({
            "at": p.at, "hasTime": p.has_time, "rest": p.rest
        })),
        None => JsValue::NULL,
    }
}

// ---------- trending (M9 client side) ----------

#[wasm_bindgen(js_name = parseTrending)]
pub fn parse_trending(html: &str) -> JsValue {
    to_js(&crate::trending::parse(html))
}

// ---------- config (M2) ----------

#[wasm_bindgen(js_name = defaultConfig)]
pub fn default_config() -> JsValue {
    to_js(&crate::config::default_config())
}

/// Bring a stored document to the current version. Never throws: a config
/// that fails to migrate falls back to defaults rather than leaving the user
/// with a blank page.
#[wasm_bindgen(js_name = migrateConfig)]
pub fn migrate_config(stored: JsValue) -> JsValue {
    let value: serde_json::Value =
        serde_wasm_bindgen::from_value(stored).unwrap_or(serde_json::Value::Null);
    to_js(&crate::config::migrate(&value))
}

/// Resolve one binding to a fetchable URL.
#[wasm_bindgen(js_name = bindingUrl)]
pub fn binding_url(binding: JsValue, query: &str) -> JsValue {
    let b: Option<crate::config::Binding> = serde_wasm_bindgen::from_value(binding).ok();
    match b.and_then(|b| crate::config::binding_url(&b, query)) {
        Some(u) => JsValue::from_str(&u),
        None => JsValue::NULL,
    }
}

/// The host permissions a config implies — what the permission broker asks
/// Chrome for, and nothing wider.
#[wasm_bindgen(js_name = requiredOrigins)]
pub fn required_origins(config: JsValue) -> JsValue {
    let cfg: serde_json::Value =
        serde_wasm_bindgen::from_value(config).unwrap_or(serde_json::Value::Null);
    to_js(&crate::config::required_origins(&crate::config::migrate(
        &cfg,
    )))
}

// ---------- urls ----------

#[wasm_bindgen(js_name = canonicalizeUrl)]
pub fn canonicalize_url(u: &str) -> String {
    crate::url::canonicalize(u)
}

#[wasm_bindgen(js_name = urlIdentity)]
pub fn url_identity(u: &str) -> String {
    crate::url::identity(u)
}

// ---------- X advanced search ----------

/// Build the query string the API understands from structured fields.
#[wasm_bindgen(js_name = xApiQuery)]
pub fn x_api_query(q: JsValue, now: f64) -> JsValue {
    let q: crate::xsearch::XQuery = serde_wasm_bindgen::from_value(q).unwrap_or_default();
    // Always through `resolved`: a rolling window must be computed now, not
    // whenever the search was saved.
    let q = q.resolved(now as i64);
    to_js(&serde_json::json!({
        "query": q.to_api(),
        "start_time": q.api_time_params().0,
        "end_time": q.api_time_params().1,
        "limitations": q.api_limitations(),
        "empty": q.is_empty(),
    }))
}

/// The openable `x.com/search` URL for the same fields.
#[wasm_bindgen(js_name = xWebUrl)]
pub fn x_web_url(q: JsValue, now: f64) -> String {
    let q: crate::xsearch::XQuery = serde_wasm_bindgen::from_value(q).unwrap_or_default();
    q.resolved(now as i64).web_url()
}

/// Parse a pasted advanced-search `q=` back into fields.
#[wasm_bindgen(js_name = xParseQuery)]
pub fn x_parse_query(q: &str) -> JsValue {
    to_js(&crate::xsearch::XQuery::from_web_query(q))
}

/// Normalise posts read from a rendered X search page.
///
/// Deliberately strict: anything without a trustworthy status id is dropped
/// rather than guessed at, so a markup change empties the group loudly
/// instead of filling it with fragments.
#[wasm_bindgen(js_name = normalizeXPosts)]
pub fn normalize_x_posts(json: &str, binding: &str, fetched_at: f64) -> JsValue {
    to_js(&crate::xdom::normalize(json, binding, fetched_at as i64))
}

// ---------- shareable packs (marketplace) ----------

/// Clean a pack and report what was wrong with it, in one call.
///
/// Returns `{ pack, problems }` rather than throwing: a publisher who mistyped
/// one colour needs their pack back with that colour dropped and a note, not a
/// rejection that names none of forty fields.
#[wasm_bindgen(js_name = cleanPack)]
pub fn clean_pack(pack: JsValue) -> JsValue {
    let parsed: crate::pack::Pack = serde_wasm_bindgen::from_value(pack).unwrap_or_default();
    let (clean, problems) = crate::pack::clean_pack(&parsed);
    to_js(&serde_json::json!({ "pack": clean, "problems": problems }))
}

/// Build a pack from one of the reader's own groups, stripped on the way out.
#[wasm_bindgen(js_name = packFromInstance)]
pub fn pack_from_instance(cfg: JsValue, id: &str, author: &str, description: &str) -> JsValue {
    let parsed: crate::config::Config = match serde_wasm_bindgen::from_value(cfg) {
        Ok(c) => c,
        Err(_) => return JsValue::NULL,
    };
    match crate::pack::pack_from_instance(&parsed, id, author, description) {
        Some(p) => to_js(&p),
        None => JsValue::NULL,
    }
}

/// Apply a pack to a config. Returns `{ config, result }`.
#[wasm_bindgen(js_name = applyPack)]
pub fn apply_pack(cfg: JsValue, pack: JsValue) -> JsValue {
    let config: crate::config::Config = match serde_wasm_bindgen::from_value(cfg) {
        Ok(c) => c,
        Err(_) => return JsValue::NULL,
    };
    let parsed: crate::pack::Pack = serde_wasm_bindgen::from_value(pack).unwrap_or_default();
    let (out, result) = crate::pack::apply_pack(&config, &parsed);
    to_js(&serde_json::json!({ "config": out, "result": result }))
}

/// The custom properties a theme is allowed to set, for the settings editor.
#[wasm_bindgen(js_name = themeVars)]
pub fn theme_vars() -> JsValue {
    to_js(&crate::pack::THEME_VARS)
}

/// Is this value safe to paste into a stylesheet? Used to validate as you type.
#[wasm_bindgen(js_name = safeColor)]
pub fn safe_color(v: &str) -> bool {
    crate::pack::safe_color(v)
}

#[wasm_bindgen(js_name = safeFontStack)]
pub fn safe_font_stack(v: &str) -> bool {
    crate::pack::safe_font_stack(v)
}
