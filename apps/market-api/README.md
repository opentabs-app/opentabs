# market-api

The OpenTabs marketplace: listings, likes, installs.

```sh
export MARKET_SECRET="$(openssl rand -hex 32)"   # required, ≥32 bytes
export MARKET_DB=market.sqlite                   # default
export MARKET_MODERATORS=acct_you                # optional, comma separated
export PORT=8787                                 # default
cargo run -p market-api
```

`MARKET_SECRET` is the HMAC key behind every like token and every owner
token. **The service refuses to start without one**, and that is deliberate:
a weak or absent key makes the tokens guessable, which turns the privacy
claim in `tabs-market` into a false one. A service that lies about that is
worse than one that will not run.

It must be the same key the platform signs its bearer tokens with, since
`auth.rs` verifies them locally rather than calling back on every request.

## Routes

| Method | Path | Account |
|---|---|---|
| `GET` | `/v1/packs?q=&tag=&sort=trending\|top\|new&offset=&limit=` | no |
| `GET` | `/v1/packs/:id` | optional — supplies `liked` |
| `GET` | `/v1/packs/:id/install` | no — counts the install |
| `POST` | `/v1/packs` | yes |
| `POST`/`DELETE` | `/v1/packs/:id/like` | yes |
| `POST` | `/v1/packs/:id/moderate/:hide\|show\|delete` | moderator |

## What the database cannot tell you

There is no `user_id` column. A like is one row holding an opaque token; the
publishing allowance is the same, plus a timestamp, swept after two days.
Ask it what an account has liked and there is no query — not because it is
forbidden, because the column does not exist.
