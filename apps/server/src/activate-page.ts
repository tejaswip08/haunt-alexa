import { normalizeCode } from "./code-input.ts";

/**
 * The phone page a TV's QR code opens (/activate?code=XXXX-XXXX). It signs the phone in
 * with the usual email code (/api/auth/start and /verify), then approves the TV
 * (/api/auth/device/approve). Self-contained: no build step, no external requests.
 */
const normalizeCodeSource = normalizeCode.toString();

export const activatePage = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in on your TV · Haunt</title>
<style>
  :root { color-scheme: dark; --bg: #07080a; --panel: #111318; --line: #2a2e37; --text: #ece6da; --muted: #a39d90; --red: #d61f3d; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 17px/1.5 system-ui, sans-serif; display: flex; justify-content: center; padding: 32px 16px; }
  main { width: 100%; max-width: 420px; }
  h1 { font: 700 40px/1.1 Georgia, "Times New Roman", serif; letter-spacing: .28em; margin: 0 0 4px; }
  .mark { width: 44px; height: 3px; background: var(--red); margin-bottom: 28px; }
  h2 { font: 600 26px/1.2 Georgia, serif; margin: 0 0 8px; }
  p { color: var(--muted); margin: 0 0 18px; }
  label { display: block; font-size: 14px; color: var(--muted); margin: 0 0 6px; }
  input { width: 100%; padding: 14px; border-radius: 10px; border: 2px solid var(--line); background: var(--panel); color: var(--text); font-size: 18px; margin-bottom: 14px; }
  input:focus { outline: none; border-color: var(--red); }
  #tv-code { text-transform: uppercase; letter-spacing: .2em; font-weight: 700; text-align: center; font-size: 24px; }
  button { width: 100%; padding: 14px; border: 0; border-radius: 10px; background: var(--red); color: #fff; font-size: 18px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .link { background: none; color: var(--muted); text-decoration: underline; padding: 10px 0 0; font-size: 15px; font-weight: 400; }
  .error { color: #ff7a8a; min-height: 24px; margin: 4px 0 10px; }
  .notice { border: 1px solid var(--line); border-left: 4px solid var(--red); background: var(--panel); padding: 10px 14px; border-radius: 8px; font-size: 14px; color: var(--muted); margin-bottom: 22px; }
  .hidden { display: none; }
  .done { font-size: 60px; text-align: center; margin: 10px 0; }
</style>
</head>
<body>
<main>
  <h1>HAUNT</h1>
  <div class="mark"></div>
  <div id="mock" class="notice hidden">Test mode: codes are printed in the Haunt server console, not emailed.</div>

  <label for="tv-code">Code on your TV</label>
  <input id="tv-code" autocomplete="off" maxlength="9" placeholder="XXXX-XXXX">

  <section id="step-email">
    <h2 id="email-title">Sign in to continue</h2>
    <p id="email-hint">We'll email you a one-time code. No password needed.</p>
    <form id="email-form">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="email" required>
      <button id="email-button">Email me a code</button>
    </form>
    <button class="link" id="toggle-mode" type="button">New here? Create an account</button>
  </section>

  <section id="step-code" class="hidden">
    <h2>Check your email</h2>
    <p id="code-hint">Enter the code we sent you.</p>
    <form id="code-form">
      <label for="code">Code</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" required>
      <button id="code-button">Verify</button>
    </form>
    <button class="link" id="restart" type="button">Use a different email</button>
  </section>

  <section id="step-approve" class="hidden">
    <h2>Sign in to Haunt on your TV?</h2>
    <p>You're signing in as <strong id="who"></strong>.</p>
    <button id="approve">Confirm and continue</button>
    <button class="link" id="cancel" type="button">Cancel</button>
  </section>

  <section id="step-cancelled" class="hidden">
    <h2>Cancelled</h2>
    <p>Nothing was signed in on your TV. Get a new code on your TV to try again.</p>
  </section>

  <section id="step-done" class="hidden">
    <div class="done">✓</div>
    <h2>You're in</h2>
    <p>Look at your TV. You can close this page.</p>
  </section>

  <div class="error" id="error" role="alert"></div>
</main>
<script>
(() => {
  // Shared with the server (code-input.ts): the same source, so the page and the server can't disagree.
  const normalizeCode = ${normalizeCodeSource};
  const $ = (id) => document.getElementById(id);
  const headers = { "X-Haunt-Client": "web", "Content-Type": "application/json" };
  const api = async (path, body) => {
    const res = await fetch(path, { method: "POST", headers, body: body ? JSON.stringify(body) : undefined });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  };
  let mode = "signin";
  // Digits the code must have: 8 for Cognito's sign-in code, null for Cognito's account-confirmation code.
  let codeLength = 8;
  const show = (step) => {
    for (const s of ["email", "code", "approve", "done", "cancelled"]) $("step-" + s).classList.toggle("hidden", s !== step);
    $("error").textContent = "";
  };
  const fail = (message) => { $("error").textContent = message || "Something went wrong. Try again."; };
  const signedIn = (user) => { $("who").textContent = (user && user.email) || "your account"; show("approve"); };

  $("tv-code").value = (new URLSearchParams(location.hash.slice(1)).get("code") || "").toUpperCase();

  let verifying = false;

  fetch("/api/health").then((r) => r.json()).then((h) => {
    if (h.authMock) $("mock").classList.remove("hidden");
    if (h.signIn !== "email-otp") fail("Sign-in isn't set up on this server yet.");
  }).catch(() => {});

  // Already signed in on this phone? Skip straight to approving the TV.
  api("/api/auth/refresh").then((r) => { if (r.ok && r.data.accessToken) signedIn(r.data.user); });

  $("toggle-mode").onclick = () => {
    mode = mode === "signin" ? "signup" : "signin";
    $("email-title").textContent = mode === "signin" ? "Sign in to continue" : "Create your account";
    $("toggle-mode").textContent = mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in";
  };

  $("email-form").onsubmit = async (e) => {
    e.preventDefault();
    $("email-button").disabled = true;
    const r = await api("/api/auth/start", { email: $("email").value, mode }).catch(() => null);
    $("email-button").disabled = false;
    if (!r || !r.ok) return fail(r && r.data.error);
    codeLength = r.data.codeLength === undefined ? 8 : r.data.codeLength;
    show("code");
    $("code").focus();
  };

  $("code-form").onsubmit = async (e) => {
    e.preventDefault();
    // A second tap while the first is in flight would send the same code twice; the first answer is the one that counts.
    if (verifying) return;
    // The same normalization the server applies (spaces and invisible characters removed, nothing else), then the
    // strict digit check. Nothing is cut short, and a letter or a dash is refused, not dropped.
    const typed = normalizeCode($("code").value);
    // [0-9] rather than \d: this script lives in a template literal, where a backslash escape would be dropped.
    const complete = codeLength === null ? /^[0-9]{6,8}$/.test(typed) : typed.length === codeLength && /^[0-9]+$/.test(typed);
    if (!complete) {
      return fail(codeLength ? "Enter the " + codeLength + "-digit code from the email." : "Enter the 6 to 8 digit code from the email.");
    }
    verifying = true;
    $("code-button").disabled = true;
    const r = await api("/api/auth/verify", { code: typed }).catch(() => null);
    verifying = false;
    $("code-button").disabled = false;
    if (!r || !r.ok) {
      if (r && r.data.restart) show("email");
      return fail(r && r.data.error);
    }
    if (r.data.accessToken) return signedIn(r.data.user);
    // A new account was confirmed: the sign-in code that follows has eight digits.
    codeLength = 8;
    $("code").value = "";
    $("code-hint").textContent = r.data.message || "Enter the new code we sent you.";
  };

  $("restart").onclick = () => show("email");

  $("approve").onclick = async () => {
    $("approve").disabled = true;
    const r = await api("/api/auth/device/approve", { userCode: $("tv-code").value }).catch(() => null);
    $("approve").disabled = false;
    if (!r || !r.ok) {
      if (r && r.status === 401) show("email");
      return fail(r && r.data.error);
    }
    show("done");
  };

  $("cancel").onclick = async () => {
    await api("/api/auth/device/decline", { userCode: $("tv-code").value }).catch(() => null);
    show("cancelled");
  };
})();
</script>
</body>
</html>
`;
