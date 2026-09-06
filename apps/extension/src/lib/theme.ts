/**
 * Applying a theme.
 *
 * A theme is a small set of CSS custom properties and two font stacks. It is
 * applied by setting them on `:root`, which is why every value must have been
 * through `tabs_core::pack::clean_theme` first — a custom property whose value
 * is attacker-controlled is a stylesheet injection.
 *
 * Applied here again rather than trusted: this runs on data from
 * `storage.sync`, which a pack wrote and which may have arrived from a build
 * older than the current validation. Re-checking costs a regular expression
 * and closes the gap where yesterday's rules protect today's page.
 */
import type { Theme } from "./types";

/** The only custom properties a theme may set. Mirrors `THEME_VARS` in Rust. */
export const THEME_VARS = [
  "bg", "bg-sunken", "surface-card", "text-strong", "text-muted", "text-faint",
  "border-hairline", "border-focus", "success-fg", "danger-fg", "warning-fg",
  "accent", "card-radius", "font-scale",
] as const;

const COLOR =
  /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla)\([0-9 .,%/-]+\)|[a-z]{1,24})$/i;
const SCALAR = /^[0-9.]{1,8}(px|%|rem)?$/;
const FONT = /^[a-z0-9 ,\-_'"]{1,160}$/i;

export function safeColor(v: string): boolean {
  return COLOR.test(v.trim());
}

export function safeFont(v: string): boolean {
  return FONT.test(v.trim());
}

/**
 * Put a theme on the page, or take one off.
 *
 * Every property is removed before the new set is applied, so switching from a
 * theme that sets ten colours to one that sets two does not leave eight
 * behind — a half-applied theme looks like a rendering bug rather than a
 * choice.
 */
export function applyTheme(theme: Theme | null | undefined, root: HTMLElement = document.documentElement) {
  for (const name of THEME_VARS) root.style.removeProperty(`--${name}`);
  root.style.removeProperty("--font");
  root.style.removeProperty("--mono");
  if (!theme) return;

  for (const [rawName, rawValue] of Object.entries(theme.colors ?? {})) {
    const name = rawName.replace(/^--/, "");
    if (!(THEME_VARS as readonly string[]).includes(name)) continue;
    const value = String(rawValue).trim();
    const ok = name === "card-radius" || name === "font-scale" ? SCALAR.test(value) : safeColor(value);
    if (ok) root.style.setProperty(`--${name}`, value);
  }
  if (theme.font && safeFont(theme.font)) root.style.setProperty("--font", theme.font);
  if (theme.mono && safeFont(theme.mono)) root.style.setProperty("--mono", theme.mono);
}

/** `auto`, `light` or `dark` — the class the stylesheet already understands. */
export function baseClass(theme: string | undefined): string {
  return theme === "light" || theme === "dark" ? `oa-${theme}` : "oa-auto";
}
