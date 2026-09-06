//! The marketplace API.
//!
//! Reading is open to everyone; writing needs an OpenApps account. The
//! account is used to answer exactly two questions — *may this person publish
//! right now* and *have they already liked this* — and is turned into an
//! opaque token before either is stored. See `store.rs` for what the schema
//! deliberately cannot answer.
//!
//! # Auth
//!
//! The client sends `Authorization: Bearer <token>` issued by OpenApps. This
//! service does not mint tokens and does not hold passwords; it verifies the
//! platform's Ed25519 signature against the key set the platform publishes,
//! and extracts a stable account id. [`auth::verify`] is where that happens,
//! and it is the one place to change when the platform's scheme changes.

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tabs_core::pack::{clean_pack, Pack};
use tabs_market::{browse, moderation, popular_tags, Listing, Sort};
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;

mod auth;
mod store;

use store::Store;

/// A pack document is text. A megabyte is already far more than a hundred
/// sources needs, and without a cap the parser is an amplifier.
const MAX_BODY: usize = 1 << 20;

pub struct App {
    store: Store,
    /// The HMAC key behind every token. Never written beside the tokens.
    secret: Vec<u8>,
    /// Checks the platform's signature on a bearer token. Holds public keys
    /// only — it can recognise an account, never impersonate one.
    verifier: auth::Verifier,
    /// Accounts allowed to hide a listing. Small and static on purpose.
    moderators: Vec<String>,
}

pub type Shared = Arc<App>;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- wire shapes ----------

#[derive(Debug, Deserialize)]
struct BrowseQuery {
    #[serde(default)]
    q: String,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    sort: Option<String>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct BrowseResponse {
    listings: Vec<Listing>,
    tags: Vec<TagCount>,
    total: usize,
}

#[derive(Debug, Serialize)]
struct TagCount {
    tag: String,
    count: usize,
}

#[derive(Debug, Serialize)]
struct DetailResponse {
    listing: Listing,
    pack: Pack,
    /// Whether the caller has liked this. `null` when not signed in — which
    /// is different from "no", and the page shows it differently.
    liked: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    problems: Vec<tabs_core::pack::PackProblem>,
}

fn err(status: StatusCode, message: &str) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: message.into(),
            problems: Vec::new(),
        }),
    )
}

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

// ---------- handlers ----------

async fn health() -> &'static str {
    "ok"
}

/// Browse and search. Open to everyone; no account, no cookie.
async fn get_listings(
    State(app): State<Shared>,
    Query(q): Query<BrowseQuery>,
) -> ApiResult<Json<BrowseResponse>> {
    let all = app.store.all_listings().map_err(|_| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not read the listings.",
        )
    })?;

    let sort = Sort::parse(q.sort.as_deref().unwrap_or("trending"));
    let visible = all.iter().filter(|l| !l.hidden).count();
    let listings = browse(
        &all,
        &q.q,
        q.tag.as_deref(),
        sort,
        now(),
        q.offset.unwrap_or(0),
        q.limit.unwrap_or(24),
    );
    Ok(Json(BrowseResponse {
        listings,
        tags: popular_tags(&all, 20)
            .into_iter()
            .map(|(tag, count)| TagCount { tag, count })
            .collect(),
        total: visible,
    }))
}

/// One listing, with the pack itself so the page can show what it contains.
async fn get_listing(
    State(app): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<DetailResponse>> {
    let listing = app
        .store
        .listing(&id)
        .map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read that listing.",
            )
        })?
        .filter(|l| !l.hidden)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "No such pack."))?;

    let json = app
        .store
        .pack_json(&id)
        .map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read that pack.",
            )
        })?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "No such pack."))?;
    let pack: Pack = serde_json::from_str(&json).map_err(|_| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "That pack is unreadable.",
        )
    })?;

    // Signed out is not the same as "has not liked it", and the page draws
    // the two differently — an outline heart versus an invitation to sign in.
    let liked = match app.verifier.account(&headers).await {
        Some(account) => {
            let token = tabs_market::like_token(&app.secret, &account, &id);
            Some(app.store.has_liked(&token).unwrap_or(false))
        }
        None => None,
    };

    Ok(Json(DetailResponse {
        listing,
        pack,
        liked,
    }))
}

/// The pack document alone, for the extension to install.
///
/// Counting the install here rather than on a separate call keeps the number
/// honest: it counts fetches by something that is about to apply it, not
/// clicks on a button that might have gone nowhere.
async fn install(State(app): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<Pack>> {
    let json = app
        .store
        .pack_json(&id)
        .map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read that pack.",
            )
        })?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "No such pack."))?;
    let pack: Pack = serde_json::from_str(&json).map_err(|_| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "That pack is unreadable.",
        )
    })?;
    let _ = app.store.count_install(&id);
    Ok(Json(pack))
}

#[derive(Debug, Deserialize)]
struct PublishBody {
    pack: Pack,
}

/// Publish or update. Requires an account.
async fn publish(
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<PublishBody>,
) -> ApiResult<Json<Listing>> {
    let account = app
        .verifier
        .account(&headers)
        .await
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Sign in to publish."))?;

    // Cleaned on the server as well as in the extension. The extension is a
    // convenience for whoever is publishing; this is the boundary, and a
    // boundary that trusts its client is not one.
    let (clean, problems) = clean_pack(&body.pack);
    if !problems.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                error: "That pack is not ready to publish.".into(),
                problems,
            }),
        ));
    }

    let owner = tabs_market::like_token(&app.secret, &account, "owner");
    let existing_owner = app.store.owner_token(&clean.id).unwrap_or(None);
    if let Some(current) = &existing_owner {
        if current != &owner {
            // Deliberately the same answer as "already taken" would be: it is
            // not this account's, and which of the two reasons applies is not
            // the caller's business.
            return Err(err(StatusCode::CONFLICT, "That name is taken."));
        }
    } else {
        // A new listing spends allowance; editing your own does not, or
        // fixing a typo would cost you a day's publishing.
        let recent = app
            .store
            .recent_publishes(&owner, now())
            .unwrap_or_default();
        if !tabs_market::may_publish(&recent, now()) {
            return Err(err(
                StatusCode::TOO_MANY_REQUESTS,
                "That is enough new packs for one day.",
            ));
        }
        let _ = app.store.note_publish(&owner, now());
    }

    let flags = moderation::flags(&clean.name, &clean.description, &clean.tags);
    let hidden = moderation::should_hold(&flags);

    let published = app
        .store
        .listing(&clean.id)
        .ok()
        .flatten()
        .map(|l| l.published)
        .unwrap_or_else(now);

    let listing = Listing {
        id: clean.id.clone(),
        kind: clean.kind.clone(),
        name: clean.name.clone(),
        description: clean.description.clone(),
        author: clean.author.clone(),
        tags: clean.tags.clone(),
        image: clean.image.clone(),
        video: clean.video.clone(),
        published,
        updated: now(),
        likes: 0,
        installs: 0,
        hidden,
    };
    let json = serde_json::to_string(&clean).map_err(|_| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not store that pack.",
        )
    })?;
    app.store
        .upsert(&listing, &json, &owner, hidden)
        .map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not store that pack.",
            )
        })?;

    // Re-read, so the response carries the counters it actually has rather
    // than the zeroes the insert statement names.
    let stored = app
        .store
        .listing(&clean.id)
        .ok()
        .flatten()
        .unwrap_or(listing);
    Ok(Json(stored))
}

#[derive(Debug, Serialize)]
struct LikeResponse {
    liked: bool,
    likes: u64,
}

async fn like(
    State(app): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<LikeResponse>> {
    set_like(app, id, headers, true).await
}

async fn unlike(
    State(app): State<Shared>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<LikeResponse>> {
    set_like(app, id, headers, false).await
}

async fn set_like(
    app: Shared,
    id: String,
    headers: HeaderMap,
    want: bool,
) -> ApiResult<Json<LikeResponse>> {
    let account = app
        .verifier
        .account(&headers)
        .await
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Sign in to like a pack."))?;
    if !app.store.exists(&id).unwrap_or(false) {
        return Err(err(StatusCode::NOT_FOUND, "No such pack."));
    }
    let token = tabs_market::like_token(&app.secret, &account, &id);
    if want {
        let _ = app.store.like(&token, &id);
    } else {
        let _ = app.store.unlike(&token, &id);
    }
    let likes = app
        .store
        .listing(&id)
        .ok()
        .flatten()
        .map(|l| l.likes)
        .unwrap_or(0);
    Ok(Json(LikeResponse { liked: want, likes }))
}

async fn moderate(
    State(app): State<Shared>,
    Path((id, action)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    let account = app
        .verifier
        .account(&headers)
        .await
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Sign in."))?;
    if !app.moderators.iter().any(|m| m == &account) {
        // 404 rather than 403: an endpoint that admits it exists to someone
        // who may not use it is an invitation to keep trying.
        return Err(err(StatusCode::NOT_FOUND, "No such route."));
    }
    match action.as_str() {
        "hide" => app.store.set_hidden(&id, true).ok(),
        "show" => app.store.set_hidden(&id, false).ok(),
        "delete" => app.store.delete(&id).ok(),
        _ => return Err(err(StatusCode::BAD_REQUEST, "Unknown action.")),
    };
    Ok(StatusCode::NO_CONTENT)
}

pub fn router(app: Shared) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/packs", get(get_listings).post(publish))
        .route("/v1/packs/:id", get(get_listing))
        .route("/v1/packs/:id/install", get(install))
        .route("/v1/packs/:id/like", post(like).delete(unlike))
        .route("/v1/packs/:id/moderate/:action", post(moderate))
        // The site is served from this same origin, so it needs no CORS at
        // all. The extension is a different origin and does: reading is
        // public to anyone, so the allow-list is `*` rather than a list of
        // extension ids that changes with every browser store.
        //
        // `*` is safe here precisely because nothing is authorised by a
        // cookie. Every write carries a bearer token the caller had to be
        // given, and a browser will not attach one on its own — which is the
        // property that makes a wildcard origin a CSRF risk when it is
        // ambient credentials that authorise.
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([Method::GET, Method::POST, Method::DELETE])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT])
                .max_age(std::time::Duration::from_secs(600)),
        )
        .layer(RequestBodyLimitLayer::new(MAX_BODY))
        .with_state(app)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db = std::env::var("MARKET_DB").unwrap_or_else(|_| "market.sqlite".into());
    // Where the platform publishes the public half of its signing key. A
    // default rather than a required variable, because getting it wrong is
    // silent — every write returns 401 and nothing says why.
    let jwks_url = std::env::var("MARKET_JWKS_URL")
        .unwrap_or_else(|_| "https://auth.opentabs.app/.well-known/jwks.json".into());
    let secret = std::env::var("MARKET_SECRET").unwrap_or_default();
    if secret.len() < 32 {
        // Refusing to start is the point. A weak or absent key makes every
        // like token guessable, which quietly turns the privacy argument in
        // `tabs-market` into a false claim — and a service that lies about
        // that is worse than one that will not run.
        eprintln!(
            "MARKET_SECRET must be set to at least 32 bytes.\n\
             It is the HMAC key that keeps like tokens from being reversible."
        );
        std::process::exit(2);
    }
    let moderators: Vec<String> = std::env::var("MARKET_MODERATORS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let app = Arc::new(App {
        store: Store::open(&db)?,
        secret: secret.into_bytes(),
        verifier: auth::Verifier::new(&jwks_url),
        moderators,
    });

    let port = std::env::var("PORT").unwrap_or_else(|_| "8787".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    eprintln!("marketplace api on :{port}, database {db}, keys from {jwks_url}");
    axum::serve(listener, router(app)).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
