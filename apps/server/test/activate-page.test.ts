import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { activatePage } = await import("../src/activate-page.ts");

type Reply = { ok: boolean; status: number; data: Record<string, unknown> };

/**
 * Runs the page's own inline script against a small DOM stand-in, so the tests exercise the shipped code: what it
 * checks, what it sends and what it shows. `codeLength` is what /api/auth/start answers (8 for sign-in, null for sign-up).
 */
function runPage(options: { codeLength?: number | null; verify?: (body: { code: string }) => Reply } = {}) {
  const script = activatePage.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const elements = new Map<string, Record<string, any>>();
  const element = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: "",
        textContent: "",
        disabled: false,
        focus() {},
        addEventListener() {},
        classList: { toggle() {}, remove() {} },
        onclick: null,
        onsubmit: null,
      });
    }
    return elements.get(id)!;
  };
  const sent: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const fetchStub = async (path: string, init?: { body?: string }) => {
    if (path === "/api/health") return { json: async () => ({ signIn: "email-otp" }) };
    if (path === "/api/auth/refresh") return { ok: false, status: 401, json: async () => ({}) };
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    sent.push({ path, body });
    if (path === "/api/auth/start") {
      return { ok: true, status: 200, json: async () => ({ ok: true, next: "code", codeLength: options.codeLength === undefined ? 8 : options.codeLength }) };
    }
    const reply = options.verify?.(body as { code: string }) ?? { ok: true, status: 200, data: { accessToken: "token", user: { email: "a@example.com" } } };
    return { ok: reply.ok, status: reply.status, json: async () => reply.data };
  };
  new Function("document", "location", "URLSearchParams", "fetch", script)(
    { getElementById: element },
    { hash: "" },
    URLSearchParams,
    fetchStub,
  );
  return {
    el: element,
    error: () => element("error").textContent,
    sent,
    async startEmail() {
      element("email").value = "a@example.com";
      await element("email-form").onsubmit({ preventDefault() {} });
    },
    async submitCode(value: string) {
      element("code").value = value;
      await element("code-form").onsubmit({ preventDefault() {} });
    },
  };
}

const verifyCalls = (page: ReturnType<typeof runPage>) => page.sent.filter((call) => call.path === "/api/auth/verify");

describe("mobile sign-in page (/activate), run as shipped", () => {
  it("sends an eight-digit sign-in code typed on a desktop or a phone keyboard", async () => {
    const page = runPage();
    await page.startEmail();
    await page.submitCode("12345678");
    assert.equal(page.error(), "");
    assert.deepEqual(verifyCalls(page).map((call) => call.body), [{ code: "12345678" }]);
  });

  it("sends an iOS-style or Android-style autofilled code once it is normalized", async () => {
    const pasted = [
      " 12345678 ", // padded with ordinary spaces
      "1234 5678", // a space inside, from a grouped code
      "1234 5678", // a no-break space, as iOS can add
      "​12345678​", // zero-width characters around the code
      "1234‎5678", // a left-to-right mark inside, as some Android pastes add
      "12345678\n", // a trailing line break
    ];
    for (const value of pasted) {
      const page = runPage();
      await page.startEmail();
      await page.submitCode(value);
      assert.equal(page.error(), "", JSON.stringify(value));
      assert.deepEqual(verifyCalls(page).map((call) => call.body), [{ code: "12345678" }], JSON.stringify(value));
    }
  });

  it("refuses an invalid code without sending it, and says what is wrong", async () => {
    const invalid: Array<[string, string]> = [
      ["1234-5678", "Enter the 8-digit code from the email."],
      ["12a45678", "Enter the 8-digit code from the email."],
      ["1234567", "Enter the 8-digit code from the email."],
      ["123456789", "Enter the 8-digit code from the email."],
      ["١٢٣٤٥٦٧٨", "Enter the 8-digit code from the email."],
      ["", "Enter the 8-digit code from the email."],
    ];
    for (const [value, message] of invalid) {
      const page = runPage();
      await page.startEmail();
      await page.submitCode(value);
      assert.equal(page.error(), message, JSON.stringify(value));
      assert.equal(verifyCalls(page).length, 0, `${JSON.stringify(value)} never reaches the server`);
    }
  });

  it("applies the six-to-eight-digit rule to a sign-up confirmation code", async () => {
    const page = runPage({ codeLength: null });
    await page.startEmail();
    await page.submitCode("123456");
    assert.equal(verifyCalls(page).length, 1);
    const short = runPage({ codeLength: null });
    await short.startEmail();
    await short.submitCode("12345");
    assert.equal(short.error(), "Enter the 6 to 8 digit code from the email.");
    assert.equal(verifyCalls(short).length, 0);
  });

  it("shows the server's message for an expired or wrong code, and sends one request for a double submit", async () => {
    const expired = runPage({
      verify: () => ({ ok: false, status: 400, data: { error: "That code has expired. Ask for a new one.", restart: true } }),
    });
    await expired.startEmail();
    await expired.submitCode("12345678");
    assert.equal(expired.error(), "That code has expired. Ask for a new one.");

    const wrong = runPage({ verify: () => ({ ok: false, status: 400, data: { error: "That code isn't right. Check the latest email and try again." } }) });
    await wrong.startEmail();
    await wrong.submitCode("00000000");
    assert.equal(wrong.error(), "That code isn't right. Check the latest email and try again.");

    const double = runPage();
    await double.startEmail();
    const first = double.submitCode("12345678");
    const second = double.submitCode("12345678");
    await Promise.all([first, second]);
    assert.equal(verifyCalls(double).length, 1, "the second tap is ignored while the first is in flight");
  });

  it("uses no user-agent checks, so every device gets the same page logic", () => {
    assert.doesNotMatch(activatePage, /userAgent|navigator\.platform|iPhone|Android/);
  });
});

