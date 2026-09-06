/**
 * The marketplace, inside Settings.
 *
 * Browsing and installing happen here rather than only on the website,
 * because the thing being installed goes *here* — bouncing someone to a site
 * and back to apply a document to their own browser is a detour with a
 * handoff to get wrong at each end.
 *
 * The site remains the place to discover and to share a link. This is the
 * place to act.
 *
 * # Access
 *
 * The API origin is an optional host permission, asked for the first time
 * this pane is opened. Someone who never opens it is never asked, which is
 * the whole reason it is optional (D6).
 */
import { ext } from "../lib/ext";
import type { Config, Instance, Theme } from "../lib/types";

export { MARKET_ORIGIN } from "../lib/openapps";
import { MARKET_MATCH, MARKET_ORIGIN } from "../lib/openapps";

/** The match pattern, for `permissions.request`. */
export const MARKET_API = MARKET_MATCH;

export interface Listing {
  id: string;
  kind: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  image?: string | null;
  likes: number;
  installs: number;
}

export interface Pack {
  format: number;
  kind: string;
  id: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  instances: Instance[];
  theme?: Theme | null;
  image?: string | null;
  video?: string | null;
}

export interface PackProblem {
  field: string;
  message: string;
}

/** Every failure is a value. A blank pane is indistinguishable from an empty
 *  marketplace, and the second is a much worse thing to believe. */
export type Fetched<T> = { ok: true; data: T } | { ok: false; message: string };

async function api<T>(path: string, init: RequestInit = {}): Promise<Fetched<T>> {
  if (!(await hasAccess())) {
    return { ok: false, message: "OpenTabs has no access to the marketplace yet." };
  }
  try {
    const res = await fetch(`${MARKET_ORIGIN}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
      credentials: "omit",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, message: body?.error ?? `The marketplace answered ${res.status}.` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, message: "Could not reach the marketplace." };
  }
}

export function hasAccess(): Promise<boolean> {
  return ext.permissions.contains({ origins: [MARKET_API] }).catch(() => false);
}

export function browse(params: {
  q?: string;
  sort?: string;
  tag?: string | null;
}): Promise<Fetched<{ listings: Listing[]; tags: { tag: string; count: number }[]; total: number }>> {
  const s = new URLSearchParams();
  if (params.q) s.set("q", params.q);
  if (params.sort) s.set("sort", params.sort);
  if (params.tag) s.set("tag", params.tag);
  s.set("limit", "24");
  return api(`/v1/packs?${s}`);
}

/** Fetch the pack itself. This is the call the install counter counts. */
export function fetchPack(id: string): Promise<Fetched<Pack>> {
  return api(`/v1/packs/${encodeURIComponent(id)}/install`);
}

/**
 * Fetch a pack from a pasted address.
 *
 * Restricted to the marketplace's own origin, and that is not fussiness: this
 * document is about to be applied to the reader's configuration, and "paste a
 * URL and we will apply whatever comes back" is a request to install
 * arbitrary configuration from anywhere. Someone who wants a pack from
 * elsewhere can paste the pack itself, which goes through exactly the same
 * validation with nothing hidden behind a redirect.
 */
export async function fetchPastedPack(raw: string): Promise<Fetched<Pack>> {
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      return { ok: true, data: JSON.parse(text) as Pack };
    } catch {
      return { ok: false, message: "That is not a readable pack." };
    }
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "Paste a marketplace link, or a pack itself." };
  }
  if (url.origin !== MARKET_ORIGIN) {
    return {
      ok: false,
      message: `Only links from ${new URL(MARKET_ORIGIN).host} can be fetched. Paste the pack itself instead.`,
    };
  }
  const id = url.pathname.split("/").filter(Boolean).at(1) ?? "";
  if (!id) return { ok: false, message: "That link does not name a pack." };
  return fetchPack(id);
}

/** Publish. Needs a token from OpenApps, held on this device only. */
export async function publish(
  pack: Pack,
  token: string,
): Promise<Fetched<Listing> & { problems?: PackProblem[] }> {
  if (!(await hasAccess())) {
    return { ok: false, message: "OpenTabs has no access to the marketplace yet." };
  }
  try {
    const res = await fetch(`${MARKET_ORIGIN}/v1/packs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      credentials: "omit",
      body: JSON.stringify({ pack }),
    });
    const body = (await res.json().catch(() => null)) as
      | (Listing & { error?: string; problems?: PackProblem[] })
      | null;
    if (!res.ok) {
      return {
        ok: false,
        message: body?.error ?? `The marketplace answered ${res.status}.`,
        problems: body?.problems,
      };
    }
    return { ok: true, data: body as Listing };
  } catch {
    return { ok: false, message: "Could not reach the marketplace." };
  }
}

/**
 * Apply a pack to the stored config, through the worker.
 *
 * The worker owns the config and the wasm that validates a pack, so it does
 * both. A settings page that applied packs itself would be a second place
 * that has to get the merge right.
 */
export async function install(
  pack: Pack,
): Promise<{ ok: boolean; added: string[]; renamed: string[]; themeApplied: boolean; problems: PackProblem[] }> {
  const r = (await ext.runtime.sendMessage({ type: "installPack", pack }).catch(() => null)) as {
    ok?: boolean;
    result?: { added: string[]; renamed: string[]; theme_applied: boolean; problems: PackProblem[] };
  } | null;
  const res = r?.result;
  return {
    ok: !!r?.ok,
    added: res?.added ?? [],
    renamed: res?.renamed ?? [],
    themeApplied: res?.theme_applied ?? false,
    problems: res?.problems ?? [],
  };
}

/** Build a pack from one of the reader's own groups, stripped on the way out. */
export async function packFrom(
  cfg: Config,
  instanceId: string,
  author: string,
  description: string,
): Promise<Pack | null> {
  const r = (await ext.runtime
    .sendMessage({ type: "packFromInstance", instanceId, author, description })
    .catch(() => null)) as { pack?: Pack | null } | null;
  void cfg;
  return r?.pack ?? null;
}
