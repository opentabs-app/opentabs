//! GitHub trending — parsing `github.com/trending`.
//!
//! Scraping this page is deliberate (decision D2). `robots.txt` contains no
//! mention of `/trending`, and the star-delta the page already computes is
//! the thing a database of daily snapshots was going to reinvent — at the
//! cost of a schema and a multi-day cold start before the group worked at
//! all.
//!
//! Living here rather than in `tabs-feedgen` is what lets a checked-in
//! fixture guard it: when GitHub changes the markup, a test fails instead of
//! a user's new tab going blank.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Repo {
    /// `owner/name`.
    pub repo: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub stars_today: u32,
    pub stars_total: u32,
}

fn strip_tags(s: &str) -> String {
    crate::feed::xml::text(s)
}

fn digits(s: &str) -> Option<u32> {
    let cleaned: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    cleaned.parse().ok()
}

/// Find the value of `attr` in an opening tag starting at `from`.
fn between<'a>(hay: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = hay.find(start)? + start.len();
    let j = hay[i..].find(end)? + i;
    Some(&hay[i..j])
}

/// Parse the trending page into repos, in page order (GitHub's own ranking).
pub fn parse(html: &str) -> Vec<Repo> {
    html.split("<article class=\"Box-row\"")
        .skip(1)
        .filter_map(|block| {
            // The repo link sits in the row's <h2>; take the first href that
            // looks like owner/name.
            let h2 = between(block, "<h2", "</h2>")?;
            let href = between(h2, "href=\"", "\"")?.trim_start_matches('/');
            let repo = href.trim_end_matches('/').to_string();
            if repo.is_empty() || repo.matches('/').count() != 1 {
                return None;
            }

            let description = between(block, "<p class=\"col-9", "</p>")
                .and_then(|p| p.split_once('>').map(|(_, rest)| rest))
                .map(strip_tags)
                .filter(|d| !d.is_empty());

            let language = between(block, "itemprop=\"programmingLanguage\">", "<")
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string);

            let stars_today = block
                .find(" stars today")
                .and_then(|i| {
                    let head = &block[..i];
                    let start = head.rfind('>')?;
                    digits(&head[start..])
                })
                .unwrap_or(0);

            // The first /stargazers link carries the total.
            //
            // Read the whole anchor and strip tags, rather than the text
            // between the tag's `>` and the next `<`. GitHub puts a star
            // `<svg>` inside the link before the number, so the naive slice
            // sees only the whitespace between the two elements and gives up
            // — every repo came back with a total of 0, on a page that shows
            // the number plainly. The fixture had the digits straight after
            // the `>`, which is what let it pass for so long.
            let stars_total = block
                .find("/stargazers")
                .and_then(|i| {
                    let tail = &block[i..];
                    let open_end = tail.find('>')? + 1;
                    let close = tail[open_end..].find("</a>")? + open_end;
                    digits(&strip_tags(&tail[open_end..close]))
                })
                .unwrap_or(0);

            Some(Repo {
                url: format!("https://github.com/{repo}"),
                repo,
                description,
                language,
                stars_today,
                stars_total,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape taken from the live page. If GitHub changes the markup, this is
    // what fails — which is the entire point of keeping the parser here.
    const ROW: &str = r##"
    <article class="Box-row">
      <h2 class="h3 lh-condensed">
        <a href="/tt-a1i/archify" data-view-component="true" class="Link">
          <svg aria-hidden="true"></svg>
          <span class="text-normal">tt-a1i /</span>
          archify
        </a>
      </h2>
      <p class="col-9 color-fg-muted my-1 pr-4">
        A tool for archiving &amp; indexing things.
      </p>
      <div class="f6 color-fg-muted mt-2">
        <span itemprop="programmingLanguage">JavaScript</span>
        <a href="/tt-a1i/archify/stargazers" class="Link--muted d-inline-block mr-3">
          12,483
        </a>
        <span class="d-inline-block float-sm-right">3,927 stars today</span>
      </div>
    </article>
    <article class="Box-row">
      <h2 class="h3 lh-condensed">
        <a href="/anthropics/claude-plugins-official">anthropics / claude-plugins-official</a>
      </h2>
      <div class="f6 color-fg-muted mt-2">
        <span itemprop="programmingLanguage">Python</span>
        <a href="/anthropics/claude-plugins-official/stargazers">1,204</a>
        <span>356 stars today</span>
      </div>
    </article>"##;

    #[test]
    fn parses_the_live_page_shape() {
        let r = parse(ROW);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].repo, "tt-a1i/archify");
        assert_eq!(r[0].url, "https://github.com/tt-a1i/archify");
        assert_eq!(r[0].language.as_deref(), Some("JavaScript"));
        assert_eq!(
            r[0].stars_today, 3927,
            "thousands separators must be stripped"
        );
        assert_eq!(r[0].stars_total, 12483);
        assert_eq!(
            r[0].description.as_deref(),
            Some("A tool for archiving & indexing things.")
        );
    }

    #[test]
    fn a_row_without_a_description_still_parses() {
        let r = parse(ROW);
        assert_eq!(r[1].repo, "anthropics/claude-plugins-official");
        assert_eq!(r[1].description, None);
        assert_eq!(r[1].stars_today, 356);
    }

    #[test]
    fn page_order_is_preserved_because_it_is_githubs_ranking() {
        let r = parse(ROW);
        assert_eq!(r[0].repo, "tt-a1i/archify");
    }

    #[test]
    fn changed_markup_yields_nothing_rather_than_garbage() {
        // The failure mode that must stay loud: no rows, not wrong rows.
        assert!(parse("<div class=\"something-else\">hello</div>").is_empty());
        assert!(parse("").is_empty());
    }

    #[test]
    fn non_repo_links_are_rejected() {
        let junk = r#"<article class="Box-row"><h2><a href="/trending">x</a></h2></article>"#;
        assert!(parse(junk).is_empty(), "owner/name has exactly one slash");
    }

    /// The star-count markup as GitHub actually serves it, October 2026.
    ///
    /// The difference from the hand-written fixture above is one `<svg>`:
    /// GitHub puts the star icon *inside* the anchor, before the number. The
    /// parser used to read the text between the anchor's `>` and the next
    /// `<`, which is the whitespace before that icon — so every repository
    /// on the real page reported a total of zero while five unit tests
    /// passed. Found by `examples/inspect.rs` against the live page.
    #[test]
    fn the_star_total_survives_an_icon_inside_the_link() {
        let html = r##"<article class="Box-row">
          <h2 class="h3 lh-condensed"><a href="/affaan-m/ECC">affaan-m / ECC</a></h2>
          <p class="col-9 color-fg-muted my-1 pr-4">The agent harness</p>
          <div class="f6 color-fg-muted mt-2">
            <span itemprop="programmingLanguage">JavaScript</span>
            <a href="/affaan-m/ECC/stargazers" class="Link Link--muted d-inline-block"><svg aria-label="star" role="img" height="16" viewBox="0 0 16 16" class="octicon octicon-star"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612Z"></path></svg>
              251,687
            </a>
            <span class="d-inline-block float-sm-right">1,485 stars today</span>
          </div>
        </article>"##;
        let r = parse(html);
        assert_eq!(r.len(), 1);
        assert_eq!(
            r[0].stars_total, 251_687,
            "the icon must not swallow the count"
        );
        assert_eq!(r[0].stars_today, 1_485);
    }
}
