/* tslint:disable */
/* eslint-disable */

/**
 * The clipboard payload: an append-only log with a TTL.
 */
export class Clipboard {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Offer a captured value. Returns `null` when it was accepted, or a
     * reason when it was not — `"secret"`, `"duplicate"`, `"too-large"`,
     * `"empty"`.
     *
     * A credential is refused here rather than filtered later, so there is
     * no window in which it exists in a syncable form.
     */
    capture(text: string, device: string, now: bigint): string | undefined;
    /**
     * Would this be synced? Exposed so a user interface can say why
     * something did not travel, rather than leaving them guessing.
     */
    classify(text: string): string;
    /**
     * Newest first.
     */
    entries(): any;
    /**
     * Load a history written by any other device, including the Rust daemon.
     */
    static fromCbor(raw: Uint8Array): Clipboard;
    isEmpty(): boolean;
    len(): number;
    /**
     * Fold in another device's history. Entries are immutable and
     * independent, so this is a union and never a conflict.
     */
    merge(other: Clipboard, now: bigint): number;
    constructor();
    toCbor(): Uint8Array;
}

/**
 * The existing device's side: it has the keys and is deciding to share them.
 */
export class GrantSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Check the joiner's proof and seal the account for it.
     *
     * Spends the session whether it succeeds or fails: one code, one
     * attempt. A second device needs a second code, which is a visible cost
     * to the user and the reason a guess is not worth making.
     */
    grant(accept: Uint8Array): Uint8Array;
    /**
     * `enrollment` is `{accountSecret, namespaceKey, namespace, relayWs,
     * relayHttp, grantedBy}` — the account this device is offering, with the
     * keys in either `nsec1…`/`ovault1…` or hex.
     */
    constructor(code: PairingCode, enrollment: any);
    /**
     * Answer a `Join`. Returns the `Offer` to publish.
     */
    offer(join: Uint8Array): Uint8Array;
}

/**
 * An invitation: the relay address and the code, as one string a camera can
 * read.
 *
 * The QR comes back as a grid of booleans rather than an image, so the page
 * draws it at whatever size the layout wants — a canvas rectangle per module,
 * a div, an SVG path — and stays crisp when it is scaled. Handing back a PNG
 * would fix the size at generation time and blur on every screen that is not
 * the one it was sized for.
 */
export class Invitation {
    free(): void;
    [Symbol.dispose](): void;
    constructor(relay_ws: string, code: PairingCode);
    /**
     * Parse what a scanner handed back. Throws on anything that is not one.
     */
    static parse(input: string): Invitation;
    /**
     * One row of the QR, as a `Uint8Array` of 0 and 1. Row by row rather than
     * one flat array so a caller cannot get the stride wrong.
     */
    qrRow(y: number): Uint8Array;
    /**
     * How many rows and columns the QR has, quiet zone included.
     */
    qrSize(): number;
    readonly code: PairingCode;
    readonly relayWs: string;
    readonly uri: string;
}

/**
 * The new device's side of a pairing.
 *
 * Built from a code, hands back the message to publish, and is spent once it
 * has opened a grant or been abandoned.
 */
export class JoinSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Tell the other device to stop waiting. A courtesy after a failure.
     */
    static abandonMessage(reason: string): Uint8Array;
    /**
     * Check the other device's proof and produce ours.
     *
     * An error here means whoever answered did not hold the code. Publish
     * [`JsJoinSession::abandon_message`] and show the user the failure — do
     * not retry, because the code is spent either way.
     */
    accept(offer: Uint8Array): Uint8Array;
    /**
     * The `Join` message: publish this on the channel, repeatedly, until an
     * offer comes back. Nothing is stored on the relay, so an unheard first
     * attempt is simply gone.
     */
    joinMessage(): Uint8Array;
    constructor(code: PairingCode);
    /**
     * Open the granted account. Returns `{accountSecret, namespaceKey,
     * namespace, relayWs, relayHttp, grantedBy}`, with both keys in the
     * prefixed form that the settings fields take.
     */
    open(grant: Uint8Array): any;
}

/**
 * A single namespace — one vault, one clipboard, one secret store.
 *
 * Holds the namespace key, so it is created once and kept: the key must
 * never round-trip through JavaScript more often than it has to.
 */
export class Namespace {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    /**
     * Seal everything staged and produce the blobs plus the pointer.
     *
     * The caller must write every blob before publishing the pointer. That
     * ordering is not advice: publish first and a peer fetches a manifest
     * naming content that does not exist yet.
     *
     * `device` is this device's name, sealed into the manifest so the device
     * that merges it can name a conflict copy after the machine whose
     * version is inside it. Optional, and omitting it leaves the manifest
     * byte-for-byte what it was before this argument existed — a surface
     * that does not pass one does not re-upload its whole namespace.
     * `scope` is the file extensions this device is carrying, when it is not
     * carrying everything — a free plan that syncs notes but not images, say.
     * Omitting it means "everything", which is what a manifest meant before
     * the field existed. Passing it is not optional for a device that
     * filters: a manifest is a complete statement of a namespace, so one
     * that silently leaves files out reads as an instruction to delete them.
     */
    commit(generation: bigint, now: bigint, device?: string | null, scope?: string[] | null): any;
    /**
     * What to do with an incoming pointer: `apply`, `already-have`, `fork`
     * or `stale`. Ordering comes from the generation counter, never from a
     * timestamp — a client sets `created_at` and can lie about it.
     */
    evaluate(incoming: any, holding: any): string;
    /**
     * A fresh vault key as `ovault1…`. Lose it and the data is gone — there
     * is no recovery path and no support queue, which is the bargain.
     */
    static generateKey(): string;
    /**
     * Resolve a fork. Whole-file last-write-wins with conflict copies: the
     * local side keeps the path, the remote side is moved aside, and nothing
     * is discarded.
     */
    mergeManifests(base: any, ours: any, theirs: any, device_label: string, date: string, now: bigint): any;
    /**
     * The blobs a caller must fetch, given the hex ids it already holds.
     * This is the delta, and on a steady-state sync it is a handful.
     */
    missingBlobs(manifest: any, have: string[]): string[];
    /**
     * Accepts `ovault1…` or bare hex.
     *
     * An `nsec1…` is refused with an explanation rather than silently used:
     * pasting the account key into the vault field produces a vault nobody
     * can read, and the error is the only place that mistake gets caught.
     */
    constructor(key: string);
    /**
     * Decrypt one chunk and check it against what the manifest promised.
     *
     * The hash check is not redundant with the AEAD tag: the tag proves the
     * bytes were sealed with our key, the hash proves the store returned the
     * blob we asked for rather than a different, equally valid one of ours.
     */
    openChunk(sealed: Uint8Array, expected_hex: string): Uint8Array;
    openManifest(sealed: Uint8Array): any;
    /**
     * Decrypt a pointer read from a relay.
     */
    openPointer(hex_content: string): any;
    /**
     * Add a file to the next commit.
     */
    stage(path: string, bytes: Uint8Array): void;
}

/**
 * A pairing code, as it is shown and as it is typed.
 */
export class PairingCode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * A fresh code, from the browser's `crypto.getRandomValues`.
     */
    static generate(): PairingCode;
    /**
     * Read one a person typed. Case, spaces and hyphens do not matter.
     */
    static parse(input: string): PairingCode;
    /**
     * The public half, which goes in the relay filter as the `d` tag.
     */
    readonly channel: string;
    /**
     * The whole code, for display. Never log this.
     */
    readonly text: string;
}

/**
 * The passkey store, and the authenticator over it.
 *
 * Bytes cross this boundary as unpadded base64url strings rather than as
 * `Uint8Array`. Not a style choice: every one of these values continues on
 * through `chrome.runtime.sendMessage`, which puts messages through
 * structured JSON, and a typed array arrives at the far end as an object
 * with numeric keys. One representation the whole way avoids a conversion
 * that only fails in the extension and not in the web app.
 */
export class Passkeys {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Sign a challenge with one stored passkey.
     *
     * `entry_id` names which, and it is checked against what this page may
     * actually use before anything is signed — a stale popup or a page that
     * guessed an id both land here and both get nothing.
     */
    assert(page_url: string, entry_id: string, request: any): any;
    /**
     * Which stored passkeys this page may use, names only.
     *
     * The same rule as `Secrets.forPage`, one layer stricter: as well as the
     * RP ID being valid for the page, the passkey has to be *for* the RP ID
     * this request named.
     */
    candidates(page_url: string, request: any): any;
    collectTombstones(now: bigint): number;
    /**
     * Make a passkey for this page and keep it.
     *
     * Called only after a person clicked. The RP ID is validated here rather
     * than taken on trust, and `clientDataJSON` is built from `page_url` —
     * which the service worker read off `sender.tab.url`, not off the page.
     */
    create(page_url: string, request: any, now: bigint): any;
    delete(id: string, now: bigint): boolean;
    static fromCbor(raw: Uint8Array): Passkeys;
    isEmpty(): boolean;
    len(): number;
    /**
     * Everything held, for the manager screen. Key material is stripped —
     * the popup has no use for it, and a private key that never reaches a
     * rendering context cannot be rendered by accident.
     */
    list(): any;
    merge(other: Passkeys): number;
    constructor();
    search(query: string): any;
    toCbor(): Uint8Array;
}

/**
 * The secret store: per-item last-write-wins with durable deletion.
 */
export class Secrets {
    free(): void;
    [Symbol.dispose](): void;
    collectTombstones(now: bigint): number;
    delete(id: string, now: bigint): boolean;
    /**
     * Entries that may be offered for filling on `page_url`.
     *
     * The anti-phishing control, and the reason offering to fill a
     * credential is defensible at all: an entry is only ever returned when
     * its stored host is the host in the address bar. Exact match only —
     * subdomain matching without the Public Suffix List is how a credential
     * stored for `co.uk` gets offered to every British website.
     */
    forPage(page_url: string): any;
    static fromCbor(raw: Uint8Array): Secrets;
    get(id: string): any;
    isEmpty(): boolean;
    len(): number;
    /**
     * Fold in another device's store. Commutative, so two devices that have
     * seen the same edits agree without further exchange.
     */
    merge(other: Secrets): number;
    constructor();
    put(entry: any, now: bigint): void;
    /**
     * Search names, usernames and URLs — never the secret itself. Matching
     * on the value would let someone with a guess confirm it without the
     * value ever appearing on screen.
     */
    search(query: string): any;
    toCbor(): Uint8Array;
}

/**
 * The same account as one pasteable line, and the reader for one.
 *
 * The printed page is right for a drawer and wrong for a phone: two blocks of
 * sixty characters is not something anybody types twice, and not every device
 * has a camera to be shown a QR instead. This is the third way in.
 */
export function accountLink(account_secret: string, namespace_key: string, namespace: string, relay_ws: string): string;

/**
 * The RP ID this page may act for, or a throw explaining why not.
 *
 * The service worker asks this *before* showing anyone a prompt, so a page
 * that named somebody else's domain is refused without a person ever being
 * invited to approve it.
 */
export function effectiveRpId(page_url: string, requested?: string | null): string;

/**
 * The account's public identity as `npub1…`, from its 32-byte x-only public
 * key in hex (what the relay sees as the event author).
 *
 * The same bech32 implementation as every other key in the product, so an
 * npub shown by the browser app reads identically on the desktop and phone.
 */
export function encodeNpub(pubkey_hex: string): string;

/**
 * A fresh account key as `nsec1…`.
 */
export function generateAccountKey(): string;

/**
 * Why an entry was not offered for a page. Exposed so an interface can say
 * *why* nothing matched rather than showing an empty list.
 */
export function originVerdict(stored_url: string, page_url: string): string;

/**
 * The origin a relying party will see in `clientDataJSON` for this page.
 */
export function pageOrigin(page_url: string): string | undefined;

/**
 * What a pairing message is, without decoding its contents — so JavaScript
 * can route the four steps without a parallel parser.
 */
export function pairingStep(message: Uint8Array): string;

/**
 * Normalise an account key given as `nsec1…` or hex, returning hex.
 *
 * One bech32 implementation for the whole product: the desktop, the phone
 * and the browser all decode a key the same way, so a key that works in one
 * works in all of them.
 */
export function parseAccountKey(input: string): string;

/**
 * Normalise a vault key given as `ovault1…` or hex, returning hex.
 */
export function parseVaultKey(input: string): string;

/**
 * A QR of any string, as a flat grid the caller draws.
 *
 * The invitation has carried its own for a while; an account link needs the
 * same job done and is not an invitation. Rows as one array with the side
 * length returned separately would let a caller get the stride wrong, so this
 * hands back an array of rows.
 */
export function qrRowsFor(text: string): any;

export function readAccountLink(input: string): any;

export function readRecoveryKit(text: string): any;

/**
 * A printable recovery kit for an account, and the reader for one.
 */
export function renderRecoveryKit(account_secret: string, namespace_key: string, namespace: string, device: string, created: string): string;

/**
 * Why a passkey's RP ID was or was not usable on a page. Exposed so an
 * interface can say *why* rather than showing an empty list.
 */
export function rpIdVerdict(page_url: string, rp_id: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_clipboard_free: (a: number, b: number) => void;
    readonly __wbg_grantsession_free: (a: number, b: number) => void;
    readonly __wbg_invitation_free: (a: number, b: number) => void;
    readonly __wbg_joinsession_free: (a: number, b: number) => void;
    readonly __wbg_namespace_free: (a: number, b: number) => void;
    readonly __wbg_pairingcode_free: (a: number, b: number) => void;
    readonly __wbg_passkeys_free: (a: number, b: number) => void;
    readonly __wbg_secrets_free: (a: number, b: number) => void;
    readonly accountLink: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly clipboard_capture: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => void;
    readonly clipboard_classify: (a: number, b: number, c: number, d: number) => void;
    readonly clipboard_entries: (a: number, b: number) => void;
    readonly clipboard_fromCbor: (a: number, b: number, c: number) => void;
    readonly clipboard_isEmpty: (a: number) => number;
    readonly clipboard_len: (a: number) => number;
    readonly clipboard_merge: (a: number, b: number, c: bigint) => number;
    readonly clipboard_new: () => number;
    readonly clipboard_toCbor: (a: number, b: number) => void;
    readonly effectiveRpId: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly encodeNpub: (a: number, b: number, c: number) => void;
    readonly generateAccountKey: (a: number) => void;
    readonly grantsession_grant: (a: number, b: number, c: number, d: number) => void;
    readonly grantsession_new: (a: number, b: number, c: number) => void;
    readonly grantsession_offer: (a: number, b: number, c: number, d: number) => void;
    readonly invitation_code: (a: number) => number;
    readonly invitation_new: (a: number, b: number, c: number) => number;
    readonly invitation_parse: (a: number, b: number, c: number) => void;
    readonly invitation_qrRow: (a: number, b: number, c: number) => void;
    readonly invitation_qrSize: (a: number, b: number) => void;
    readonly invitation_relayWs: (a: number, b: number) => void;
    readonly invitation_uri: (a: number, b: number) => void;
    readonly joinsession_abandonMessage: (a: number, b: number, c: number) => void;
    readonly joinsession_accept: (a: number, b: number, c: number, d: number) => void;
    readonly joinsession_joinMessage: (a: number, b: number) => void;
    readonly joinsession_new: (a: number, b: number) => void;
    readonly joinsession_open: (a: number, b: number, c: number, d: number) => void;
    readonly namespace_clear: (a: number) => void;
    readonly namespace_commit: (a: number, b: number, c: bigint, d: bigint, e: number, f: number, g: number, h: number) => void;
    readonly namespace_evaluate: (a: number, b: number, c: number, d: number) => void;
    readonly namespace_generateKey: (a: number) => void;
    readonly namespace_mergeManifests: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint) => void;
    readonly namespace_missingBlobs: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly namespace_new: (a: number, b: number, c: number) => void;
    readonly namespace_openChunk: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly namespace_openManifest: (a: number, b: number, c: number, d: number) => void;
    readonly namespace_openPointer: (a: number, b: number, c: number, d: number) => void;
    readonly namespace_stage: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly originVerdict: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly pageOrigin: (a: number, b: number, c: number) => void;
    readonly pairingStep: (a: number, b: number, c: number) => void;
    readonly pairingcode_channel: (a: number, b: number) => void;
    readonly pairingcode_generate: (a: number) => void;
    readonly pairingcode_parse: (a: number, b: number, c: number) => void;
    readonly pairingcode_text: (a: number, b: number) => void;
    readonly parseAccountKey: (a: number, b: number, c: number) => void;
    readonly parseVaultKey: (a: number, b: number, c: number) => void;
    readonly passkeys_assert: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly passkeys_candidates: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly passkeys_collectTombstones: (a: number, b: bigint) => number;
    readonly passkeys_create: (a: number, b: number, c: number, d: number, e: number, f: bigint) => void;
    readonly passkeys_delete: (a: number, b: number, c: number, d: bigint) => number;
    readonly passkeys_fromCbor: (a: number, b: number, c: number) => void;
    readonly passkeys_isEmpty: (a: number) => number;
    readonly passkeys_len: (a: number) => number;
    readonly passkeys_list: (a: number, b: number) => void;
    readonly passkeys_merge: (a: number, b: number) => number;
    readonly passkeys_new: () => number;
    readonly passkeys_search: (a: number, b: number, c: number, d: number) => void;
    readonly passkeys_toCbor: (a: number, b: number) => void;
    readonly qrRowsFor: (a: number, b: number, c: number) => void;
    readonly readAccountLink: (a: number, b: number, c: number) => void;
    readonly readRecoveryKit: (a: number, b: number, c: number) => void;
    readonly renderRecoveryKit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly rpIdVerdict: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly secrets_collectTombstones: (a: number, b: bigint) => number;
    readonly secrets_delete: (a: number, b: number, c: number, d: bigint) => number;
    readonly secrets_forPage: (a: number, b: number, c: number, d: number) => void;
    readonly secrets_fromCbor: (a: number, b: number, c: number) => void;
    readonly secrets_get: (a: number, b: number, c: number, d: number) => void;
    readonly secrets_isEmpty: (a: number) => number;
    readonly secrets_len: (a: number) => number;
    readonly secrets_merge: (a: number, b: number) => number;
    readonly secrets_put: (a: number, b: number, c: number, d: bigint) => void;
    readonly secrets_search: (a: number, b: number, c: number, d: number) => void;
    readonly secrets_toCbor: (a: number, b: number) => void;
    readonly secrets_new: () => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
