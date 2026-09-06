# Vendored from `@openapps/ui`

Built output, copied in — not a dependency, because `@openapps/ui` and
`@openapps/tokens` are not published to npm and this repository is not the
monorepo that builds them.

The alternative was to write a second sign-in surface for this one site.
That is how a suite ends up with two login flows that look nothing alike and
support different methods, and it is exactly what the shared element exists
to prevent.

## What is here, and what is not

`openapps-login.js` statically needs only `chunk-LCQWCHVU`, `chunk-OUMOJ2PH`
and `chunk-QGFEREF7` — about 42 KB. The three Nostr crypto files
(`esm-…`, `nip46-…`, `pure-…`, 95 KB between them) are loaded by dynamic
`import()` and are fetched **only** if someone opens the remote-signer or
pasted-key form. They are copied here so that path works; they cost nothing
to anyone who does not take it.

The whole thing is behind a dynamic import of its own in `src/auth.ts`, so
browsing the marketplace downloads none of it.

Source maps are deliberately not copied, and the `sourceMappingURL` comment
is stripped from each file — without that, devtools requests a `.map` that
is not here and reports a 404 per chunk, which reads like a broken deploy.

## Refreshing it

In the monorepo:

```sh
cd ui-elements && npm run build
```

then re-run the copy in `deploy/vendor-openapps.sh`. Check afterwards that
`openapps-login.js`'s static imports have not grown — if a fourth chunk
appears, it needs copying too, and the failure mode is a 404 at the moment
someone tries to sign in.
