/**
 * A real OpenSync relay, for the duration of one test file.
 *
 * A stub would prove nothing worth proving here: what these tests are for is
 * the round trip through the engine — NIP-42 auth, the pointer, the blobs,
 * the SPAKE2 pairing — and every one of those is on the relay's side of the
 * wire. Its own harness does the same thing for the same reason.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Built in the engine repo, which sits beside this one on a dev machine only. */
export const RELAY_BIN = resolve(here, "../../../../opensync/target/release/opensync-relay");

export interface Relay {
  ws: string;
  http: string;
  stop(): void;
}

/** Whatever the OS hands out. 4848 is the port a real account might be on. */
function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const server = createServer();
    server.on("error", bad);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => ok(port));
    });
  });
}

async function awaitRelay(http: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      const r = await fetch(http, { headers: { Accept: "application/nostr+json" } });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`relay never answered at ${http}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function startRelay(): Promise<Relay> {
  const bin = RELAY_BIN;
  const dir = mkdtempSync(join(tmpdir(), "opentabs-sync-"));
  const port = await freePort();
  const config = join(dir, "relay.toml");
  writeFileSync(
    config,
    [
      `bind = "127.0.0.1:${port}"`,
      `data_dir = ${JSON.stringify(dir)}`,
      `database_url = ${JSON.stringify(`sqlite://${dir}/relay.db?mode=rwc`)}`,
      // On, as in production. A check that skips the auth handshake has not
      // exercised the path every real client takes.
      `require_auth = true`,
    ].join("\n"),
  );

  let child: ChildProcess;
  try {
    child = spawn(bin, [config], { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    throw new Error(`cannot start ${bin} — run: cargo build --release -p opensync-relay (in openapps/opensync)`);
  }
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));

  const http = `http://127.0.0.1:${port}`;
  try {
    await awaitRelay(http, Date.now() + 10_000);
  } catch (e) {
    child.kill();
    throw new Error(`${(e as Error).message}\nrelay said: ${stderr || "(nothing — is it built?)"}`);
  }

  return {
    ws: `ws://127.0.0.1:${port}/`,
    http,
    stop() {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
