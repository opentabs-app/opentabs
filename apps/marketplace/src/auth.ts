/**
 * Signing in, through the platform's own element.
 *
 * # Why an element and not a form
 *
 * `<openapps-login>` is the same sign-in surface every app in the suite
 * uses. It asks the *server* which methods are configured, handles the
 * challenge/sign/verify round trip for each, completes the OAuth redirect
 * leg, and picks up `?ref=` so an invite still attributes the signup. A
 * hand-written Google-only button here would work, and would then be a
 * second sign-in flow that looks nothing like the one in every other
 * OpenApps product and supports fewer ways in.
 *
 * # Why it costs nothing to browse
 *
 * The element and its dependencies are ~42 KB and are loaded by a dynamic
 * `import()` the first time someone presses Sign in. Browsing the
 * marketplace — which is what almost everyone does, since installing needs
 * no account at all — downloads none of it.
 *
 * The two Nostr fallbacks pull a further ~95 KB of crypto, and the element
 * loads those itself only if someone opens one of those forms.
 *
 * # What is stored
 *
 * The access token, in `sessionStorage`, for this tab. Closing it signs out
 * and leaves nothing behind on the machine. That is a deliberate step down
 * from the SDK's default (`localStorage`, which survives): the only things
 * an account unlocks here are liking a pack and seeing which ones you have
 * liked, and neither is worth a credential sitting on disk.
 */
import * as api from "./api";
import { el } from "./render";

/** Where the platform lives, under our own name. Defined once. */
export const OPENAPPS_BASE_URL = "https://auth.opentabs.app";

/** The element, once loaded. `null` until someone presses Sign in. */
let loaded: Promise<void> | null = null;

function loadElement(): Promise<void> {
  // Copied into `public/openapps/` from `@openapps/ui`'s built bundle; see
  // the README there for why it is vendored rather than depended on.
  //
  // Held in a variable rather than written inline: a literal specifier is
  // one the bundler tries to resolve and the type checker tries to find, and
  // this file is served from `public/` at runtime — neither of them will
  // ever see it.
  const url = "/openapps/openapps-login.js";
  loaded ??= import(/* @vite-ignore */ url).then(() => undefined);
  return loaded;
}

interface LoginElement extends HTMLElement {
  client?: { session?: { accessToken?: string } | null };
}

/**
 * Open the sign-in dialog. Resolves with the token, or `null` if the reader
 * closed it.
 */
export async function signIn(): Promise<string | null> {
  const dlg = el("div", "modal");
  const box = el("div", "modal-box signin-box");
  box.append(el("h3", undefined, "Sign in"));
  box.append(
    el(
      "p",
      "muted",
      "One account, shared across the suite. It is needed to like a pack — " +
        "installing one never is.",
    ),
  );

  const slot = el("div", "signin-slot", "Loading sign-in…");
  box.append(slot);

  const close = el("button", "btn", "Cancel");
  const row = el("div", "row-actions");
  row.append(close);
  box.append(row);
  dlg.append(box);
  document.body.append(dlg);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      dlg.remove();
      resolve(token);
    };

    close.addEventListener("click", () => finish(null));
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) finish(null);
    });
    document.addEventListener("keydown", function esc(e) {
      if (e.key !== "Escape") return;
      document.removeEventListener("keydown", esc);
      finish(null);
    });

    void loadElement()
      .then(() => {
        const login = document.createElement("openapps-login") as LoginElement;
        login.setAttribute("base-url", OPENAPPS_BASE_URL);
        // The element bubbles and composes its events, so listening on the
        // element itself is enough — no document-level listener to remove.
        login.addEventListener("openapps-login", () => {
          const token = login.client?.session?.accessToken ?? null;
          if (!token) {
            // Signed in, but the session did not land where we look for it.
            // Saying so beats a dialog that closes and changes nothing.
            slot.replaceChildren(
              el("p", "warn", "Signed in, but the session did not come back. Try once more."),
            );
            return;
          }
          api.setToken(token);
          finish(token);
        });
        slot.replaceChildren(login);
      })
      .catch(() => {
        slot.replaceChildren(
          el(
            "p",
            "warn",
            "The sign-in form could not be loaded. Check your connection and try again.",
          ),
        );
      });
  });
}

/** Forget the session. Local only — `sessionStorage` is the whole of it. */
export function signOut() {
  api.setToken(null);
}
