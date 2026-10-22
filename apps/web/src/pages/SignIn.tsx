import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import qrcode from "qrcode-generator";
import { SceneArt } from "../components/SceneArt.tsx";
import { useMotion } from "../lib/motion.ts";
import { session, useSession } from "../lib/session.ts";
import { navigate } from "../router.tsx";

type Mode = "signin" | "signup";

/** Cognito's built-in sign-in code has eight digits for this pool. It is not configurable. */
const SIGN_IN_CODE_DIGITS = 8;

/**
 * Whether the typed code can be submitted. `length` null means Cognito's confirmation code, which is six to
 * eight digits (Cognito verifies it). Nothing is truncated or padded: a code is either complete or not.
 */
function codeComplete(code: string, length: number | null): boolean {
  return length === null ? code.length >= 6 && code.length <= 8 : code.length === length;
}
/** "choose": the three options. The others are the email and QR steps. */
type View = "choose" | "email" | "code" | "qr";
type QrStatus = "starting" | "waiting" | "approved" | "expired" | "cancelled" | "error";

/** Where to go after signing in: a same-site path from ?next=, or My Stories. */
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/my-stories";
}

const JSON_HEADERS = { "X-Haunt-Client": "web", "Content-Type": "application/json" };

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: JSON_HEADERS, credentials: "same-origin", body: JSON.stringify(body) });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, data };
}

/** The QR as an SVG data URL. The content is the phone link from our own server, never user input. */
function qrDataUrl(value: string): string {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }))}`;
}

/**
 * Sign in on this browser by scanning a QR code with a phone. The phone verifies its own email
 * with a Cognito code and confirms; this browser only ever holds the opaque session cookie
 * the server sets on approval. The device code stays in this page's memory and never enters the QR.
 */
function useQrSignIn(active: boolean, onApproved: () => void) {
  const [status, setStatus] = useState<QrStatus>("starting");
  const [qr, setQr] = useState<{ src: string; userCode: string } | null>(null);
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
      setQr({ src: qrDataUrl(String(started.data.verificationUriComplete)), userCode: String(started.data.userCode) });
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

/**
 * Sign-in options for Haunt's own pages: a phone QR, a one-time email code, or guest play.
 * Full screen, like the TV: the haunted house on the left, the options on the right.
 */
export function SignIn() {
  const state = useSession();
  const { level } = useMotion();
  const [view, setView] = useState<View>("choose");
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  // Digits the code must have: 8 for Cognito's sign-in code, or null for Cognito's account-confirmation code.
  const [codeLength, setCodeLength] = useState<number | null>(SIGN_IN_CODE_DIGITS);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const codeInput = useRef<HTMLInputElement>(null);

  const qrSignIn = useQrSignIn(view === "qr", () => {
    // The server set this browser's session cookie on approval: restore it, then go on.
    void session.init().then(() => navigate(nextPath()));
  });

  useEffect(() => {
    if (state.status === "signed-in") navigate(nextPath());
  }, [state.status]);
  useEffect(() => {
    if (view === "code") codeInput.current?.focus();
  }, [view]);

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    setWorking(true);
    setError(undefined);
    const result = await session.start(email, mode);
    setWorking(false);
    if (!result.ok) return setError(result.error);
    setCode("");
    setCodeLength(result.codeLength === undefined ? SIGN_IN_CODE_DIGITS : result.codeLength);
    setNote(view === "code" ? "A new code is on its way." : undefined);
    setView("code");
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(undefined);
    const result = await session.verify(code);
    setWorking(false);
    if (!result.ok) {
      setError(result.error);
      if (result.restart) setCode("");
      return;
    }
    if (!result.signedIn) {
      // A new account was confirmed, and Cognito wants a sign-in code as well: eight digits.
      setCode("");
      setCodeLength(SIGN_IN_CODE_DIGITS);
      setNote("Your account is ready. We've emailed you a sign-in code.");
    }
    // Signed in: the effect above moves on.
  };

  const guest = () => navigate("/alexa");
  const back = () => {
    setView("choose");
    setError(undefined);
    setNote(undefined);
  };

  const guestNote = (
    <p className="signin-hint">
      Guest stories are kept only in this browser or on this device. Sign in to keep them in your account.
    </p>
  );

  return (
    <div className="signin">
      <section className="signin-art" aria-hidden>
        <SceneArt className="signin-scene" image={null} presentation={{ setting: "house" }} mood="dread" motion={level} />
        <div className="signin-brand">
          <h1 className="signin-wordmark">Haunt</h1>
          <span className="signin-rule" />
          <p className="signin-tagline">Every choice echoes in the dark.</p>
          <p className="signin-sub">Interactive horror stories that twist with every decision you make.</p>
        </div>
      </section>

      <section className="signin-panel" aria-labelledby="signin-title">
        {!state.available && state.status !== "loading" ? (
          <>
            <h2 id="signin-title">Play as a guest</h2>
            <p className="signin-hint">Accounts aren't available on this server yet. You can still play every story.</p>
            {guestNote}
            <div className="signin-actions">
              <button type="button" className="signin-button primary" onClick={guest}>
                Continue as Guest
              </button>
            </div>
          </>
        ) : view === "choose" ? (
          <>
            <h2 id="signin-title">Sign in to Haunt</h2>
            <div className="signin-options">
              <button type="button" className="signin-option primary" onClick={() => setView("qr")}>
                <span className="signin-option-title">Continue with QR code</span>
                <span className="signin-option-text">Scan with your phone to sign in here or on your TV.</span>
              </button>
              <button type="button" className="signin-option" onClick={() => setView("email")}>
                <span className="signin-option-title">Continue with email</span>
                <span className="signin-option-text">We'll email you a one-time code. No password.</span>
              </button>
              <button type="button" className="signin-option" onClick={guest}>
                <span className="signin-option-title">Continue as guest</span>
                <span className="signin-option-text">Play now. Stories stay on this browser or device.</span>
              </button>
            </div>
            {guestNote}
          </>
        ) : view === "qr" ? (
          <>
            <h2 id="signin-title">Scan with your phone</h2>
            <p className="signin-hint">Open your phone's camera and scan this code. Confirm the email shown on your phone to sign in here.</p>
            {qrSignIn.status === "starting" && <p className="signin-hint" role="status">Making your code…</p>}
            {qrSignIn.qr && qrSignIn.status !== "expired" && qrSignIn.status !== "cancelled" && (
              <div className="signin-qr">
                <img src={qrSignIn.qr.src} alt="QR code to sign in with your phone" width={220} height={220} />
                <p className="signin-hint">
                  Or enter the code <strong className="signin-usercode">{qrSignIn.qr.userCode}</strong> on your phone.
                </p>
              </div>
            )}
            {qrSignIn.status === "waiting" && <p className="signin-hint" role="status">Waiting for your phone…</p>}
            {qrSignIn.status === "expired" && (
              <p className="signin-error" role="alert">
                This QR code has expired. Get a new one to try again.
              </p>
            )}
            {qrSignIn.status === "cancelled" && (
              <p className="signin-error" role="alert">
                Sign-in was cancelled on your phone. Get a new code to try again.
              </p>
            )}
            {qrSignIn.status === "error" && (
              <p className="signin-error" role="alert">
                Sign-in with a phone isn't available right now. Try email instead.
              </p>
            )}
            <div className="signin-actions">
              {(qrSignIn.status === "expired" || qrSignIn.status === "cancelled" || qrSignIn.status === "error") && (
                <button type="button" className="signin-button primary" onClick={qrSignIn.restart}>
                  New code
                </button>
              )}
              <button type="button" className="signin-button" onClick={back}>
                Back
              </button>
            </div>
          </>
        ) : step(view, { email, mode, setMode, setEmail, sendCode, verify, code, setCode, codeLength, working, error, note, codeInput, back, guest })}
      </section>
    </div>
  );
}

/** The email steps, unchanged in behaviour: request a code, then check it. */
function step(
  view: "email" | "code",
  p: {
    email: string;
    mode: Mode;
    setMode: (m: Mode) => void;
    setEmail: (v: string) => void;
    sendCode: (e?: FormEvent) => Promise<void>;
    verify: (e: FormEvent) => Promise<void>;
    code: string;
    setCode: (v: string) => void;
    working: boolean;
    error?: string;
    note?: string;
    codeInput: RefObject<HTMLInputElement | null>;
    back: () => void;
    codeLength: number | null;
    guest: () => void;
  },
) {
  if (view === "email") {
    return (
      <>
        <h2 id="signin-title">{p.mode === "signin" ? "Welcome back" : "Create your account"}</h2>
        <div className="signin-tabs" role="tablist" aria-label="Sign in or create an account">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={p.mode === m}
              className={p.mode === m ? "is-active" : undefined}
              onClick={() => p.setMode(m)}
            >
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>
        <form className="signin-form" onSubmit={p.sendCode}>
          <label htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={254}
            value={p.email}
            onChange={(e) => p.setEmail(e.target.value)}
          />
          <p className="signin-hint">
            {p.mode === "signin" ? "We'll email you a one-time code. No password needed." : "We'll email you a code to confirm it's you. No password needed."}
          </p>
          {p.error && (
            <p className="signin-error" role="alert">
              {p.error}
            </p>
          )}
          <div className="signin-actions">
            <button type="submit" className="signin-button primary" disabled={p.working || !p.email.trim()}>
              {p.working ? "Sending…" : "Email me a code"}
            </button>
            <button type="button" className="signin-button" onClick={p.back}>
              Back
            </button>
          </div>
        </form>
      </>
    );
  }
  return (
    <>
      <h2 id="signin-title">Check your email</h2>
      <p className="signin-hint">
        If <strong>{p.email}</strong> {p.mode === "signup" ? "is new here" : "has an account"}, a code is on its way. It expires in a few minutes.
      </p>
      <form className="signin-form" onSubmit={p.verify}>
        <label htmlFor="signin-code">Code</label>
        <input
          ref={p.codeInput}
          id="signin-code"
          className="signin-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern={p.codeLength ? `[0-9]{${p.codeLength}}` : "[0-9]{6,8}"}
          aria-describedby="signin-code-hint"
          required
          value={p.code}
          onChange={(e) => p.setCode(e.target.value.replace(/\D/g, ""))}
        />
        <p id="signin-code-hint" className="signin-hint">
          {p.codeLength
            ? `Enter the ${p.codeLength}-digit code. Leading zeros count.`
            : "Enter the 6 to 8 digit code. Leading zeros count."}
        </p>
        {p.note && (
          <p className="signin-hint" role="status">
            {p.note}
          </p>
        )}
        {p.error && (
          <p className="signin-error" role="alert">
            {p.error}
          </p>
        )}
        <div className="signin-actions">
          <button type="submit" className="signin-button primary" disabled={p.working || !codeComplete(p.code, p.codeLength)}>
            {p.working ? "Checking…" : p.mode === "signup" ? "Create account" : "Sign in"}
          </button>
          <button type="button" className="signin-button" disabled={p.working} onClick={() => void p.sendCode()}>
            New code
          </button>
        </div>
        <button type="button" className="signin-link" onClick={p.back}>
          Use a different email
        </button>
      </form>
    </>
  );
}
