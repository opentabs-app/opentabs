# Deploying OpenTabs

Three hostnames, one box. Two of them are static files; the third is a
reverse proxy onto a platform server that is already running for the other
products.

| Hostname | Serves | From |
|---|---|---|
| `opentabs.app` | product site **and** the two daily feed files | `/var/www/opentabs` |
| `www.opentabs.app` | 301 to the apex | — |
| `market.opentabs.app` | the pack marketplace, site and API on one origin | `/var/www/opentabs-market` + `127.0.0.1:8095` |
| `auth.opentabs.app` | accounts and sign-in | proxy → `127.0.0.1:8080` |

**There is no `gateway.opentabs.app`, and that is deliberate.** That host
exists for products that spend credits on work done on our servers. OpenTabs
does every piece of its work on the reader's own machine, so there is nothing
to meter, no app key to issue and no key to hold. If a paid feature ever
appears, this is the section to come back to.

The first two names exist so that **no user of OpenTabs ever sees the
`openapps.network` domain**. That is not decoration: a browser names the host
in its permission prompt, and *"OpenTabs wants to communicate with
openapps.network"* reads like the extension is phoning a stranger's server.

### What the masking does not hide

Written down so nobody files it as a bug. The platform builds these once at
startup from its own `public_url`, so no hostname added here changes them:

- **Google sign-in visibly bounces through `accounts.openapps.network`** on
  the OAuth callback hop.
- **A wallet signature prompt names that host.**

Neither is a security property — the server never checks either string
against the request.

Steps 1–7 are one-time. Step 8 is every deploy after that.

---

## Before you start

- SSH to `root@104.36.65.54`.
- The domain, at Namecheap, with DNS there.
- Nothing else. There is no vendor API key, no admin token and no app key in
  this deployment, because there is nothing here that costs money to run.

`accounts.openapps.network`, `gateway.openapps.network`, `opensubs.app`,
`openpixels.app`, `opencapture.app` and `openpdfedit.com` are all live on this
box. Nothing below touches their server blocks — but `nginx -t` before every
reload is not ceremony, because a syntax error in a new file takes down every
site on the machine, those included.

---

## 1. DNS

Four A records, all at the same address:

```
A   @        104.36.65.54
A   www      104.36.65.54
A   market   104.36.65.54
A   auth     104.36.65.54
```

**A records, not CNAMEs, for `auth`.** A CNAME to
`accounts.openapps.network` would work and would also publish the backend
domain to anyone who runs `dig`. The A record is not a workaround, it is the
simpler configuration: `auth.opentabs.app` needs its own certificate on this
box either way, because the certificate the target presents is for
`accounts.openapps.network` and a browser rejects it.

**Delete the registrar's parking record.** Namecheap seeds a `URL`/redirect
record at `@` that its API cannot see or remove; left in place it answers the
ACME HTTP challenge and certbot fails on the apex with a message that does not
mention it. Remove it in the web UI under *Advanced DNS* before step 5.

Verify before continuing — every line must end at `104.36.65.54`:

```sh
for h in opentabs.app www.opentabs.app market.opentabs.app auth.opentabs.app; do
  printf '%-24s %s\n' "$h" "$(dig +short "$h" | tail -1)"
done
```

---

## 2. Let the new origins through CORS

**On the server.** Two front ends now call the platform, and a missing entry
fails CORS before the request reaches a route — which the SDK reports as
`code: "network"`, indistinguishable from the server being down.

```sh
grep -n OPENAPPS_SERVER_ALLOWED_ORIGINS /opt/openapps/deploy/prod.env
```

It is a **comma-separated string**, not an array. **Append; never replace** —
every origin already listed belongs to a product whose sign-in stops working
the moment it is dropped. Add:

```
https://market.opentabs.app
```

`return_to` is validated against this same list, so without the entry Google
sign-in refuses to redirect back and the flow dies at the last step.

The extension does **not** need an entry. It never calls the platform from
its own pages: it opens the platform's `/signin` page in a real tab and a
content script relays the session back, which is a same-origin `postMessage`
and involves no CORS at all. See `apps/extension/public/signin-relay.js` for
why it has to work that way — wallet and Nostr signers are never injected
into `chrome-extension://` pages, so sign-in on our own page could only ever
have offered Google.

Restart the container — `run.sh`, not systemctl. There is no
`openapps.service` on this box and `/etc/openapps.toml` is not read:

```sh
cd /opt/openapps && ./deploy/run.sh prod
```

---

## 3. Clone the repository on the server

The API image is built on the box: the target is x86_64 Linux and rusqlite
compiles bundled C, so "it builds on my laptop" is not a claim that survives
either. The repository is public, so this is the whole supply chain.

```sh
git clone https://github.com/opentabs-app/OpenTabs.git /opt/opentabs
```

---

## 4. Configure and start the API

```sh
cd /opt/opentabs
cp deploy/market-api.env.example deploy/market-api.env
openssl rand -hex 32          # → MARKET_SECRET
$EDITOR deploy/market-api.env
chmod 600 deploy/market-api.env
./deploy/run-market-api.sh --build
```

**`MARKET_SECRET` is permanent.** Every like token and every ownership token
is derived from it, so changing it means nobody has liked anything and nobody
owns their own listing. The service refuses to start on fewer than 32 bytes,
which is the point: a weak key makes the tokens reversible and turns the
privacy claim in `crates/tabs-market` into a false one.

`MARKET_MODERATORS` is your own OpenApps account id — sign in once and read
`sub` out of the access token. Leave it empty until you have one; the
moderation route then answers 404 to everybody, which is the correct
behaviour for a route with no moderators.

```sh
curl -sS http://127.0.0.1:8095/health     # ok
```

---

## 5. nginx and TLS

Four files, copied from `deploy/nginx/`. They are plain HTTP; certbot
rewrites them to add TLS in a moment.

```sh
# On your machine, from the repository root.
scp deploy/nginx/opentabs-security.conf root@104.36.65.54:/etc/nginx/snippets/
scp deploy/nginx/*.opentabs.app.conf root@104.36.65.54:/etc/nginx/sites-available/

# On the server
for f in opentabs.app market.opentabs.app auth.opentabs.app; do
  ln -sf "/etc/nginx/sites-available/$f.conf" "/etc/nginx/sites-enabled/$f"
done
mkdir -p /var/www/opentabs/tabs/v1 /var/www/opentabs-market
nginx -t && systemctl reload nginx
```

Then the certificates. One command, all four names, so they share a
certificate and renew together:

```sh
certbot --nginx --redirect \
  -d opentabs.app -d www.opentabs.app \
  -d market.opentabs.app -d auth.opentabs.app
certbot renew --dry-run
```

> **After this point, never `scp` a config over an existing one.** Certbot's
> edits live in the file on the server, not in this repository, so copying the
> repository version back deletes the TLS block — silently, because nginx
> keeps serving from memory until something reloads it, possibly hours later
> for an unrelated reason. To change a config afterwards, edit in place on the
> server, or diff first:
>
> ```sh
> ssh root@104.36.65.54 'cat /etc/nginx/sites-available/opentabs.app.conf' \
>   | diff - deploy/nginx/opentabs.app.conf
> ```
>
> If you have already overwritten one: `certbot --nginx -d <that host>` and
> choose *reinstall*.

---

## 6. The feeds, on cron

`tabs-feedgen` writes the two static files the *Apps* and *Trending* groups
read. It is the entire backend: no database, no API key, no model.

Both objects carry `generated_at`, and the extension hides a group whose data
is past its staleness budget — so a dead cron degrades the briefing rather
than showing yesterday's news as today's.

On the server, from the clone:

```sh
docker run --rm -v /opt/opentabs:/src -w /src rust:1-bookworm \
  cargo build --release -p tabs-feedgen
install -m 755 /opt/opentabs/target/release/tabs-feedgen /usr/local/bin/

cat >/etc/cron.d/opentabs-feeds <<'CRON'
# Twice a day. GitHub's trending page changes about that often, and the
# client's staleness budget is comfortably longer than twelve hours.
17 5,17 * * * root /usr/local/bin/tabs-feedgen --out /var/www/opentabs/tabs/v1 >/dev/null 2>&1
CRON

/usr/local/bin/tabs-feedgen --out /var/www/opentabs/tabs/v1   # once, now
```

`deploy.sh` excludes `tabs/` from its rsync for this reason: the feeds live
in the same directory as the site but are written on the server, and a
`--delete` that did not know that would blank two groups on every deploy.

---

## 7. First deploy

**On your Mac, not the server.** This builds the marketplace from source and
rsyncs both trees.

```sh
./deploy/deploy.sh --api
```

It refuses to ship if `openapps.network` appears anywhere in the built
marketplace bundle. That one check is the whole masking arrangement: a single
hardcoded URL at a single call site undoes it, and nothing else would notice.

---

## 8. Verify

```sh
./deploy/verify.sh
```

Twelve checks across the three hosts. Three of them are worth knowing about
because they fail invisibly otherwise:

- **`/v1/` must reach the API, not the SPA.** `location /` ends in
  `try_files … /index.html`, so a misordered config answers every API call
  with the marketplace's HTML and a 200 — which looks like the API is up.
  The check asks for a pack that does not exist and insists on a 404.
- **The feeds must carry `Access-Control-Allow-Origin`.** The extension reads
  them from an extension origin. Without the header the *Apps* and *Trending*
  groups are silently blank and nothing anywhere says why.
- **JWKS must be published.** The marketplace API verifies every bearer token
  against `https://auth.opentabs.app/.well-known/jwks.json`. If it 404s,
  publishing and liking return 401 with no explanation.

Then, by hand:

1. Open `https://market.opentabs.app`, press **Sign in**, and complete it.
   The dialog should offer every method the platform has configured — not
   just Google.
2. Load the extension, open **Settings → a group → Share**, and publish. The
   permission prompt should name `auth.opentabs.app` and
   `market.opentabs.app`, and nothing else.
3. Back on the site, **like** the pack you just published, reload, and check
   the heart is still filled.
4. In devtools' network panel, confirm every request goes to `opentabs.app`,
   `market.opentabs.app` or `auth.opentabs.app`. Nothing else.

---

## Rolling back

The site and the marketplace are static, so rollback is a redeploy of the
previous build. Keep the last one:

```sh
# On the server, before deploying
cp -a /var/www/opentabs-market /var/www/opentabs-market.prev
# To roll back
rm -rf /var/www/opentabs-market && mv /var/www/opentabs-market.prev /var/www/opentabs-market
```

No nginx reload for either — the files are served from disk.

The **API** rolls back by image, and it is not shared with any other product,
so this affects nothing else on the box:

```sh
cd /opt/opentabs && git checkout <previous ref> && ./deploy/run-market-api.sh --build
```

The database is a Docker volume (`opentabs-market-data`) and survives every
one of these. Back it up before anything that is not a redeploy:

```sh
docker run --rm -v opentabs-market-data:/data -v /root:/out debian:bookworm-slim \
  cp /data/market.sqlite /out/market-$(date +%F).sqlite
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Marketplace shows "Could not reach the marketplace" | The API container is down, or `/v1/` is falling through to the SPA. `curl -sS https://market.opentabs.app/health`. |
| Every publish and like returns 401 | JWKS. The API could not fetch `auth.opentabs.app/.well-known/jwks.json`, or `MARKET_JWKS_URL` is wrong. Container logs name the URL it is using at startup. |
| Sign-in on the site opens and then does nothing | `https://market.opentabs.app` is missing from `OPENAPPS_SERVER_ALLOWED_ORIGINS` (step 2), and the restart was forgotten. |
| Sign-in from the extension never completes | The relay content script did not register. It needs the `auth.opentabs.app` host permission, which the Publish button asks for — check it was granted, not dismissed. |
| *Apps* and *Trending* groups are blank | Either cron has not run (`ls -l /var/www/opentabs/tabs/v1/`) or the feeds are missing the CORS header. |
| `certbot` fails on the apex only | The registrar's parking redirect at `@` is answering the challenge. Step 1. |
