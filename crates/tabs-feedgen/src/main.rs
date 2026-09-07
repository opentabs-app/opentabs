//! `tabs-feedgen` — writes the two static files OpenTabs serves (M9).
//!
//! This is the whole backend. No database, no API key, no model, no auth.
//! It writes into a directory the site deploy already serves, so
//! `opentabs.app/tabs/v1/*.json` needs no new DNS, certificate or vhost of
//! its own — the product site is already there.
//!
//!   tabs-feedgen --out /var/www/opentabs/tabs/v1
//!
//! Run it from cron. Both objects carry `generated_at`, and the client hides
//! any group whose data is past its staleness budget — so a dead cron
//! degrades the briefing instead of showing a stale one forever.

use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use serde_json::json;

const TRENDING_URL: &str = "https://github.com/trending";
const UA: &str = "OpenTabs-feedgen/0.1 (+https://opentabs.app/tabs)";

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The app catalogue — the release valve. Editing this and re-running makes a
/// new product appear on every user's new tab within a day, with no extension
/// update and no store review.
///
/// Products only. The accounts service used to be listed here as "OpenApps
/// ID — Account and credits", which put the platform's name on a page people
/// see fifty times a day, next to three things they might actually open. It
/// is not an app to discover, and signing in is a button in the masthead.
fn catalogue() -> serde_json::Value {
    json!({
        "generated_at": now(),
        "apps": [
            { "id": "opensubs",   "name": "OpenSubs",   "url": "https://app.opensubs.app/",
              "tagline": "Subtitles and translation" },
            { "id": "openpdfedit","name": "OpenPDFEdit","url": "https://app.openpdfedit.com/",
              "tagline": "Edit PDFs in the browser" },
            { "id": "opencapture","name": "OpenCapture","url": "https://opencapture.app/",
              "tagline": "Full-page screenshots" }
        ]
    })
}

fn fetch(url: &str) -> Result<String> {
    let body = ureq::get(url)
        .set("User-Agent", UA)
        .set("Accept", "text/html,application/xhtml+xml")
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .with_context(|| format!("GET {url}"))?
        .into_string()?;
    Ok(body)
}

fn write_json(dir: &PathBuf, name: &str, value: &serde_json::Value) -> Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(name);
    // Write-then-rename: a reader (nginx) never sees a half-written file.
    let tmp = dir.join(format!(".{name}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, &path)?;
    println!("wrote {}", path.display());
    Ok(())
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut out = PathBuf::from("./dist");
    while let Some(a) = args.next() {
        match a.as_str() {
            "--out" | "-o" => out = PathBuf::from(args.next().context("--out needs a path")?),
            "--help" | "-h" => {
                println!("tabs-feedgen --out <dir>");
                return Ok(());
            }
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }

    write_json(&out, "apps.json", &catalogue())?;

    // Trending is best-effort: if GitHub is unreachable or reshapes its
    // markup, keep the previous file rather than replacing it with an empty
    // one. An empty list would blank the group on every user's page.
    match fetch(TRENDING_URL) {
        Ok(html) => {
            let repos = tabs_core::trending::parse(&html);
            if repos.is_empty() {
                eprintln!(
                    "warning: parsed 0 repos from {TRENDING_URL} — markup may have changed; \
                     keeping the existing github-trending.json"
                );
            } else {
                println!("parsed {} trending repos", repos.len());
                write_json(
                    &out,
                    "github-trending.json",
                    &json!({ "generated_at": now(), "repos": repos }),
                )?;
            }
        }
        Err(e) => eprintln!("warning: trending fetch failed ({e}); keeping the existing file"),
    }
    Ok(())
}
