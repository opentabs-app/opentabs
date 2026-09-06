//! # tabs-core
//!
//! Every rule OpenTabs depends on, as pure functions: no I/O, no async, no
//! browser API. Compiles natively so `cargo test` covers it, and to
//! `wasm32-unknown-unknown` so the extension runs the *same* code — the
//! `shot-core` pattern OpenCapture already proves in this codebase.
//!
//! **The wasm never runs on the paint path.** It is loaded by the service
//! worker on an alarm, does the fetching-adjacent work, and writes finished
//! JSON to storage. The new tab page reads that JSON and paints. See
//! `apps/extension/src/background`.

#![forbid(unsafe_code)]

pub mod config;
pub mod feed;
pub mod ical;
pub mod nldate;
pub mod pack;
pub mod tabs;
pub mod trending;
pub mod url;
pub mod xdom;
pub mod xsearch;

#[cfg(target_arch = "wasm32")]
mod wasm;
