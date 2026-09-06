//! URL parsing and canonicalisation.
//!
//! Hand-rolled rather than pulling the `url` crate: this crate compiles to
//! wasm that ships inside an extension, and the only operations needed are
//! split-into-parts, strip-tracking-params and normalise. `url` would bring
//! full IDNA/punycode tables for a job that never round-trips a hostname
//! back out to the network — every fetch uses the string the source gave us.
//!
//! What this must get right is *identity*: two URLs for the same story have
//! to canonicalise to the same string, because cross-source corroboration
//! (see `crate::rank`) is the main ranking signal and it compares URLs.

/// Query parameters stripped during canonicalisation. Campaign trackers and
/// per-share identifiers, none of which change what is served.
const TRACKING_PREFIXES: &[&str] = &["utm_", "ga_", "hsa_", "mc_", "pk_", "matomo_", "piwik_"];
const TRACKING_EXACT: &[&str] = &[
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "twclid",
    "igshid",
    "mkt_tok",
    "ref",
    "ref_src",
    "ref_url",
    "source",
    "cmpid",
    "CMP",
    "ncid",
    "sr_share",
    "at_medium",
    "at_campaign",
    "spm",
    "scm",
    "share_id",
    "__twitter_impression",
    "_hsenc",
    "_hsmi",
    "vero_id",
    "yclid",
    "rb_clickid",
    "oly_enc_id",
    "oly_anon_id",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parts {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub fragment: Option<String>,
}

/// Split a URL into parts. Returns `None` for anything without a scheme and
/// host, which is what callers want — a relative or malformed href is not
/// something to guess at.
pub fn parse(input: &str) -> Option<Parts> {
    let s = input.trim();
    let (scheme, rest) = s.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b))
    {
        return None;
    }

    let (rest, fragment) = match rest.split_once('#') {
        Some((r, f)) => (r, Some(f.to_string())),
        None => (rest, None),
    };
    let (rest, query_str) = match rest.split_once('?') {
        Some((r, q)) => (r, Some(q)),
        None => (rest, None),
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };

    // userinfo@host — drop the userinfo. Keeping it is how an origin check
    // gets fooled by `https://trusted.com@evil.test/`.
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if authority.is_empty() {
        return None;
    }

    // IPv6 literals keep their brackets; only a trailing `:port` splits.
    let (host, port) = if let Some(close) = authority.rfind(']') {
        let (h, tail) = authority.split_at(close + 1);
        (h, tail.strip_prefix(':').and_then(|p| p.parse().ok()))
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        match p.parse::<u16>() {
            Ok(n) => (h, Some(n)),
            Err(_) => (authority, None),
        }
    } else {
        (authority, None)
    };
    if host.is_empty() {
        return None;
    }

    let query = query_str.map(parse_query).unwrap_or_default();
    Some(Parts {
        scheme,
        host: host.to_ascii_lowercase(),
        port,
        path: if path.is_empty() {
            "/".into()
        } else {
            path.to_string()
        },
        query,
        fragment,
    })
}

fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (p.to_string(), String::new()),
        })
        .collect()
}

fn is_tracking(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    TRACKING_PREFIXES.iter().any(|p| lower.starts_with(p))
        || TRACKING_EXACT.iter().any(|e| e.eq_ignore_ascii_case(key))
}

/// The default port for a scheme, which canonicalisation drops.
fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        _ => None,
    }
}

/// Reduce a URL to a stable identity string.
///
/// Same document, same output — that is the only contract. Lowercases scheme
/// and host, drops `www.`, drops the default port, drops the fragment, sorts
/// and strips tracking parameters, and removes a trailing slash on non-root
/// paths. Idempotent by construction: canonicalising twice is canonicalising
/// once (proved in tests).
pub fn canonicalize(input: &str) -> String {
    let Some(mut p) = parse(input) else {
        return input.trim().to_string();
    };
    if let Some(stripped) = p.host.strip_prefix("www.") {
        if stripped.contains('.') {
            p.host = stripped.to_string();
        }
    }
    if p.port == default_port(&p.scheme) {
        p.port = None;
    }
    p.query.retain(|(k, _)| !is_tracking(k));
    p.query.sort_by(|a, b| a.0.cmp(&b.0));
    if p.path.len() > 1 && p.path.ends_with('/') {
        p.path.pop();
    }

    let mut out = format!("{}://{}", p.scheme, p.host);
    if let Some(port) = p.port {
        out.push(':');
        out.push_str(&port.to_string());
    }
    out.push_str(&p.path);
    if !p.query.is_empty() {
        out.push('?');
        let joined: Vec<String> = p
            .query
            .iter()
            .map(|(k, v)| {
                if v.is_empty() {
                    k.clone()
                } else {
                    format!("{k}={v}")
                }
            })
            .collect();
        out.push_str(&joined.join("&"));
    }
    out
}

/// `webcal://` is a calendar-subscription scheme with no transport of its
/// own — every client fetches it over https. Providers hand out both forms.
pub fn normalize_webcal(input: &str) -> String {
    let t = input.trim();
    for prefix in ["webcal://", "webcals://"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return format!("https://{rest}");
        }
    }
    t.to_string()
}

/// Resolve a possibly-relative href against a base. Enough for feed
/// autodiscovery, which is the only caller.
pub fn resolve(base: &str, href: &str) -> Option<String> {
    let h = href.trim();
    if h.is_empty() {
        return None;
    }
    if h.contains("://") {
        return Some(h.to_string());
    }
    let b = parse(base)?;
    let authority = match b.port {
        Some(p) => format!("{}:{}", b.host, p),
        None => b.host.clone(),
    };
    if let Some(rest) = h.strip_prefix("//") {
        return Some(format!("{}://{}", b.scheme, rest));
    }
    if h.starts_with('/') {
        return Some(format!("{}://{}{}", b.scheme, authority, h));
    }
    let dir = match b.path.rfind('/') {
        Some(i) => &b.path[..=i],
        None => "/",
    };
    Some(format!("{}://{}{}{}", b.scheme, authority, dir, h))
}

/// Google News RSS returns wrapper URLs (`news.google.com/rss/articles/CBM…`)
/// rather than the publisher's link. Two different wrappers can point at one
/// story, which would defeat corroboration scoring — so the wrapper id is
/// the identity we key on, and the display host comes from the item's source
/// element instead. Returns `None` when this is not a wrapper.
pub fn google_news_id(input: &str) -> Option<String> {
    let p = parse(input)?;
    if !p.host.ends_with("news.google.com") {
        return None;
    }
    let seg = p.path.rsplit('/').find(|s| !s.is_empty())?;
    // The opaque id is long; short path segments are section pages.
    (seg.len() > 16).then(|| format!("gnews:{seg}"))
}

/// The identity a story is deduped on: the Google News wrapper id when there
/// is one, otherwise the canonical URL.
pub fn identity(input: &str) -> String {
    google_news_id(input).unwrap_or_else(|| canonicalize(input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ordinary_case() {
        let p = parse("https://Example.COM:443/a/b?x=1#frag").unwrap();
        assert_eq!(p.scheme, "https");
        assert_eq!(p.host, "example.com");
        assert_eq!(p.port, Some(443));
        assert_eq!(p.path, "/a/b");
        assert_eq!(p.fragment.as_deref(), Some("frag"));
    }

    #[test]
    fn userinfo_never_becomes_the_host() {
        // The classic origin-confusion payload.
        let p = parse("https://trusted.com@evil.test/x").unwrap();
        assert_eq!(p.host, "evil.test");
    }

    #[test]
    fn ipv6_literals_keep_their_brackets() {
        let p = parse("http://[2001:db8::1]:8080/x").unwrap();
        assert_eq!(p.host, "[2001:db8::1]");
        assert_eq!(p.port, Some(8080));
        let q = parse("http://[2001:db8::1]/x").unwrap();
        assert_eq!(q.host, "[2001:db8::1]");
        assert_eq!(q.port, None);
    }

    #[test]
    fn strips_trackers_and_normalises() {
        assert_eq!(
            canonicalize("https://www.example.com/post/?utm_source=x&id=7&fbclid=abc#top"),
            "https://example.com/post?id=7"
        );
    }

    #[test]
    fn canonicalisation_is_idempotent() {
        for u in [
            "https://www.a.test/x/?utm_medium=e&b=2&a=1",
            "http://a.test:80/",
            "https://a.test",
            "not a url at all",
            "https://[::1]:8443/p?z=1&utm_id=9",
        ] {
            let once = canonicalize(u);
            assert_eq!(once, canonicalize(&once), "not idempotent: {u}");
        }
    }

    #[test]
    fn bare_www_host_is_not_eaten() {
        // "www" alone is a hostname, not a prefix to strip.
        assert_eq!(canonicalize("http://www/x"), "http://www/x");
    }

    #[test]
    fn two_urls_for_one_story_agree() {
        let a = "https://www.site.test/story?utm_campaign=twitter";
        let b = "https://site.test/story/";
        assert_eq!(identity(a), identity(b));
    }

    #[test]
    fn google_news_wrappers_key_on_their_id() {
        let u = "https://news.google.com/rss/articles/CBMiVWh0dHBzOi8vd3d3LmV4YW1wbGU?oc=5";
        let id = identity(u);
        assert!(id.starts_with("gnews:"), "got {id}");
        // Same wrapper, different tracking suffix — one story.
        assert_eq!(
            id,
            identity("https://news.google.com/rss/articles/CBMiVWh0dHBzOi8vd3d3LmV4YW1wbGU?oc=9")
        );
    }

    #[test]
    fn webcal_becomes_https() {
        assert_eq!(
            normalize_webcal("webcal://a.test/c.ics"),
            "https://a.test/c.ics"
        );
        assert_eq!(
            normalize_webcal("https://a.test/c.ics"),
            "https://a.test/c.ics"
        );
    }

    #[test]
    fn resolves_relative_hrefs() {
        assert_eq!(
            resolve("https://a.test/blog/x", "/feed/").unwrap(),
            "https://a.test/feed/"
        );
        assert_eq!(
            resolve("https://a.test/blog/x", "rss").unwrap(),
            "https://a.test/blog/rss"
        );
        assert_eq!(
            resolve("https://a.test/blog/x", "//b.test/f").unwrap(),
            "https://b.test/f"
        );
        assert_eq!(
            resolve("https://a.test/", "https://c.test/f").unwrap(),
            "https://c.test/f"
        );
    }
}
