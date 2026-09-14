"""Turn the Public Suffix List into one Rust blob.

Emitted as a single newline-joined `&'static str` rather than a slice of
`&str`: 8,882 string slices would cost 142 KB in fat pointers alone, before
any of the actual text. One blob plus binary search over line offsets costs
the text and nothing else.

Only rules with two or more labels are kept. A single-label rule like `com`
needs no table — a host under it already resolves to `<name>.com` by taking
the last two labels, which is what the lookup falls back to.
"""
import hashlib
import re
import sys
from datetime import date

src, out = sys.argv[1], sys.argv[2]
raw = open(src, encoding="utf-8").read()

section = None
rules: list[str] = []
for line in raw.splitlines():
    t = line.strip()
    if "BEGIN ICANN DOMAINS" in t:
        section = "icann"; continue
    if "BEGIN PRIVATE DOMAINS" in t:
        section = "private"; continue
    if t.startswith("// ==END"):
        section = None; continue
    if not t or t.startswith("//"):
        continue
    if section is None:
        continue
    # Punycode only: hosts arrive already encoded, and carrying both forms
    # would double the table to no effect.
    if any(ord(c) > 127 for c in t):
        continue
    if t.count(".") < 1 and not t.startswith("*"):
        continue
    rules.append(t.lower())

rules = sorted(set(rules))
blob = "\n".join(rules)
digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

# Rust string literals cannot be arbitrarily long in practice for readability,
# so the blob is written as a concat! of chunked raw strings.
CHUNK = 4000
chunks = [blob[i : i + CHUNK] for i in range(0, len(blob), CHUNK)]
body = ",\n    ".join(f'r#"{c}"#' for c in chunks)

open(out, "w", encoding="utf-8").write(f'''//! The Public Suffix List, generated. Do not edit.
//!
//! Regenerate with `./scripts/update-psl.sh`.
//!
//! Source:  https://publicsuffix.org/list/public_suffix_list.dat
//! Fetched: {date.today().isoformat()}
//! Digest:  {digest}
//! Rules:   {len(rules)} (multi-label and wildcard only — a single-label rule
//!          needs no table, since the lookup already falls back to taking the
//!          last two labels)
//!
//! One newline-joined blob rather than a slice of `&str`. {len(rules)} string
//! slices would cost {len(rules) * 16 // 1024} KB in fat pointers before any of the
//! text; this costs the text.

/// Every rule, sorted, one per line. Includes `*.` wildcards and `!`
/// exceptions exactly as the list writes them.
pub const RULES: &str = concat!(
    {body}
);

/// The digest of the list this was generated from, so a staleness check can
/// compare without re-parsing.
pub const DIGEST: &str = "{digest}";

/// How many rules are in the blob.
pub const COUNT: usize = {len(rules)};
''')
print(f"{len(rules)} rules, {len(blob)/1024:.0f} KB of text → {out}")
