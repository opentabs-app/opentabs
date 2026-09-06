//! Turning an OpenApps access token into an account id.
//!
//! This service mints nothing and stores no credential. It receives a token
//! the platform issued and needs one fact from it: a stable identifier for
//! the account, used only to derive the opaque tokens in `tabs_market`.
//!
//! # The shape of the token
//!
//! OpenApps issues short-lived **EdDSA (Ed25519) JWTs** and publishes the
//! public half of the signing key at `/.well-known/jwks.json`. A compact JWS
//! — `header.payload.signature`, base64url — whose header names the `kid`
//! that signed it.
//!
//! Verifying against that key set rather than asking the platform on every
//! request means a browse costs one round trip instead of two, and the
//! marketplace keeps answering through a platform blip for as long as the
//! tokens already issued have left to live.
//!
//! An earlier version of this file verified HS256 against a secret shared
//! with the platform. That was wrong twice over. The platform does not sign
//! that way, so nothing it issued would ever have verified — and a symmetric
//! key means whoever can *check* a token can also *mint* one, which for a
//! service that only ever needs to check is a strictly worse trade. The
//! public key here cannot forge anything.
//!
//! # What is deliberately not done
//!
//! No claim other than the subject and the validity window is read, and
//! nothing from the token is stored. The account id exists in memory for the
//! length of one request and leaves as an HMAC digest.

use axum::http::HeaderMap;
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::HashMap;
use std::sync::RwLock;

/// The public keys, as fetched.
pub type KeySet = HashMap<String, VerifyingKey>;

/// How long a fetched key set is used before it is refreshed on its own.
/// Keys rotate rarely; this is about not pinning a revoked one for a day.
const REFRESH_AFTER: i64 = 600;

/// The floor between two fetches. Without it, a caller sending tokens with
/// made-up `kid`s turns this service into a request amplifier pointed at our
/// own auth server.
const REFRESH_FLOOR: i64 = 30;

/// Why a token was refused.
///
/// Only one of these is worth acting on — an unrecognised `kid` may simply
/// mean the platform rotated its key since we last looked. Every other
/// reason is final, and re-fetching would be a fetch per bad token.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// The signing key is not one we hold. Refresh and try once more.
    UnknownKey,
    /// Malformed, wrong algorithm, bad signature, expired, no subject.
    Invalid,
}

/// Verifies bearer tokens against a key set kept fresh from the platform.
pub struct Verifier {
    jwks_url: String,
    state: RwLock<Cached>,
}

#[derive(Default)]
struct Cached {
    keys: KeySet,
    /// When the last *attempt* was made — success or failure. A failed fetch
    /// must also hold the floor, or an auth server that is down gets hammered
    /// by exactly the traffic it cannot serve.
    attempted: i64,
}

impl Verifier {
    pub fn new(jwks_url: impl Into<String>) -> Self {
        Self {
            jwks_url: jwks_url.into(),
            state: RwLock::new(Cached::default()),
        }
    }

    /// A verifier that never fetches, holding the keys it is given. Used by
    /// the tests, and by nothing else.
    #[cfg(test)]
    pub fn fixed(keys: KeySet) -> Self {
        Self {
            jwks_url: String::new(),
            state: RwLock::new(Cached {
                keys,
                attempted: i64::MAX,
            }),
        }
    }

    /// Extract and verify the account id from an `Authorization: Bearer`
    /// header.
    ///
    /// Returns `None` for anything at all wrong — absent, malformed, expired,
    /// badly signed. The caller's response to all of those is the same, and
    /// distinguishing them for the client is free help for someone guessing.
    pub async fn account(&self, headers: &HeaderMap) -> Option<String> {
        let raw = headers.get("authorization")?.to_str().ok()?;
        let token = raw
            .strip_prefix("Bearer ")
            .or_else(|| raw.strip_prefix("bearer "))?
            .trim()
            .to_string();

        if self.stale() {
            self.refresh().await;
        }
        match self.with_keys(|keys| verify(&token, keys, now())) {
            Ok(sub) => Some(sub),
            Err(Refusal::Invalid) => None,
            Err(Refusal::UnknownKey) => {
                // The one refusal worth a second look: the platform may have
                // rotated its key since the last fetch.
                self.refresh().await;
                self.with_keys(|keys| verify(&token, keys, now())).ok()
            }
        }
    }

    /// Fetch the key set once, before the first request needs it.
    ///
    /// Two reasons, and the second is the real one. The first publish should
    /// not pay for a network round trip to a third party. And a service that
    /// only discovers at 3am that it cannot reach the platform is a service
    /// whose logs say nothing useful — this one says so at startup, when
    /// somebody is watching.
    pub async fn warm(&self) -> usize {
        self.refresh().await;
        self.key_status().0
    }

    /// How many signing keys are held, and when they were last fetched.
    ///
    /// Reported by `/health` because "every publish returns 401" has exactly
    /// one common cause — the key set never arrived — and that is not
    /// something an operator can work out from outside. A count and a
    /// timestamp; nothing about any account, and nothing secret. The public
    /// half of a signing key is published by the platform on purpose.
    pub fn key_status(&self) -> (usize, i64) {
        match self.state.read() {
            Ok(s) => (s.keys.len(), s.attempted),
            Err(_) => (0, 0),
        }
    }

    fn with_keys<T>(&self, f: impl FnOnce(&KeySet) -> T) -> T {
        match self.state.read() {
            Ok(s) => f(&s.keys),
            // A poisoned lock means a panic happened while holding it. An
            // empty key set refuses every token, which is the safe direction.
            Err(_) => f(&KeySet::new()),
        }
    }

    fn stale(&self) -> bool {
        self.state
            .read()
            .map(|s| s.keys.is_empty() || now() - s.attempted > REFRESH_AFTER)
            .unwrap_or(false)
    }

    async fn refresh(&self) {
        // Check and claim under one write lock. Splitting this into a read
        // that decides and a write that records leaves a window in which
        // every concurrent request passes the floor and fetches — the exact
        // stampede the floor exists to prevent.
        {
            let Ok(mut s) = self.state.write() else {
                return;
            };
            if now() - s.attempted < REFRESH_FLOOR {
                return;
            }
            s.attempted = now();
        }

        let url = self.jwks_url.clone();
        if url.is_empty() {
            return;
        }
        // `ureq` blocks. On a runtime worker that would stall every other
        // request on this thread for the length of a network round trip.
        let body = tokio::task::spawn_blocking(move || {
            ureq::get(&url)
                .timeout(std::time::Duration::from_secs(5))
                .call()
                .ok()?
                .into_string()
                .ok()
        })
        .await
        .ok()
        .flatten();

        let Some(keys) = body.as_deref().and_then(parse_jwks) else {
            // Keep the keys we have. A failed fetch is not a reason to start
            // refusing tokens that were verifying a second ago.
            return;
        };
        if keys.is_empty() {
            return;
        }
        if let Ok(mut s) = self.state.write() {
            s.keys = keys;
        }
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read an RFC 7517 key set, keeping only the Ed25519 signing keys.
///
/// Anything else in the document is skipped rather than refused: a key set
/// is allowed to carry keys for algorithms we do not implement, and a future
/// addition must not lock this service out.
pub fn parse_jwks(body: &str) -> Option<KeySet> {
    let doc: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut out = KeySet::new();
    for jwk in doc.get("keys")?.as_array()? {
        let get = |k: &str| jwk.get(k).and_then(|v| v.as_str());
        if get("kty") != Some("OKP") || get("crv") != Some("Ed25519") {
            continue;
        }
        if matches!(get("use"), Some(u) if u != "sig") {
            continue;
        }
        let (Some(kid), Some(x)) = (get("kid"), get("x")) else {
            continue;
        };
        let Some(bytes) = b64url_decode(x) else {
            continue;
        };
        let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice()) else {
            continue;
        };
        if let Ok(key) = VerifyingKey::from_bytes(&bytes) {
            out.insert(kid.to_string(), key);
        }
    }
    Some(out)
}

/// Verify a compact JWS and return its subject.
///
/// Pure, so the algorithm and validity rules are testable without a clock, a
/// server, or a network.
pub fn verify(token: &str, keys: &KeySet, now: i64) -> Result<String, Refusal> {
    let mut parts = token.split('.');
    let (Some(header_b64), Some(payload_b64), Some(sig_b64)) =
        (parts.next(), parts.next(), parts.next())
    else {
        return Err(Refusal::Invalid);
    };
    if parts.next().is_some() {
        return Err(Refusal::Invalid);
    }

    let header: serde_json::Value =
        serde_json::from_slice(&b64url_decode(header_b64).ok_or(Refusal::Invalid)?)
            .map_err(|_| Refusal::Invalid)?;
    // `alg: none` is the oldest trick there is, and an unpinned verifier
    // accepts it. Only the algorithm actually implemented here is allowed,
    // and it is asymmetric — so a header naming HS256 cannot talk this code
    // into treating a public key as a shared secret either.
    if header.get("alg").and_then(|v| v.as_str()) != Some("EdDSA") {
        return Err(Refusal::Invalid);
    }
    let kid = header
        .get("kid")
        .and_then(|v| v.as_str())
        .ok_or(Refusal::Invalid)?;
    // Reported apart from every other failure, because this is the one that
    // a key rotation causes and a re-fetch fixes.
    let key = keys.get(kid).ok_or(Refusal::UnknownKey)?;

    let sig = b64url_decode(sig_b64).ok_or(Refusal::Invalid)?;
    let sig = <[u8; 64]>::try_from(sig.as_slice()).map_err(|_| Refusal::Invalid)?;
    let signed = format!("{header_b64}.{payload_b64}");
    // `verify_strict` and not `verify`: it rejects small-order and
    // non-canonical public keys, which is what makes a signature check mean
    // one signer rather than a set of them.
    key.verify_strict(signed.as_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| Refusal::Invalid)?;

    let payload: serde_json::Value =
        serde_json::from_slice(&b64url_decode(payload_b64).ok_or(Refusal::Invalid)?)
            .map_err(|_| Refusal::Invalid)?;
    // A token with no expiry never stops working if it leaks, so an absent
    // `exp` is refused exactly like a past one.
    let exp = payload
        .get("exp")
        .and_then(|v| v.as_i64())
        .ok_or(Refusal::Invalid)?;
    if exp <= now {
        return Err(Refusal::Invalid);
    }
    if let Some(nbf) = payload.get("nbf").and_then(|v| v.as_i64()) {
        if nbf > now {
            return Err(Refusal::Invalid);
        }
    }

    let sub = payload
        .get("sub")
        .and_then(|v| v.as_str())
        .ok_or(Refusal::Invalid)?;
    if sub.is_empty() {
        return Err(Refusal::Invalid);
    }
    Ok(sub.to_string())
}

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Used by the test helpers that mint tokens; the server only ever decodes.
#[allow(dead_code)]
pub fn b64url_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        let take = chunk.len() + 1;
        for i in 0..take {
            out.push(B64[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
        }
    }
    out
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut bits = 0u32;
    let mut nbits = 0;
    let mut out = Vec::new();
    for c in s.bytes() {
        // Padding is optional in the compact form and absent in practice;
        // accepting it costs nothing and rejecting it surprises someone.
        if c == b'=' {
            continue;
        }
        let v = B64.iter().position(|&x| x == c)? as u32;
        bits = (bits << 6) | v;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((bits >> nbits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const NOW: i64 = 1_788_048_000;
    const KID: &str = "3f2a1b0c9d8e7f60";

    fn signer(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn key_set(seed: u8, kid: &str) -> KeySet {
        let mut keys = KeySet::new();
        keys.insert(kid.to_string(), signer(seed).verifying_key());
        keys
    }

    /// Mint a token the way the platform does.
    fn token(payload: serde_json::Value, key: &SigningKey, alg: &str, kid: Option<&str>) -> String {
        let header = match kid {
            Some(k) => serde_json::json!({ "alg": alg, "typ": "JWT", "kid": k }),
            None => serde_json::json!({ "alg": alg, "typ": "JWT" }),
        };
        let h = b64url_encode(header.to_string().as_bytes());
        let p = b64url_encode(payload.to_string().as_bytes());
        let sig = key.sign(format!("{h}.{p}").as_bytes());
        format!("{h}.{p}.{}", b64url_encode(&sig.to_bytes()))
    }

    fn valid() -> serde_json::Value {
        serde_json::json!({ "sub": "acct_123", "sid": "sess_1", "exp": NOW + 3600 })
    }

    #[test]
    fn a_good_token_yields_its_subject() {
        let t = token(valid(), &signer(7), "EdDSA", Some(KID));
        assert_eq!(verify(&t, &key_set(7, KID), NOW).unwrap(), "acct_123");
    }

    #[test]
    fn a_token_signed_by_another_key_is_refused() {
        // Same `kid`, different key: the signature check is what decides,
        // not the label the token puts on itself.
        let t = token(valid(), &signer(9), "EdDSA", Some(KID));
        assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::Invalid));
    }

    #[test]
    fn an_unknown_kid_is_reported_apart_so_it_can_be_retried() {
        let t = token(valid(), &signer(7), "EdDSA", Some("rotated-since"));
        assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::UnknownKey));
        // And a token with no `kid` at all is simply invalid — there is
        // nothing to go and fetch.
        let t = token(valid(), &signer(7), "EdDSA", None);
        assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::Invalid));
    }

    #[test]
    fn a_tampered_payload_is_refused() {
        let t = token(valid(), &signer(7), "EdDSA", Some(KID));
        let mut parts: Vec<&str> = t.split('.').collect();
        let forged = b64url_encode(
            serde_json::json!({ "sub": "acct_admin", "exp": NOW + 3600 })
                .to_string()
                .as_bytes(),
        );
        parts[1] = &forged;
        assert_eq!(
            verify(&parts.join("."), &key_set(7, KID), NOW),
            Err(Refusal::Invalid)
        );
    }

    #[test]
    fn alg_none_is_refused() {
        let h = b64url_encode(format!(r#"{{"alg":"none","typ":"JWT","kid":"{KID}"}}"#).as_bytes());
        let p = b64url_encode(valid().to_string().as_bytes());
        assert_eq!(
            verify(&format!("{h}.{p}."), &key_set(7, KID), NOW),
            Err(Refusal::Invalid)
        );
    }

    #[test]
    fn a_header_naming_hs256_cannot_borrow_the_public_key_as_a_secret() {
        // The classic confusion attack. It cannot work here because no
        // symmetric path exists at all — but the header check is what makes
        // that true rather than incidental, so it is asserted.
        let t = token(valid(), &signer(7), "HS256", Some(KID));
        assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::Invalid));
    }

    #[test]
    fn an_expired_token_is_refused() {
        let t = token(
            serde_json::json!({ "sub": "a", "exp": NOW - 1 }),
            &signer(7),
            "EdDSA",
            Some(KID),
        );
        assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::Invalid));
    }

    #[test]
    fn a_token_with_no_expiry_is_refused() {
        // One that never stops working is one that never stops working after
        // it leaks, either.
        let t = token(
            serde_json::json!({ "sub": "a" }),
            &signer(7),
            "EdDSA",
            Some(KID),
        );
        assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::Invalid));
    }

    #[test]
    fn a_token_not_yet_valid_is_refused() {
        let t = token(
            serde_json::json!({ "sub": "a", "exp": NOW + 3600, "nbf": NOW + 60 }),
            &signer(7),
            "EdDSA",
            Some(KID),
        );
        assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::Invalid));
        assert!(verify(&t, &key_set(7, KID), NOW + 61).is_ok());
    }

    #[test]
    fn a_token_with_no_subject_is_refused() {
        for p in [
            serde_json::json!({ "exp": NOW + 3600 }),
            serde_json::json!({ "sub": "", "exp": NOW + 3600 }),
        ] {
            let t = token(p, &signer(7), "EdDSA", Some(KID));
            assert_eq!(verify(&t, &key_set(7, KID), NOW), Err(Refusal::Invalid));
        }
    }

    #[test]
    fn malformed_tokens_are_refused_rather_than_panicking() {
        for t in ["", ".", "a.b", "a.b.c.d", "!!!.???.***", "a..c"] {
            assert_eq!(
                verify(t, &key_set(7, KID), NOW),
                Err(Refusal::Invalid),
                "{t}"
            );
        }
    }

    #[test]
    fn a_signature_of_the_wrong_length_is_refused_rather_than_panicking() {
        let t = token(valid(), &signer(7), "EdDSA", Some(KID));
        let mut parts: Vec<&str> = t.split('.').collect();
        parts[2] = "AAAA";
        assert_eq!(
            verify(&parts.join("."), &key_set(7, KID), NOW),
            Err(Refusal::Invalid)
        );
    }

    #[tokio::test]
    async fn the_header_is_read_from_the_bearer_scheme_only() {
        // `account` reads the real clock, so this token has to outlive the
        // test suite rather than a fixed NOW.
        let t = token(
            serde_json::json!({ "sub": "acct_123", "exp": 4_000_000_000i64 }),
            &signer(7),
            "EdDSA",
            Some(KID),
        );
        let v = Verifier::fixed(key_set(7, KID));

        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {t}").parse().unwrap());
        assert_eq!(v.account(&h).await.as_deref(), Some("acct_123"));

        let mut lower = HeaderMap::new();
        lower.insert("authorization", format!("bearer {t}").parse().unwrap());
        assert_eq!(lower.len(), 1);
        assert_eq!(v.account(&lower).await.as_deref(), Some("acct_123"));

        let mut wrong = HeaderMap::new();
        wrong.insert("authorization", format!("Basic {t}").parse().unwrap());
        assert_eq!(v.account(&wrong).await, None);
        assert_eq!(v.account(&HeaderMap::new()).await, None);
    }

    #[test]
    fn a_key_set_is_read_the_way_the_platform_writes_one() {
        // Byte-for-byte the shape `SessionKeys::jwks` emits.
        let public = signer(7).verifying_key().to_bytes();
        let body = serde_json::json!({
            "keys": [{
                "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
                "kid": KID, "x": b64url_encode(&public),
            }]
        })
        .to_string();
        let keys = parse_jwks(&body).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[KID].to_bytes(), public);
    }

    #[test]
    fn keys_for_algorithms_we_do_not_implement_are_skipped_not_fatal() {
        // A key set is allowed to grow. Refusing the whole document because
        // one entry is an RSA key would lock this service out on the day the
        // platform adds one.
        let public = signer(7).verifying_key().to_bytes();
        let body = serde_json::json!({
            "keys": [
                { "kty": "RSA", "kid": "rsa-1", "n": "…", "e": "AQAB" },
                { "kty": "OKP", "crv": "X25519", "kid": "ecdh-1",
                  "x": b64url_encode(&public) },
                { "kty": "OKP", "crv": "Ed25519", "use": "enc", "kid": "not-for-signing",
                  "x": b64url_encode(&public) },
                { "kty": "OKP", "crv": "Ed25519", "kid": KID,
                  "x": b64url_encode(&public) },
            ]
        })
        .to_string();
        let keys = parse_jwks(&body).unwrap();
        assert_eq!(keys.keys().collect::<Vec<_>>(), vec![KID]);
    }

    #[test]
    fn a_key_set_that_is_not_one_yields_nothing_rather_than_panicking() {
        for body in ["", "null", "{}", r#"{"keys":"nope"}"#, "not json at all"] {
            assert!(parse_jwks(body).unwrap_or_default().is_empty(), "{body}");
        }
        // A well-formed document whose key material is junk drops the key
        // rather than the document.
        let body = r#"{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"k","x":"!!!"}]}"#;
        assert!(parse_jwks(body).unwrap().is_empty());
    }

    #[test]
    fn base64url_round_trips_including_awkward_lengths() {
        for n in 0..40 {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 7 + 3) as u8).collect();
            assert_eq!(
                b64url_decode(&b64url_encode(&bytes)).unwrap(),
                bytes,
                "n={n}"
            );
        }
    }
}
