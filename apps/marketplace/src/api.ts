/**
 * The marketplace API, as the site sees it.
 *
 * Every call is typed and every failure is a value. A marketplace that shows
 * a blank page when the server is down is indistinguishable from one with
 * nothing in it, and the second is a much worse thing to believe.
 */

export interface Listing {
  id: string;
  kind: "group" | "theme";
  name: string;
  description: string;
  author: string;
  tags: string[];
  image?: string | null;
  video?: string | null;
  published: number;
  updated: number;
  likes: number;
  installs: number;
}

export interface Binding {
  kind: string;
  tmpl?: string;
  url?: string;
  arg?: string;
  weight?: number;
}

export interface PackInstance {
  def: string;
  id: string;
  name: string;
  enabled: boolean;
  opts: Record<string, unknown>;
}

export interface Theme {
  base: string;
  font?: string;
  mono?: string;
  colors: Record<string, string>;
}

export interface Pack {
  format: number;
  kind: string;
  id: string;
  name: string;
  description: string;
  author: string;
  tags: string[];
  instances: PackInstance[];
  theme?: Theme | null;
  image?: string | null;
  video?: string | null;
}

export interface BrowseResult {
  listings: Listing[];
  tags: { tag: string; count: number }[];
  total: number;
}

export interface Detail {
  listing: Listing;
  pack: Pack;
  /** `null` means signed out — which the page draws differently from "no". */
  liked: boolean | null;
}

/** A failure that the page can render rather than throw. */
export interface Failure {
  ok: false;
  status: number;
  message: string;
  problems?: { field: string; message: string }[];
}

export type Result<T> = ({ ok: true } & T) | Failure;

/**
 * Where the API is.
 *
 * Empty by default, and that is the production setting: nginx serves this
 * site and proxies `/v1/*` to the API on the same hostname, so every call is
 * same-origin. There is then no CORS configuration that can be wrong, no
 * preflight on the path that matters, and no second name for anyone to have
 * to allow.
 *
 * Set `VITE_MARKET_API` to a full origin (`http://127.0.0.1:8787`) to point
 * a dev server at an API running separately.
 */
const BASE = (import.meta.env?.VITE_MARKET_API as string) ?? "";

/** Token from the OpenApps sign-in, held for this tab only. */
let token: string | null = null;

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) sessionStorage.setItem("opentabs:market:token", t);
    else sessionStorage.removeItem("opentabs:market:token");
  } catch {
    // Private mode, or storage disabled. Signing in still works for this
    // page load; it simply will not survive a reload.
  }
}

export function restoreToken(): string | null {
  try {
    token = sessionStorage.getItem("opentabs:market:token");
  } catch {
    token = null;
  }
  return token;
}

export function signedIn(): boolean {
  return !!token;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  } catch {
    // A network failure is not an empty marketplace, and must never be shown
    // as one.
    return { ok: false, status: 0, message: "Could not reach the marketplace." };
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const e = body as { error?: string; problems?: { field: string; message: string }[] } | null;
    return {
      ok: false,
      status: res.status,
      message: e?.error ?? `The marketplace answered ${res.status}.`,
      problems: e?.problems,
    };
  }
  return { ok: true, ...(body as T) };
}

export function browse(params: {
  q?: string;
  tag?: string | null;
  sort?: string;
  offset?: number;
  limit?: number;
}): Promise<Result<BrowseResult>> {
  const s = new URLSearchParams();
  if (params.q) s.set("q", params.q);
  if (params.tag) s.set("tag", params.tag);
  if (params.sort) s.set("sort", params.sort);
  if (params.offset) s.set("offset", String(params.offset));
  s.set("limit", String(params.limit ?? 24));
  return request<BrowseResult>(`/v1/packs?${s}`);
}

export function detail(id: string): Promise<Result<Detail>> {
  return request<Detail>(`/v1/packs/${encodeURIComponent(id)}`);
}

export function like(id: string, on: boolean): Promise<Result<{ liked: boolean; likes: number }>> {
  return request(`/v1/packs/${encodeURIComponent(id)}/like`, { method: on ? "POST" : "DELETE" });
}

/**
 * The address the extension fetches to install. Also the "copy link" target.
 *
 * Absolute, always. `BASE` is empty in production because the API shares
 * this origin, and a relative `/v1/packs/…` is useless the moment it leaves
 * this page — which is the entire purpose of this string.
 */
export function installUrl(id: string): string {
  const path = `/v1/packs/${encodeURIComponent(id)}/install`;
  return BASE ? `${BASE}${path}` : new URL(path, location.origin).href;
}
