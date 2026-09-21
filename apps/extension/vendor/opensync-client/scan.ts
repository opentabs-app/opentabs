// @ts-nocheck -- vendored; see scripts/vendor-opensync.mjs
import { Invitation } from "./wasm/opensync_wasm.js";
import { ready } from "./session";

/**
 * Reading a pairing QR with the camera.
 *
 * Two things gate this and both are worth saying out loud rather than
 * discovering as a silent failure.
 *
 * **A secure context.** `getUserMedia` is unavailable over plain `http://` to
 * anything but `localhost`, which is exactly how a self-hosted setup is
 * usually reached — `http://192.168.0.10:8080`. The button has to know that
 * before it is pressed, or a phone taps Scan and nothing happens.
 *
 * **`BarcodeDetector`.** Chrome and Edge have it; Safari and Firefox do not.
 * Shipping a JavaScript QR *decoder* to cover them would be a second decoder
 * to keep correct — the encoder is already compiled and tested — for a case
 * where typing ten characters still works. So the fallback is the field that
 * was always there, and the button simply does not appear.
 */
export function canScan(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    "BarcodeDetector" in window &&
    typeof navigator?.mediaDevices?.getUserMedia === "function"
  );
}

/** Why scanning is unavailable, in words a person can act on. */
export function whyNotScannable(): string {
  if (typeof window === "undefined") return "no browser here";
  if (!window.isSecureContext) {
    return "The camera needs a secure page. Over plain http only localhost counts, so a relay reached at a LAN address cannot use it — type the code instead.";
  }
  if (!("BarcodeDetector" in window)) {
    return "This browser cannot read QR codes. Chrome and Edge can; type the code instead.";
  }
  return "No camera available on this device.";
}

export interface Scan {
  /** Resolves with the invitation URI, or rejects if stopped or timed out. */
  result: Promise<string>;
  /** Stop the camera. Safe to call twice, and always call it. */
  stop(): void;
}

/**
 * Point the camera at a QR and wait for one that is an invitation.
 *
 * Anything else in frame is ignored rather than returned: a settings screen
 * full of other people's QR codes should not hand a wi-fi password to the
 * pairing field.
 *
 * The caller owns the `<video>` element and its layout. The camera is released
 * on every exit path — success, failure, or `stop()` — because a page that
 * leaves the light on is a page nobody opens twice.
 */
export function scanInvitation(
  video: HTMLVideoElement,
  options: { timeoutMs?: number } = {},
): Scan {
  let stream: MediaStream | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    video.srcObject = null;
  };

  const result = (async () => {
    if (!canScan()) throw new Error(whyNotScannable());
    // `Invitation.parse` is compiled, so the module has to be up before the
    // first frame is examined. Leaving this to the caller is what turned a
    // successful scan into "no code found": every parse threw, and the loop
    // read that as somebody else's QR and kept looking.
    await ready();

    stream = await navigator.mediaDevices.getUserMedia({
      // The back camera on a phone, and whatever there is on a laptop.
      video: { facingMode: "environment" },
      audio: false,
    });
    if (stopped) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error("stopped");
    }
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    await video.play();

    const Detector = (window as unknown as { BarcodeDetector: new (o: object) => {
      detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
    } }).BarcodeDetector;
    const detector = new Detector({ formats: ["qr_code"] });

    let failures = 0;
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    while (!stopped) {
      if (Date.now() > deadline) throw new Error("no code found — try holding it steadier");
      try {
        for (const found of await detector.detect(video)) {
          try {
            // Parsed, not merely matched on a prefix: what comes back is
            // handed straight to a pairing, and the parser is the thing that
            // decides whether this is one of ours.
            Invitation.parse(found.rawValue);
            return found.rawValue;
          } catch {
            // Somebody else's QR. Keep looking.
          }
        }
      } catch (e) {
        // A detect() can throw while the video is still warming up, and that
        // is not worth reporting. A detector that throws every time is: it
        // would otherwise present as a timeout, which sends people off to
        // hold their phone steadier at a browser that was never going to
        // read anything.
        failures += 1;
        if (failures > 20) {
          throw new Error(
            `this browser could not read the camera: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
      await new Promise((r) => {
        timer = setTimeout(r, 120);
      });
    }
    throw new Error("stopped");
  })().finally(stop);

  return { result, stop };
}
