//! A scanner, not a parser.
//!
//! Feeds are XML in name only: publishers ship unescaped ampersands, stray
//! `<br>`, mismatched namespaces and CDATA wrapping HTML. A conforming parser
//! rejects a meaningful fraction of the real web, and a rejected feed is a
//! blank group the user cannot debug. So this scans for the elements we want
//! and tolerates everything around them.
//!
//! Namespace prefixes are stripped (`dc:date` matches `date`) because the
//! prefix a feed chooses is not stable across publishers.

/// An element's attributes, local-name keyed.
pub type Attrs = Vec<(String, String)>;

/// What `scan_attrs` returns: the attributes, the index just past the open
/// tag, and whether the tag closed itself.
type OpenTag = (Attrs, usize, bool);

#[derive(Debug, Clone)]
pub struct Element<'a> {
    pub attrs: Attrs,
    pub inner: &'a str,
}

impl Element<'_> {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Find `needle` in `hay` at or after `from`, in byte space.
///
/// Every marker this scanner looks for is ASCII, but the documents are not:
/// a real page is full of `·`, `—` and `’`. Slicing a `&str` at a scanned
/// byte index panics the moment that index lands inside a multi-byte
/// character — which is exactly what happened on a TechCrunch category page,
/// inside a `·` at byte 26523. Scanning in byte space cannot have that bug,
/// and `&str` is only ever built at indices bounded by ASCII markers.
fn find_bytes(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() || needle.is_empty() || hay.len() - from < needle.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// Skip a comment or CDATA section starting at `i`; returns the index after
/// it, or `None` when `i` does not start one.
fn skip_span(b: &[u8], i: usize) -> Option<usize> {
    for (open, close) in [
        (&b"<!--"[..], &b"-->"[..]),
        (&b"<![CDATA["[..], &b"]]>"[..]),
    ] {
        if b[i..].starts_with(open) {
            return Some(find_bytes(b, close, i + open.len()).map_or(b.len(), |p| p + close.len()));
        }
    }
    None
}

/// Strip a namespace prefix: `dc:date` -> `date`.
fn local_name(tag: &str) -> &str {
    tag.rsplit(':').next().unwrap_or(tag)
}

/// Does the tag at `s[i..]` open an element named `name`?
/// Returns (name_end, is_self_closing_candidate).
fn tag_name_at(s: &str, i: usize) -> Option<(&str, usize)> {
    let b = s.as_bytes();
    if b.get(i) != Some(&b'<') {
        return None;
    }
    let start = i + 1;
    if start >= b.len() || !(b[start].is_ascii_alphabetic() || b[start] == b'_') {
        return None;
    }
    let mut j = start;
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b"_-:.".contains(&b[j])) {
        j += 1;
    }
    Some((&s[start..j], j))
}

/// Every element named `name`, at any depth, non-overlapping and in order.
/// Nested same-name elements are handled by depth counting, so an `<entry>`
/// containing another `<entry>` yields the outer one only.
pub fn elements<'a>(xml: &'a str, name: &str) -> Vec<Element<'a>> {
    let mut out = Vec::new();
    let b = xml.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        // Skip comments and CDATA wholesale so their contents never look
        // like markup.
        if let Some(next) = skip_span(b, i) {
            i = next;
            continue;
        }
        let Some((tag, name_end)) = tag_name_at(xml, i) else {
            i += 1;
            continue;
        };
        if !local_name(tag).eq_ignore_ascii_case(name) {
            i = name_end;
            continue;
        }
        // Find the end of the open tag, respecting quoted attribute values.
        let Some((attrs, open_end, self_closing)) = scan_attrs(xml, name_end) else {
            i = name_end;
            continue;
        };
        if self_closing {
            out.push(Element { attrs, inner: "" });
            i = open_end;
            continue;
        }
        match find_close(xml, open_end, local_name(tag)) {
            Some((inner_end, after)) => {
                out.push(Element {
                    attrs,
                    inner: &xml[open_end..inner_end],
                });
                i = after;
            }
            None => {
                // Unclosed: take the rest and stop, rather than dropping it.
                out.push(Element {
                    attrs,
                    inner: &xml[open_end..],
                });
                break;
            }
        }
    }
    out
}

fn scan_attrs(s: &str, from: usize) -> Option<OpenTag> {
    let b = s.as_bytes();
    let mut i = from;
    let mut attrs: Attrs = Vec::new();
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return None;
        }
        if b[i] == b'>' {
            return Some((attrs, i + 1, false));
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'>') {
            return Some((attrs, i + 2, true));
        }
        // attribute name
        let ns = i;
        while i < b.len()
            && !b[i].is_ascii_whitespace()
            && b[i] != b'='
            && b[i] != b'>'
            && b[i] != b'/'
        {
            i += 1;
        }
        if i == ns {
            i += 1;
            continue;
        }
        let key = local_name(&s[ns..i]).to_string();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if b.get(i) != Some(&b'=') {
            attrs.push((key, String::new()));
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let value = match b.get(i) {
            Some(&q @ (b'"' | b'\'')) => {
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                let v = &s[vs..i.min(b.len())];
                i = (i + 1).min(b.len());
                v
            }
            _ => {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                    i += 1;
                }
                &s[vs..i]
            }
        };
        attrs.push((key, decode_entities(value)));
    }
}

/// Find the matching close tag, counting nested opens of the same name.
/// Returns (inner_end, index_after_close).
fn find_close(s: &str, from: usize, name: &str) -> Option<(usize, usize)> {
    let b = s.as_bytes();
    let mut depth = 1usize;
    let mut i = from;
    while i < b.len() {
        if let Some(next) = skip_span(b, i) {
            i = next;
            continue;
        }
        if b[i] == b'<' && b.get(i + 1) == Some(&b'/') {
            // A close tag: the name starts after "</", so scan it here
            // rather than through tag_name_at, which expects a '<'.
            let ns = i + 2;
            let mut ne = ns;
            while ne < b.len() && (b[ne].is_ascii_alphanumeric() || b"_-:.".contains(&b[ne])) {
                ne += 1;
            }
            if ne > ns {
                let tag = &s[ns..ne];
                if local_name(tag).eq_ignore_ascii_case(name) {
                    depth -= 1;
                    let after = s[ne..].find('>').map_or(b.len(), |p| ne + p + 1);
                    if depth == 0 {
                        return Some((i, after));
                    }
                    i = after;
                    continue;
                }
                i = ne;
                continue;
            }
        } else if let Some((tag, ne)) = tag_name_at(s, i) {
            if local_name(tag).eq_ignore_ascii_case(name) {
                if let Some((_, oe, self_closing)) = scan_attrs(s, ne) {
                    if !self_closing {
                        depth += 1;
                    }
                    i = oe;
                    continue;
                }
            }
            i = ne;
            continue;
        }
        i += 1;
    }
    None
}

/// The first direct-or-nested child element with this name.
pub fn child<'a>(inner: &'a str, name: &str) -> Option<Element<'a>> {
    elements(inner, name).into_iter().next()
}

/// Text content: CDATA unwrapped, tags removed, entities decoded, whitespace
/// collapsed. What ends up on screen.
pub fn text(inner: &str) -> String {
    // Two passes. CDATA in a feed is not a request to treat its contents as
    // opaque — publishers use it precisely to carry HTML through XML, so it
    // is unwrapped first and then stripped like any other markup.
    let unwrapped = unwrap_cdata(inner);
    collapse_ws(&decode_entities(&strip_tags(&unwrapped)))
}

fn unwrap_cdata(inner: &str) -> String {
    if !inner.contains("<![CDATA[") {
        return inner.to_string();
    }
    let mut out = String::with_capacity(inner.len());
    let mut rest = inner;
    while let Some(start) = rest.find("<![CDATA[") {
        out.push_str(&rest[..start]);
        let body = &rest[start + 9..];
        match body.find("]]>") {
            Some(end) => {
                out.push_str(&body[..end]);
                rest = &body[end + 3..];
            }
            None => {
                out.push_str(body);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_tags(inner: &str) -> String {
    // Bytes in, bytes out. The only characters this inspects are ASCII, and
    // everything else is copied through untouched, so multi-byte sequences
    // survive intact without ever being indexed into.
    let mut out: Vec<u8> = Vec::with_capacity(inner.len());
    let b = inner.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i..].starts_with(b"<!--") {
            i = find_bytes(b, b"-->", i + 4).map_or(b.len(), |p| p + 3);
            continue;
        }
        if b[i] == b'<' && tag_name_or_close(inner, i) {
            // A real tag: skip it, respecting quoted attributes.
            let mut j = i + 1;
            let mut quote = 0u8;
            while j < b.len() {
                let c = b[j];
                if quote != 0 {
                    if c == quote {
                        quote = 0;
                    }
                } else if c == b'"' || c == b'\'' {
                    quote = c;
                } else if c == b'>' {
                    break;
                }
                j += 1;
            }
            out.push(b' ');
            i = (j + 1).min(b.len());
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A bare `<` in prose (`a < b`) is not a tag. Only treat it as markup when
/// a name or `/` follows.
fn tag_name_or_close(s: &str, i: usize) -> bool {
    let b = s.as_bytes();
    match b.get(i + 1) {
        Some(&c) if c == b'/' || c == b'!' || c == b'?' => true,
        Some(&c) if c.is_ascii_alphabetic() => true,
        _ => false,
    }
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            space = true;
        } else {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(c);
        }
    }
    out
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] != b'&' {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
            continue;
        }
        let Some(semi) = s[i..].find(';').filter(|p| *p <= 12) else {
            out.push('&');
            i += 1;
            continue;
        };
        let ent = &s[i + 1..i + semi];
        let replacement = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "hellip" => Some('…'),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "rsquo" | "#8217" => Some('\''),
            "lsquo" => Some('\''),
            "ldquo" => Some('"'),
            "rdquo" => Some('"'),
            _ => ent
                .strip_prefix('#')
                .and_then(|n| {
                    n.strip_prefix('x')
                        .or_else(|| n.strip_prefix('X'))
                        .and_then(|h| u32::from_str_radix(h, 16).ok())
                        .or_else(|| n.parse::<u32>().ok())
                })
                .and_then(char::from_u32),
        };
        match replacement {
            Some(c) => {
                out.push(c);
                i += semi + 1;
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_elements_and_attributes() {
        let x = r#"<feed><entry a="1"><title>Hi</title></entry><entry a='2'/></feed>"#;
        let e = elements(x, "entry");
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].attr("a"), Some("1"));
        assert_eq!(e[1].attr("a"), Some("2"));
        assert_eq!(text(e[0].inner), "Hi");
    }

    #[test]
    fn namespace_prefixes_are_ignored() {
        let x = "<item><dc:date>2026-01-01</dc:date></item>";
        assert_eq!(text(child(x, "date").unwrap().inner), "2026-01-01");
    }

    #[test]
    fn cdata_is_unwrapped_then_stripped_like_any_markup() {
        // Publishers use CDATA to carry HTML through XML, so its contents
        // are display markup, not opaque text. The bare `&` still survives.
        let x = "<title><![CDATA[A & B <b>bold</b>]]></title>";
        assert_eq!(text(child(x, "title").unwrap().inner), "A & B bold");
    }

    #[test]
    fn html_in_descriptions_becomes_plain_text() {
        let x = "<d>Hello <b>world</b>&nbsp;&amp; more<br/>done</d>";
        assert_eq!(
            text(child(x, "d").unwrap().inner),
            "Hello world & more done"
        );
    }

    #[test]
    fn a_bare_less_than_in_prose_survives() {
        let x = "<d>if a < b then</d>";
        assert_eq!(text(child(x, "d").unwrap().inner), "if a < b then");
    }

    #[test]
    fn nested_same_name_elements_do_not_split_the_parent() {
        let x = "<entry><content><entry>inner</entry></content></entry>";
        let e = elements(x, "entry");
        assert_eq!(e.len(), 1, "outer entry must not be cut at the inner close");
        assert!(e[0].inner.contains("inner"));
    }

    #[test]
    fn numeric_and_hex_entities_decode() {
        assert_eq!(decode_entities("a&#39;b&#x27;c&amp;d"), "a'b'c&d");
    }

    #[test]
    fn a_lone_ampersand_is_left_alone() {
        // Publishers ship these constantly; a strict parser would reject.
        assert_eq!(decode_entities("Q & A &notanentity"), "Q & A &notanentity");
    }

    #[test]
    fn multibyte_characters_do_not_panic_the_scanner() {
        // The shipped crash: a real page carries `·`, `—`, `’` and emoji, and
        // a byte-wise scanner that slices &str dies inside one of them.
        let x = "<html><head>\
            <!-- a comment with · and — and ’ and 🎉 -->\
            <link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed/\">\
            <p>Tech · Crunch — “smart quotes” … 日本語 🎉</p>\
            </head></html>";
        let links = elements(x, "link");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].attr("href"), Some("/feed/"));
        assert!(text(child(x, "p").unwrap().inner).contains("日本語"));
    }

    #[test]
    fn a_multibyte_char_at_every_offset_is_survivable() {
        // Walk a multi-byte character through every byte position so no
        // single index can be the one that breaks.
        for pad in 0..40 {
            let doc = format!("{}·<item><title>ok</title></item>", "x".repeat(pad));
            let items = elements(&doc, "item");
            assert_eq!(items.len(), 1, "failed at pad {pad}");
            assert_eq!(text(items[0].inner), "ok");
        }
    }

    #[test]
    fn multibyte_text_survives_tag_stripping_intact() {
        let x = "<d>Café — 北京 · <b>90%</b> 🎉</d>";
        assert_eq!(text(child(x, "d").unwrap().inner), "Café — 北京 · 90% 🎉");
    }

    #[test]
    fn unclosed_elements_do_not_lose_content() {
        let x = "<rss><item><title>Kept</title></rss>";
        let items = elements(x, "item");
        assert_eq!(items.len(), 1);
        assert!(items[0].inner.contains("Kept"));
    }
}
