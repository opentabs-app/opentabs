# marketplace

The public site: browse, trending, detail pages, likes.

```sh
npm install
VITE_MARKET_API=http://localhost:8787 npm run dev
npm run build          # typechecks, then builds to dist/
```

`VITE_MARKET_API` defaults to the empty string — the site and the API share
an origin in production, so every call is same-origin and there is no CORS to
get wrong. Point it at a full origin (`http://127.0.0.1:8787`) for local work.

Reading needs no account and sets no cookie. Signing in is only for liking
and publishing; the token is held in `sessionStorage`, so closing the tab
signs out and nothing is left on the machine.

`src/render.ts` contains no `innerHTML`, deliberately — every string it draws
was typed by a stranger and is shown to everyone else.
