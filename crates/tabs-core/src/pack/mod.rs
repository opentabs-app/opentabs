//! Shareable packs — a topic, a group, or a theme, as a portable document.
//!
//! # What a pack is
//!
//! Someone has spent an hour assembling twelve good sources for Real Estate.
//! A pack is that hour, as a document another reader can apply in one click.
//! It is the same `Instance` shape the config already uses (D12), plus the
//! metadata a listing needs: who made it, what it is for, and optionally a
//! picture.
//!
//! # Why almost all of this file is validation
//!
//! **A pack arrives from a stranger.** It is JSON authored by someone the
//! reader has never met, and applying it writes into their configuration and
//! their stylesheet. Every field here is therefore treated as hostile until
//! it has been proved otherwise:
//!
//!   * a theme sets CSS custom properties, so a colour that is allowed to be
//!     an arbitrary string is a stylesheet injection — `url(…)` alone would
//!     turn a colour into a network request that reports who is reading;
//!   * a font stack is also CSS, and `@import`/`url()` in one is the same
//!     hole by another route;
//!   * media is rendered in a page, so a `javascript:` or `data:` URL there
//!     is script execution;
//!   * `opts` is free-form JSON, so a pack could carry the *publisher's* API
//!     key straight into a reader's storage, or — worse — a reader could
//!     publish their own key without noticing.
//!
//! The rule throughout: **allow a known-good shape and drop everything else**,
//! never try to spot the bad. A pack that loses a field is a pack that works
//! slightly less well; a pack that smuggles one is a security bug.

use crate::config::{Config, Instance};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Bumped when the on-the-wire shape changes incompatibly.
pub const PACK_FORMAT: u32 = 1;

const MAX_NAME: usize = 60;
const MAX_DESCRIPTION: usize = 600;
const MAX_AUTHOR: usize = 40;
const MAX_TAGS: usize = 6;
const MAX_TAG: usize = 24;
const MAX_INSTANCES: usize = 8;
const MAX_URL: usize = 400;

/// A theme: the typeface and the palette, nothing that can execute.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Theme {
    /// `light`, `dark`, or `auto` — which palette the custom colours extend.
    #[serde(default)]
    pub base: String,
    /// Display font stack. Names only; see [`safe_font_stack`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
    /// Monospace stack, for the numbers and the card titles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mono: Option<String>,
    /// Custom property name (without `--`) to colour value.
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
}

/// A pack, as published and as installed.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Pack {
    #[serde(default)]
    pub format: u32,
    /// `group` (one or more instances) or `theme`.
    #[serde(default)]
    pub kind: String,
    /// Slug, stable across edits. Assigned by the marketplace on publish.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// A display handle chosen at publish time. Never an email or an account id.
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub instances: Vec<Instance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<Theme>,
    /// Optional cover image. `https` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// Optional video. `https` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
}

/// What went wrong, in words a publisher can act on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackProblem {
    pub field: String,
    pub message: String,
}

fn problem(field: &str, message: &str) -> PackProblem {
    PackProblem {
        field: field.into(),
        message: message.into(),
    }
}

// ---------- the allow-lists ----------

/// Defs a pack may carry.
///
/// `calendar` is absent on purpose and it is the important omission: a
/// calendar is a subscription URL that is a bearer secret, so a "shareable
/// calendar" is a leaked one. `apps` and `tabs` are absent because they carry
/// no configuration worth sharing.
pub fn shareable_def(def: &str) -> bool {
    matches!(
        def,
        "topic"
            | "xsearch"
            | "crypto"
            | "equities"
            | "status"
            | "trending"
            | "weather"
            | "bookmarks"
    )
}

/// Option keys that must never cross between two people.
///
/// Matched case-insensitively and by substring, because the cost of dropping
/// an innocent key called `monkey` is nothing and the cost of missing one
/// called `apiKey2` is someone's credential in a public listing.
const SECRET_HINTS: [&str; 7] = [
    "key", "token", "secret", "password", "bearer", "auth", "cred",
];

fn looks_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_HINTS.iter().any(|h| lower.contains(h))
}

/// Option keys that are personal rather than secret.
///
/// A weather group's coordinates are someone's home. Sharing "Weather" should
/// share the *idea*, not the address, so these are blanked rather than kept.
const PERSONAL_KEYS: [&str; 4] = ["lat", "lon", "place", "folder_id"];

/// The CSS custom properties a theme may set.
///
/// An explicit list, not a pattern: every one of these is a name the
/// stylesheet actually reads, so anything else would be dead weight at best
/// and a way to reach an unrelated property at worst.
pub const THEME_VARS: [&str; 14] = [
    "bg",
    "bg-sunken",
    "surface-card",
    "text-strong",
    "text-muted",
    "text-faint",
    "border-hairline",
    "border-focus",
    "success-fg",
    "danger-fg",
    "warning-fg",
    "accent",
    "card-radius",
    "font-scale",
];

/// Is this a colour we are willing to paste into a stylesheet?
///
/// Hex, the four functional notations, or a plain keyword. Deliberately no
/// `var()`, no `url()`, no `calc()`, and no escapes — the grammar is small
/// because everything outside it is either useless here or an injection.
pub fn safe_color(raw: &str) -> bool {
    let v = raw.trim();
    if v.is_empty() || v.len() > 40 {
        return false;
    }
    // Anything that could close a declaration or open a new one.
    if v.contains([';', '{', '}', '<', '>', '\\', '"', '\'', '@']) {
        return false;
    }
    if let Some(hex) = v.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    for f in ["rgb(", "rgba(", "hsl(", "hsla("] {
        if let Some(rest) = v.strip_prefix(f) {
            let Some(args) = rest.strip_suffix(')') else {
                return false;
            };
            return !args.is_empty()
                && args
                    .chars()
                    .all(|c| c.is_ascii_digit() || " .,%-/".contains(c));
        }
    }
    // A bare keyword: letters only, so `red` passes and `expression` cannot
    // reach anything anyway.
    v.len() <= 24 && v.chars().all(|c| c.is_ascii_alphabetic())
}

/// A number-ish value for the couple of non-colour custom properties.
fn safe_scalar(raw: &str) -> bool {
    let v = raw.trim();
    !v.is_empty()
        && v.len() <= 12
        && v.chars()
            .all(|c| c.is_ascii_digit() || ".%".contains(c) || c == 'p' || c == 'x')
}

/// Is this a font stack of names, and only names?
///
/// MV3 forbids loading a remote font anyway, so a stack can only usefully
/// name faces already on the machine or shipped with the extension. That
/// makes the safe grammar very small, which is exactly what is wanted: no
/// `url()`, no `@import`, no parentheses at all.
pub fn safe_font_stack(raw: &str) -> bool {
    let v = raw.trim();
    if v.is_empty() || v.len() > 160 {
        return false;
    }
    if v.contains(['(', ')', ';', '{', '}', '@', '\\', '<', '>', '/']) {
        return false;
    }
    v.chars()
        .all(|c| c.is_ascii_alphanumeric() || " ,-_'\"".contains(c))
}

/// An `https` URL, and nothing else.
///
/// Not "not javascript:" — an allow-list, because the list of schemes that
/// can execute something is longer than anyone remembers and grows.
pub fn safe_media_url(raw: &str) -> bool {
    let v = raw.trim();
    if v.is_empty() || v.len() > MAX_URL {
        return false;
    }
    if !v.starts_with("https://") {
        return false;
    }
    // Control characters and whitespace inside a URL are how a filter that
    // reads the front of a string gets fooled about the rest of it.
    !v.chars().any(|c| c.is_whitespace() || c.is_control())
}

// ---------- cleaning ----------

fn trim_to(s: &str, max: usize) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect::<String>()
        .trim()
        .to_string();
    cleaned.chars().take(max).collect()
}

/// Strip an instance's options down to what is safe and meaningful to share.
///
/// Returns the cleaned value; the caller decides whether losing a key matters.
pub fn clean_opts(opts: &Value) -> Value {
    let Some(map) = opts.as_object() else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    for (k, v) in map {
        if looks_secret(k) {
            continue;
        }
        if PERSONAL_KEYS.contains(&k.as_str()) {
            continue;
        }
        // Layout is the reader's, not the publisher's: arriving with someone
        // else's card sizes would rearrange a page they had arranged.
        if matches!(k.as_str(), "span" | "rows" | "collapsed") {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    Value::Object(out)
}

/// A slug for an **id**: ASCII, lowercase, hyphens, nothing else.
///
/// Deliberately narrower than [`normalize_tag`]. An id ends up in a URL path
/// and a storage key, where a percent-encoded Chinese character is a series
/// of small surprises; a tag is a word somebody typed and has no such job.
pub fn slugify(name: &str) -> String {
    squash(name, |c| c.is_ascii_alphanumeric())
}

/// A tag: the same shape, but any script.
///
/// "不動産" and "Immobilien" are tags people will reasonably type, and an
/// ASCII-only filter turns both into the empty string — which is not a
/// restriction, it is silent data loss.
pub fn normalize_tag(raw: &str) -> String {
    squash(raw, |c| c.is_alphanumeric())
}

fn squash(name: &str, keep: impl Fn(char) -> bool) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.chars().flat_map(char::to_lowercase) {
        if keep(c) {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars().take(48).collect()
}

/// Clean a theme, dropping every property that is not provably safe.
pub fn clean_theme(theme: &Theme) -> Theme {
    let mut colors = BTreeMap::new();
    for (k, v) in &theme.colors {
        let name = k.trim().trim_start_matches("--");
        if !THEME_VARS.contains(&name) {
            continue;
        }
        let ok = if name == "card-radius" || name == "font-scale" {
            safe_scalar(v)
        } else {
            safe_color(v)
        };
        if ok {
            colors.insert(name.to_string(), v.trim().to_string());
        }
    }
    Theme {
        base: match theme.base.as_str() {
            "light" | "dark" => theme.base.clone(),
            _ => "auto".into(),
        },
        font: theme
            .font
            .as_deref()
            .filter(|f| safe_font_stack(f))
            .map(|f| f.trim().to_string()),
        mono: theme
            .mono
            .as_deref()
            .filter(|f| safe_font_stack(f))
            .map(|f| f.trim().to_string()),
        colors,
    }
}

/// Clean a pack and say what was wrong with it.
///
/// Always returns a pack: a publisher who mistyped a colour should get their
/// pack with that colour dropped and a note, not a rejection with no idea
/// which of forty fields was at fault.
pub fn clean_pack(pack: &Pack) -> (Pack, Vec<PackProblem>) {
    let mut problems = Vec::new();

    let kind = match pack.kind.as_str() {
        "theme" => "theme",
        _ => "group",
    };

    let name = trim_to(&pack.name, MAX_NAME);
    if name.is_empty() {
        problems.push(problem("name", "A pack needs a name."));
    }
    let description = trim_to(&pack.description, MAX_DESCRIPTION);
    if description.chars().count() < 10 {
        problems.push(problem(
            "description",
            "Say what this is for, in a sentence or two — a listing with no description is one nobody installs.",
        ));
    }

    // Deduped in the order they were written, then capped — sorting first
    // and cutting afterwards keeps whichever tags happen to start with "a"
    // and drops the one the author actually cared about.
    let mut tags: Vec<String> = Vec::new();
    for t in &pack.tags {
        let tag = normalize_tag(&trim_to(t, MAX_TAG));
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
        if tags.len() == MAX_TAGS {
            break;
        }
    }

    let image = pack
        .image
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let image = match image {
        Some(u) if safe_media_url(u) => Some(u.to_string()),
        Some(_) => {
            problems.push(problem("image", "An image must be an https link."));
            None
        }
        None => None,
    };
    let video = pack
        .video
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let video = match video {
        Some(u) if safe_media_url(u) => Some(u.to_string()),
        Some(_) => {
            problems.push(problem("video", "A video must be an https link."));
            None
        }
        None => None,
    };

    let mut instances = Vec::new();
    if kind == "group" {
        for inst in pack.instances.iter().take(MAX_INSTANCES) {
            if !shareable_def(&inst.def) {
                problems.push(problem(
                    "instances",
                    &format!("“{}” cannot be shared, so it was left out.", inst.def),
                ));
                continue;
            }
            instances.push(Instance {
                def: inst.def.clone(),
                id: slugify(&inst.id).max(slugify(&inst.name)),
                name: trim_to(&inst.name, MAX_NAME),
                enabled: true,
                opts: clean_opts(&inst.opts),
            });
        }
        if instances.is_empty() {
            problems.push(problem("instances", "This pack contains nothing to add."));
        }
    }

    let theme = if kind == "theme" {
        let cleaned = clean_theme(pack.theme.as_ref().unwrap_or(&Theme::default()));
        if cleaned.colors.is_empty() && cleaned.font.is_none() && cleaned.mono.is_none() {
            problems.push(problem(
                "theme",
                "This theme changes nothing — set a font or at least one colour.",
            ));
        }
        Some(cleaned)
    } else {
        None
    };

    let cleaned = Pack {
        format: PACK_FORMAT,
        kind: kind.into(),
        id: if pack.id.is_empty() {
            slugify(&name)
        } else {
            slugify(&pack.id)
        },
        name,
        description,
        author: trim_to(&pack.author, MAX_AUTHOR),
        tags,
        instances,
        theme,
        image,
        video,
    };
    (cleaned, problems)
}

/// Is this pack fit to publish or install?
pub fn pack_ok(pack: &Pack) -> bool {
    clean_pack(pack).1.is_empty()
}

// ---------- export ----------

/// Build a pack from one of the reader's own groups.
///
/// The instance is copied, not referenced, and stripped by [`clean_opts`] on
/// the way out — so publishing a group cannot publish a key or a home address
/// even if the publisher never thinks about it.
pub fn pack_from_instance(
    cfg: &Config,
    instance_id: &str,
    author: &str,
    description: &str,
) -> Option<Pack> {
    let inst = cfg.instances.iter().find(|i| i.id == instance_id)?;
    if !shareable_def(&inst.def) {
        return None;
    }
    let pack = Pack {
        format: PACK_FORMAT,
        kind: "group".into(),
        id: slugify(&inst.name),
        name: inst.name.clone(),
        description: description.to_string(),
        author: author.to_string(),
        tags: vec![slugify(&inst.def)],
        instances: vec![inst.clone()],
        theme: None,
        image: None,
        video: None,
    };
    Some(clean_pack(&pack).0)
}

// ---------- install ----------

/// The outcome of applying a pack, so the page can say what happened.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct InstallResult {
    pub added: Vec<String>,
    pub renamed: Vec<String>,
    pub theme_applied: bool,
    pub problems: Vec<PackProblem>,
}

/// Add a pack's contents to a config, returning the new config.
///
/// Nothing is ever replaced. A pack whose topic id collides with one the
/// reader already has arrives beside it under a fresh id: installing
/// somebody's "AI" must not silently overwrite the "AI" they spent an hour
/// on, and asking them to resolve it before they have seen either is worse
/// than showing both.
pub fn apply_pack(cfg: &Config, pack: &Pack) -> (Config, InstallResult) {
    let (clean, problems) = clean_pack(pack);
    let mut out = cfg.clone();
    let mut result = InstallResult {
        problems,
        ..Default::default()
    };
    if !result.problems.is_empty() {
        return (out, result);
    }

    if clean.kind == "theme" {
        if let Some(t) = &clean.theme {
            out.custom_theme = Some(t.clone());
            out.theme = if t.base.is_empty() {
                "auto".into()
            } else {
                t.base.clone()
            };
            result.theme_applied = true;
        }
        return (out, result);
    }

    for inst in clean.instances {
        let taken: Vec<&str> = out.instances.iter().map(|i| i.id.as_str()).collect();
        let mut id = inst.id.clone();
        if id.is_empty() {
            id = slugify(&inst.name);
        }
        if taken.contains(&id.as_str()) {
            let base = id.clone();
            let mut n = 2;
            while out.instances.iter().any(|i| i.id == id) {
                id = format!("{base}-{n}");
                n += 1;
            }
            result.renamed.push(id.clone());
        }
        result.added.push(id.clone());
        out.instances.push(Instance { id, ..inst });
    }
    (out, result)
}

#[cfg(test)]
mod tests;
