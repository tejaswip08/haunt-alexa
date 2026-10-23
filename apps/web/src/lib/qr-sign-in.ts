import { useEffect, useRef, useState } from "react";
import qrcode from "qrcode-generator";

/**
 * Sign in on this browser by scanning a QR code with a phone (the website's sign-in page and the Alexa+ device).
 * The phone verifies its own email with a Cognito code and confirms; this browser only ever holds the opaque session
 * cookie the server sets on approval. The device code stays in this page's memory and never enters the QR.
 */

export type QrStatus = "starting" | "waiting" | "approved" | "expired" | "cancelled" | "error";

export interface QrCode {
  /** The QR as an SVG data URL. */
  src: string;
  /** The short code to type on the phone instead of scanning, e.g. "7S38-KC4F". */
  userCode: string;
  /** The page the phone opens to type the code. */
  verificationUri: string;
}

const JSON_HEADERS = { "X-Haunt-Client": "web", "Content-Type": "application/json" };

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, data };
}

/** The QR as an SVG data URL. The content is the phone link from our own server, never user input. */
export function qrDataUrl(value: string): string {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }))}`;
}

/** While `active`, shows a fresh pairing QR and waits for a phone to approve it; `onApproved` runs once it does. */
export function useQrSignIn(active: boolean, onApproved: () => void) {
  const [status, setStatus] = useState<QrStatus>("starting");
  const [qr, setQr] = useState<QrCode | null>(null);
  const [attempt, setAttempt] = useState(0);
  const approved = useRef(onApproved);
  approved.current = onApproved;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let deviceCode = "";
    let timer: ReturnType<typeof setInterval> | undefined;
    setStatus("starting");
    setQr(null);

    (async () => {
      const started = await post("/api/auth/device/start", {});
      if (cancelled) return;
      if (!started.ok) return void setStatus("error");
      deviceCode = String(started.data.deviceCode);
      setQr({
        src: qrDataUrl(String(started.data.verificationUriComplete)),
        userCode: String(started.data.userCode),
        verificationUri: String(started.data.verificationUri ?? ""),
      });
      setStatus("waiting");
      timer = setInterval(async () => {
        const polled = await post("/api/auth/device/poll", { deviceCode });
        if (cancelled || !polled.ok) return;
        if (polled.data.status === "approved") {
          clearInterval(timer);
          setStatus("approved");
          approved.current();
        } else if (polled.data.status === "expired" || polled.data.status === "cancelled") {
          clearInterval(timer);
          setStatus(polled.data.status);
        }
      }, 2_000);
    })().catch(() => !cancelled && setStatus("error"));

    return () => {
      cancelled = true;
      clearInterval(timer);
      // Cancelling on leave voids the pairing; the server ignores codes it has already used.
      if (deviceCode) void post("/api/auth/device/cancel", { deviceCode }).catch(() => undefined);
    };
  }, [active, attempt]);

  return { status, qr, restart: () => setAttempt((n) => n + 1) };
}
