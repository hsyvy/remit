import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoginThrottle, OwnerSessions, safeNext, SESSION_TTL_S } from "../src/server/session.ts";
import { makeApp, OWNER_PASSWORD } from "./fixtures.ts";

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});

/** The cookie a response sets, as a Cookie header for the next request. */
function cookieFrom(res: Response) {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

describe("owner sign-in", () => {
  it("shows the landing page and the sign-in page without a password", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD });
    const landing = await app.request("/");
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Your agent spends within its remit/);
    const login = await app.request("/login");
    assert.equal(login.status, 200);
    assert.match(await login.text(), /action="\/login"/);
    assert.equal((await app.request("/assets/mark.svg")).status, 200);
    assert.equal((await app.request("/styles.css")).status, 200);
  });

  it("sends a signed-out page load to the sign-in page, and API calls get 401", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD });
    const res = await app.request("/app");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login?next=%2Fapp");
    assert.equal(res.headers.get("www-authenticate"), null, "no browser password prompt");
    const api = await app.request("/api/state");
    assert.equal(api.status, 401);
    assert.equal(api.headers.get("www-authenticate"), null);
  });

  it("signs in with the password, opens the app and the API, and signs out", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD });
    const res = await app.request("/login", form({ password: OWNER_PASSWORD, next: "/app#agents" }, { "x-forwarded-proto": "https" }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/app#agents");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = { Cookie: cookieFrom(res) };

    const page = await app.request("/app", { headers: cookie });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="signout"/);
    const state = await app.request("/api/state", { headers: cookie });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).signIn, true);
    // Already signed in: the sign-in page goes straight on.
    assert.equal((await app.request("/login?next=%2Fapp%23ledger", { headers: cookie })).headers.get("location"), "/app#ledger");

    const out = await app.request("/logout", { method: "POST", headers: cookie });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get("location"), "/");
    assert.match(out.headers.get("set-cookie") ?? "", /remit_session=;/);
  });

  it("sends a wrong password back with a message, and never to another site", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD });
    const wrong = await app.request("/login", form({ password: "nope", next: "/app" }));
    assert.equal(wrong.status, 303);
    assert.equal(wrong.headers.get("location"), "/login?error=wrong&next=%2Fapp");
    assert.equal(wrong.headers.get("set-cookie"), null);

    const offsite = await app.request("/login", form({ password: OWNER_PASSWORD, next: "//evil.example/" }));
    assert.equal(offsite.headers.get("location"), "/app");
  });

  it("stops guessing after ten wrong passwords from one address", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD });
    const from = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 10; i++) await app.request("/login", form({ password: `guess-${i}` }, from));
    const blocked = await app.request("/login", form({ password: OWNER_PASSWORD }, from));
    assert.match(blocked.headers.get("location") ?? "", /error=wait/);
    assert.equal(blocked.headers.get("set-cookie"), null);
    // Another address is unaffected.
    const other = await app.request("/login", form({ password: OWNER_PASSWORD }, { "x-forwarded-for": "198.51.100.4" }));
    assert.match(other.headers.get("set-cookie") ?? "", /remit_session=v1\./);
  });

  it("still accepts the password as Basic auth, for scripts", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD });
    const basic = { Authorization: `Basic ${Buffer.from(`owner:${OWNER_PASSWORD}`).toString("base64")}` };
    assert.equal((await app.request("/api/state", { headers: basic })).status, 200);
  });

  it("is open on localhost without a password", async () => {
    const { app } = makeApp();
    assert.equal((await app.request("/app")).status, 200);
    assert.equal((await app.request("/login")).headers.get("location"), "/app");
    const state = await app.request("/api/state");
    assert.equal((await state.json()).signIn, false);
  });
});

describe("session tokens", () => {
  it("expire, and can't be forged or carried across a password change", () => {
    let now = Date.parse("2026-11-09T10:00:00Z");
    const sessions = new OwnerSessions("secret", "pw-1", () => now);
    const token = sessions.issue();
    assert.ok(sessions.verify(token));
    assert.ok(!sessions.verify(undefined));
    assert.ok(!sessions.verify(token.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))));
    assert.ok(!sessions.verify(token.replace(/^v1\.\d+/, `v1.${Math.floor(now / 1000) + SESSION_TTL_S * 10}`)));
    assert.ok(!new OwnerSessions("secret", "pw-2", () => now).verify(token), "a new password signs everyone out");
    assert.ok(!new OwnerSessions("other", "pw-1", () => now).verify(token));
    now += SESSION_TTL_S * 1000 + 1000;
    assert.ok(!sessions.verify(token));
  });

  it("check the password in constant time, whatever its length", () => {
    const sessions = new OwnerSessions("secret", "correct horse");
    assert.ok(sessions.checkPassword("correct horse"));
    assert.ok(!sessions.checkPassword("correct"));
    assert.ok(!sessions.checkPassword(""));
  });

  it("only go back to a path on this site", () => {
    assert.equal(safeNext("/app#ledger"), "/app#ledger");
    assert.equal(safeNext(undefined), "/app");
    assert.equal(safeNext("https://evil.example"), "/app");
    assert.equal(safeNext("//evil.example"), "/app");
    assert.equal(safeNext("/\\evil.example"), "/app");
    assert.equal(safeNext("/app\r\nSet-Cookie: x"), "/app");
  });

  it("throttle forgets failures once the window passes", () => {
    let now = 0;
    const throttle = new LoginThrottle(2, 1000, () => now);
    throttle.fail("a");
    throttle.fail("a");
    assert.ok(throttle.blocked("a"));
    now = 1500;
    assert.ok(!throttle.blocked("a"));
  });
});
