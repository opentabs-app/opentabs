/**
 * Config keys against the *compiled* migration, not a model of it.
 *
 * `tabs_core::config::Config` has no catch-all field, so serde drops any key
 * the struct does not name — and every stored config passes through
 * `migrateConfig` in the worker. A key that exists only in TypeScript is
 * therefore erased on the next migration, while looking perfectly fine on
 * every ordinary load, because the worker writes the migrated copy back only
 * when the version changes.
 *
 * `show_profile_picker` was that key for one build. The Rust unit test covers
 * the struct; this covers the wasm the extension actually ships, which is
 * where the drop was first demonstrated.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import init, * as core from "../wasm-gen/tabs_core.js";

beforeAll(async () => {
  await init({ module_or_path: readFileSync(resolve(__dirname, "../wasm-gen/tabs_core_bg.wasm")) });
});

const base = { version: 1, instances: [], theme: "auto", assistant: "claude" };

describe("migrateConfig, as compiled", () => {
  it("keeps a switch-profile button someone turned off", () => {
    const out = core.migrateConfig({ ...base, show_profile_picker: false }) as { show_profile_picker?: boolean };
    expect(out.show_profile_picker).toBe(false);
  });

  it("shows it for a config written before the setting existed", () => {
    const out = core.migrateConfig({ ...base }) as { show_profile_picker?: boolean };
    expect(out.show_profile_picker).toBe(true);
  });

  /** The control: a key the struct has never heard of really is dropped, so
   *  the two tests above are passing because the field is declared, and not
   *  because migration happens to keep everything. */
  it("does still drop a key the struct does not name", () => {
    const out = core.migrateConfig({ ...base, not_a_real_setting: true }) as Record<string, unknown>;
    expect("not_a_real_setting" in out).toBe(false);
  });
});
