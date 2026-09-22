/**
 * Where "Switch profile" goes, for the browser this is running in.
 *
 * Chrome has a profile picker at `chrome://profile-picker`. Edge does not.
 * It rewrites the `chrome:` scheme to `edge:` and then finds no such page, so
 * the tab opens on ERR_INVALID_URL (APP-122, Edge 153). Nothing throws either:
 * `tabs.create` succeeds in opening an error page, which is why the button's
 * refusal fallback never ran.
 *
 * Edge's own list is Settings → Profiles. Under "More profiles" every other
 * profile has its own Switch button, so that page does the job the picker does
 * in Chrome. Measured on Edge 153 with three profiles.
 *
 * The brand list is the signal Chromium sets from the real product and does not
 * reduce, so it is asked first. The `Edg/` token in the user agent covers a
 * build that exposes no `userAgentData`.
 */
export const CHROME_PICKER = "chrome://profile-picker";
export const EDGE_PROFILES = "edge://settings/profiles";

export function profilePickerUrl(
  brands: readonly { brand: string }[] | undefined,
  userAgent: string,
): string {
  const edge = brands ? brands.some((b) => b.brand === "Microsoft Edge") : /\bEdg\//.test(userAgent);
  return edge ? EDGE_PROFILES : CHROME_PICKER;
}
