//! End-to-end over the real router and a real (in-memory) database.
//!
//! Nothing is mocked. The point of most of these is not that the happy path
//! works — it is that the boundary holds when the caller is not the extension
//! being polite.

use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::{Signer, SigningKey};
use tower::ServiceExt;

const SECRET: &[u8] = b"a-test-secret-of-at-least-32-bytes!!";
const NOW_ISH: i64 = 4_000_000_000;
const KID: &str = "test-key-1";

/// The platform's signing key, as these tests stand in for it. Deterministic
/// so a token minted here verifies against the key set below without either
/// being written down twice.
fn platform_key() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32])
}

fn app() -> Shared {
    let mut keys = auth::KeySet::new();
    keys.insert(KID.to_string(), platform_key().verifying_key());
    Arc::new(App {
        store: Store::memory().unwrap(),
        secret: SECRET.to_vec(),
        verifier: auth::Verifier::fixed(keys),
        moderators: vec!["acct_mod".into()],
    })
}

/// A bearer token exactly as the platform mints one: EdDSA, with a `kid`.
fn bearer(sub: &str) -> String {
    let h = auth::b64url_encode(
        serde_json::json!({ "alg": "EdDSA", "typ": "JWT", "kid": KID })
            .to_string()
            .as_bytes(),
    );
    let p = auth::b64url_encode(
        serde_json::json!({ "sub": sub, "sid": "sess_test", "exp": NOW_ISH })
            .to_string()
            .as_bytes(),
    );
    let sig = platform_key().sign(format!("{h}.{p}").as_bytes());
    format!("Bearer {h}.{p}.{}", auth::b64url_encode(&sig.to_bytes()))
}

fn pack_json(id: &str, name: &str) -> serde_json::Value {
    serde_json::json!({
        "pack": {
            "format": 1,
            "kind": "group",
            "id": id,
            "name": name,
            "description": "Twelve good sources for this subject, ranked by corroboration.",
            "author": "someone",
            "tags": ["ai"],
            "instances": [{
                "def": "topic", "id": id, "name": name, "enabled": true,
                "opts": { "query": name, "sources": [{ "kind": "query", "tmpl": "googlenews", "weight": 1.0 }] }
            }]
        }
    })
}

async fn call(app: Shared, req: Request<Body>) -> (StatusCode, serde_json::Value) {
    let res = router(app).oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 22)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, body)
}

fn post(path: &str, auth: Option<&str>, body: serde_json::Value) -> Request<Body> {
    let mut b = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(a) = auth {
        b = b.header("authorization", a);
    }
    b.body(Body::from(body.to_string())).unwrap()
}

fn get(path: &str, auth: Option<&str>) -> Request<Body> {
    let mut b = Request::builder().method("GET").uri(path);
    if let Some(a) = auth {
        b = b.header("authorization", a);
    }
    b.body(Body::empty()).unwrap()
}

// ---------- publishing ----------

#[tokio::test]
async fn publishing_needs_an_account() {
    let a = app();
    let (status, _) = call(a, post("/v1/packs", None, pack_json("ai", "AI"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_published_pack_can_be_browsed_and_installed() {
    let a = app();
    let (status, _) = call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_, list) = call(a.clone(), get("/v1/packs", None)).await;
    assert_eq!(list["listings"].as_array().unwrap().len(), 1);
    assert_eq!(list["listings"][0]["name"], "AI");

    let (status, pack) = call(a.clone(), get("/v1/packs/ai/install", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(pack["instances"][0]["def"], "topic");

    // Installing is what the counter counts.
    let (_, detail) = call(a, get("/v1/packs/ai", None)).await;
    assert_eq!(detail["listing"]["installs"], 1);
}

#[tokio::test]
async fn the_server_cleans_a_pack_even_when_the_client_did_not() {
    // The extension cleans on the way out as a convenience for the publisher.
    // This is the boundary, and a boundary that trusts its client is not one.
    let a = app();
    let mut body = pack_json("leaky", "Leaky");
    body["pack"]["instances"][0]["opts"]["apiKey"] =
        serde_json::json!("sk-live-should-not-survive");
    body["pack"]["image"] = serde_json::json!("javascript:alert(1)");

    // A publisher who pasted a `javascript:` URL is told, rather than having
    // it silently dropped — they chose to put it there and should know it did
    // not go in.
    let (status, e) = call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(e["problems"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["field"] == "image"));

    // A key is different: nobody puts one in a pack on purpose, so it is
    // stripped without a word rather than made into a thing to argue about.
    let mut fixed = body;
    fixed["pack"]["image"] = serde_json::Value::Null;
    let (status, _) = call(a.clone(), post("/v1/packs", Some(&bearer("acct_1")), fixed)).await;
    assert_eq!(status, StatusCode::OK);

    let (_, pack) = call(a, get("/v1/packs/leaky/install", None)).await;
    let opts = pack["instances"][0]["opts"].as_object().unwrap();
    assert!(
        !opts.contains_key("apiKey"),
        "a key must never survive the server"
    );
    assert!(pack["image"].is_null());
}

#[tokio::test]
async fn a_pack_with_no_description_is_refused_with_the_field_named() {
    let a = app();
    let mut body = pack_json("thin", "Thin");
    body["pack"]["description"] = serde_json::json!("x");
    let (status, err) = call(a, post("/v1/packs", Some(&bearer("acct_1")), body)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(err["problems"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["field"] == "description"));
}

#[tokio::test]
async fn one_account_cannot_take_over_another_s_listing() {
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;

    let mut theirs = pack_json("ai", "AI");
    theirs["pack"]["description"] = serde_json::json!("Replaced by somebody else entirely.");
    let (status, _) = call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_2")), theirs),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (_, detail) = call(a, get("/v1/packs/ai", None)).await;
    assert!(detail["listing"]["description"]
        .as_str()
        .unwrap()
        .contains("Twelve good sources"));
}

#[tokio::test]
async fn the_owner_may_edit_and_keeps_the_counters_they_earned() {
    // Otherwise fixing a typo erases your own reception.
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;
    call(
        a.clone(),
        post(
            "/v1/packs/ai/like",
            Some(&bearer("acct_2")),
            serde_json::json!({}),
        ),
    )
    .await;
    call(a.clone(), get("/v1/packs/ai/install", None)).await;

    let mut edited = pack_json("ai", "AI");
    edited["pack"]["description"] =
        serde_json::json!("A better description of the very same pack.");
    let (status, listing) = call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), edited),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listing["likes"], 1);
    assert_eq!(listing["installs"], 1);
    assert!(listing["description"]
        .as_str()
        .unwrap()
        .starts_with("A better"));
}

#[tokio::test]
async fn editing_does_not_reset_the_publication_date() {
    // An edit that looked like a new listing would be a way to keep retaking
    // the trending page.
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;
    let (_, first) = call(a.clone(), get("/v1/packs/ai", None)).await;

    let mut edited = pack_json("ai", "AI");
    edited["pack"]["description"] = serde_json::json!("Edited, but not republished from scratch.");
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), edited),
    )
    .await;
    let (_, after) = call(a, get("/v1/packs/ai", None)).await;
    assert_eq!(first["listing"]["published"], after["listing"]["published"]);
    assert!(after["listing"]["updated"].as_i64() >= first["listing"]["updated"].as_i64());
}

#[tokio::test]
async fn a_publishing_spree_is_stopped_at_the_daily_allowance() {
    let a = app();
    for i in 0..tabs_market::PUBLISH_PER_DAY {
        let (status, _) = call(
            a.clone(),
            post(
                "/v1/packs",
                Some(&bearer("acct_1")),
                pack_json(&format!("p{i}"), &format!("Pack {i}")),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "pack {i}");
    }
    let (status, _) = call(
        a.clone(),
        post(
            "/v1/packs",
            Some(&bearer("acct_1")),
            pack_json("one-too-many", "One too many"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

    // The allowance is per account, not global.
    let (status, _) = call(
        a,
        post(
            "/v1/packs",
            Some(&bearer("acct_2")),
            pack_json("theirs", "Theirs"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn spam_is_held_back_from_the_public_list_rather_than_dropped() {
    let a = app();
    let mut spam = pack_json("deals", "Deals");
    spam["pack"]["description"] =
        serde_json::json!("http://a.test http://b.test http://c.test http://d.test http://e.test");
    let (status, _) = call(a.clone(), post("/v1/packs", Some(&bearer("acct_1")), spam)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the publisher is not told they were caught"
    );

    let (_, list) = call(a.clone(), get("/v1/packs", None)).await;
    assert!(list["listings"].as_array().unwrap().is_empty());
    let (status, _) = call(a, get("/v1/packs/deals", None)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------- likes ----------

#[tokio::test]
async fn liking_needs_an_account_and_counts_once() {
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;

    let (status, _) = call(
        a.clone(),
        post("/v1/packs/ai/like", None, serde_json::json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    for _ in 0..5 {
        call(
            a.clone(),
            post(
                "/v1/packs/ai/like",
                Some(&bearer("acct_2")),
                serde_json::json!({}),
            ),
        )
        .await;
    }
    let (_, detail) = call(a.clone(), get("/v1/packs/ai", None)).await;
    assert_eq!(
        detail["listing"]["likes"], 1,
        "five clicks are still one like"
    );

    call(
        a.clone(),
        post(
            "/v1/packs/ai/like",
            Some(&bearer("acct_3")),
            serde_json::json!({}),
        ),
    )
    .await;
    let (_, detail) = call(a, get("/v1/packs/ai", None)).await;
    assert_eq!(detail["listing"]["likes"], 2);
}

#[tokio::test]
async fn a_like_can_be_withdrawn_and_the_count_never_goes_negative() {
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;
    call(
        a.clone(),
        post(
            "/v1/packs/ai/like",
            Some(&bearer("acct_2")),
            serde_json::json!({}),
        ),
    )
    .await;

    let unlike = Request::builder()
        .method("DELETE")
        .uri("/v1/packs/ai/like")
        .header("authorization", bearer("acct_2"))
        .body(Body::empty())
        .unwrap();
    call(a.clone(), unlike).await;

    // Twice, to prove the second does not underflow.
    let again = Request::builder()
        .method("DELETE")
        .uri("/v1/packs/ai/like")
        .header("authorization", bearer("acct_2"))
        .body(Body::empty())
        .unwrap();
    call(a.clone(), again).await;

    let (_, detail) = call(a, get("/v1/packs/ai", None)).await;
    assert_eq!(detail["listing"]["likes"], 0);
}

#[tokio::test]
async fn signed_out_is_reported_as_unknown_rather_than_as_not_liked() {
    // The page draws the two differently: an outline heart versus an
    // invitation to sign in.
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;

    let (_, anon) = call(a.clone(), get("/v1/packs/ai", None)).await;
    assert!(anon["liked"].is_null());

    let (_, signed) = call(a.clone(), get("/v1/packs/ai", Some(&bearer("acct_2")))).await;
    assert_eq!(signed["liked"], false);

    call(
        a.clone(),
        post(
            "/v1/packs/ai/like",
            Some(&bearer("acct_2")),
            serde_json::json!({}),
        ),
    )
    .await;
    let (_, after) = call(a, get("/v1/packs/ai", Some(&bearer("acct_2")))).await;
    assert_eq!(after["liked"], true);
}

#[tokio::test]
async fn liking_something_that_does_not_exist_is_a_404_not_a_new_row() {
    let a = app();
    let (status, _) = call(
        a.clone(),
        post(
            "/v1/packs/nope/like",
            Some(&bearer("acct_1")),
            serde_json::json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_database_cannot_answer_what_an_account_has_liked() {
    // The privacy claim, asserted against the schema rather than the prose.
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;
    call(
        a.clone(),
        post(
            "/v1/packs/ai/like",
            Some(&bearer("acct_2")),
            serde_json::json!({}),
        ),
    )
    .await;

    // Asserted against the schema, so a column added later fails here rather
    // than quietly turning the claim into a false one.
    assert_eq!(
        a.store.likes_columns().unwrap(),
        vec!["token".to_string()],
        "a like is a token and nothing else"
    );

    let stored = a.store.like_tokens().unwrap();
    assert_eq!(stored.len(), 1);
    assert!(
        !stored[0].contains("acct_2"),
        "the account id must not be recoverable"
    );
    assert_eq!(stored[0].len(), 64);
}

// ---------- browsing ----------

#[tokio::test]
async fn browsing_searches_filters_and_sorts() {
    let a = app();
    call(
        a.clone(),
        post(
            "/v1/packs",
            Some(&bearer("acct_1")),
            pack_json("ai", "AI research"),
        ),
    )
    .await;
    let mut re = pack_json("real-estate", "Real estate");
    re["pack"]["tags"] = serde_json::json!(["property"]);
    call(a.clone(), post("/v1/packs", Some(&bearer("acct_1")), re)).await;

    let (_, hit) = call(a.clone(), get("/v1/packs?q=research", None)).await;
    assert_eq!(hit["listings"].as_array().unwrap().len(), 1);

    let (_, tagged) = call(a.clone(), get("/v1/packs?tag=property", None)).await;
    assert_eq!(tagged["listings"][0]["id"], "real-estate");

    let (_, all) = call(a.clone(), get("/v1/packs?sort=new", None)).await;
    assert_eq!(all["listings"].as_array().unwrap().len(), 2);
    assert_eq!(all["total"], 2);

    // The tag row comes back with counts, for the filter chips.
    let tags = all["tags"].as_array().unwrap();
    assert!(tags.iter().any(|t| t["tag"] == "ai" && t["count"] == 1));
}

#[tokio::test]
async fn an_unreasonable_page_size_is_capped() {
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;
    let (status, body) = call(a, get("/v1/packs?limit=100000", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["listings"].as_array().unwrap().len() <= 100);
}

#[tokio::test]
async fn a_missing_pack_is_a_404_rather_than_an_empty_success() {
    let a = app();
    for path in ["/v1/packs/nope", "/v1/packs/nope/install"] {
        let (status, _) = call(a.clone(), get(path, None)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

// ---------- moderation ----------

#[tokio::test]
async fn only_a_moderator_can_hide_and_the_route_denies_existing_to_others() {
    let a = app();
    call(
        a.clone(),
        post("/v1/packs", Some(&bearer("acct_1")), pack_json("ai", "AI")),
    )
    .await;

    // 404, not 403: an endpoint that admits it exists invites more attempts.
    let (status, _) = call(
        a.clone(),
        post(
            "/v1/packs/ai/moderate/hide",
            Some(&bearer("acct_9")),
            serde_json::json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = call(
        a.clone(),
        post(
            "/v1/packs/ai/moderate/hide",
            Some(&bearer("acct_mod")),
            serde_json::json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, list) = call(a.clone(), get("/v1/packs", None)).await;
    assert!(list["listings"].as_array().unwrap().is_empty());

    // Hiding is undoable, which is why it is not a delete.
    call(
        a.clone(),
        post(
            "/v1/packs/ai/moderate/show",
            Some(&bearer("acct_mod")),
            serde_json::json!({}),
        ),
    )
    .await;
    let (_, back) = call(a, get("/v1/packs", None)).await;
    assert_eq!(back["listings"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn health_needs_nothing_at_all_and_reports_whether_it_can_verify() {
    let (status, body) = call(app(), get("/health", None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);
    // The number that matters. Zero here means every publish and every like
    // will answer 401 while the service looks perfectly healthy from every
    // other angle — which is a morning nobody should have to spend.
    assert_eq!(body["keys"], 1);
}
