import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLocalUrl } from "../src/config.ts";
import { PayPalError } from "../src/paypal/gateway.ts";
import { createApp, type AppDeps } from "../src/server/app.ts";
import { AGENT_TOKEN, makeApp, openBudget, OWNER_PASSWORD, requestBudget } from "./fixtures.ts";

const modes = { paypal: "simulated", search: "demo", agent: "off", reviewer: "off", model: "test" };

describe("hosting", () => {
  it("answers /healthz without the owner password", async () => {
    const app = createApp({ modes, ownerPassword: "secret" } as unknown as AppDeps);
    const health = await app.request("/healthz");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal((await app.request("/api/state")).status, 401);
  });

  it("treats only this machine as local", () => {
    assert.ok(isLocalUrl("http://localhost:3000"));
    assert.ok(isLocalUrl("http://127.0.0.1:3105"));
    assert.ok(isLocalUrl("http://[::1]:3000"));
    assert.ok(isLocalUrl("http://remit.localhost"));
    assert.ok(!isLocalUrl("https://remit.onrender.com"));
    assert.ok(!isLocalUrl("https://localhost.example.com"));
  });
});

const basic = (password: string) => ({ Authorization: `Basic ${Buffer.from(`owner:${password}`).toString("base64")}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const postJson = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("owner routes", () => {
  it("need the owner password when one is set", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD, agentToken: AGENT_TOKEN });
    assert.equal((await app.request("/api/state")).status, 401);
    assert.equal((await app.request("/api/state", { headers: basic("wrong") })).status, 401);
    // The agent token doesn't open owner routes.
    assert.equal((await app.request("/api/state", { headers: bearer(AGENT_TOKEN) })).status, 401);
    assert.equal((await app.request("/api/period/close", { method: "POST" })).status, 401);
    assert.equal((await app.request("/api/lines/move", postJson({ from: "a", to: "b", amountCents: 1 }))).status, 401);

    const ok = await app.request("/api/state", { headers: basic(OWNER_PASSWORD) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).modes.paypal, "simulated");
  });

  it("are open on localhost without a password", async () => {
    const { app } = makeApp();
    assert.equal((await app.request("/api/state")).status, 200);
  });

  it("turn bad input into 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/lines/move", postJson({ from: "groceries", amountCents: -5 }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "BAD_INPUT");
    assert.equal((await app.request("/api/chat", postJson({ message: "" }))).status, 400);
  });

  it("keep a wallet error's code and status", async () => {
    const { app } = makeApp();
    const missing = await app.request("/api/requests/nope/checkout", { method: "POST" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "NOT_FOUND");
    const closing = await app.request("/api/period/close", { method: "POST" });
    assert.equal(closing.status, 400);
    assert.equal((await closing.json()).error, "NO_PERIOD");
  });

  it("turn a PayPal error into 502 with PayPal's issue", async () => {
    const { app, wallet, paypal } = makeApp();
    const { requestId } = requestBudget(wallet);
    paypal.createAuthorizeOrder = async () => {
      throw new PayPalError("Something went wrong on PayPal's side.", 500, "INTERNAL_SERVER_ERROR");
    };
    const res = await app.request(`/api/requests/${requestId}/checkout`, { method: "POST" });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "INTERNAL_SERVER_ERROR", message: "PayPal: Something went wrong on PayPal's side." });
  });
});

describe("agent API", () => {
  it("needs the agent token, not the owner password", async () => {
    const { app } = makeApp({ ownerPassword: OWNER_PASSWORD, agentToken: AGENT_TOKEN });
    assert.equal((await app.request("/agent/v1/tools")).status, 401);
    assert.equal((await app.request("/agent/v1/tools", { headers: bearer("wrong") })).status, 401);
    assert.notEqual((await app.request("/agent/v1/tools", { headers: basic(OWNER_PASSWORD) })).status, 200);
    assert.equal((await app.request("/agent/v1/tools/get_balance", postJson({}))).status, 401);

    const res = await app.request("/agent/v1/tools", { headers: bearer(AGENT_TOKEN) });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).includes("spend"));
  });

  it("takes only Agents-page tokens when no shared token is set", async () => {
    const { app, wallet } = makeApp();
    assert.equal((await app.request("/agent/v1/tools/get_balance", postJson({}, bearer("anything")))).status, 401);
    const { token } = wallet.agents.create("Helper");
    assert.equal((await app.request("/agent/v1/tools/get_balance", postJson({}, bearer(token)))).status, 200);
  });

  it("runs tools and maps their errors", async () => {
    const { app, wallet, paypal } = makeApp({ agentToken: AGENT_TOKEN });
    const call = (name: string, body: unknown) => app.request(`/agent/v1/tools/${name}`, postJson(body, bearer(AGENT_TOKEN)));
    const spend = { line: "groceries", amount: 10, title: "Rice", merchant: "shop.example", reasoning: "On the list" };

    const noBudget = await call("spend", spend);
    assert.equal(noBudget.status, 409);
    assert.equal((await noBudget.json()).error, "NO_BUDGET");

    const bad = await call("spend", { line: "groceries" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "BAD_INPUT");

    assert.equal((await call("move_money", {})).status, 404);

    await openBudget(wallet, paypal);
    const paid = await call("spend", spend);
    assert.equal(paid.status, 200);
    assert.equal((await paid.json()).status, "paid");
  });
});

describe("PayPal return", () => {
  it("does nothing when the owner didn't approve on PayPal", async () => {
    const { app, wallet } = makeApp();
    const { requestId } = requestBudget(wallet);
    const { orderId } = await wallet.checkout(requestId);

    const res = await app.request(`/paypal/return?request=${requestId}&token=${orderId}`);
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") ?? "", /^\/app\?error=/);
    assert.equal(wallet.balance().period?.status, "pending");
    assert.equal(wallet.balance().approvedCents, 0);
  });

  it("does nothing for an order that doesn't match the request", async () => {
    const { app, wallet, paypal } = makeApp();
    const { requestId } = requestBudget(wallet);
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);

    const res = await app.request(`/paypal/return?request=${requestId}&token=SOMEONE-ELSES`);
    assert.match(res.headers.get("location") ?? "", /^\/app\?error=/);
    assert.equal(wallet.balance().period?.status, "pending");
  });

  it("opens the budget once PayPal approved it", async () => {
    const { app, wallet, paypal } = makeApp();
    const { requestId } = requestBudget(wallet);
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);

    const res = await app.request(`/paypal/return?request=${requestId}&token=${orderId}`);
    assert.equal(res.headers.get("location"), `/app?approved=${requestId}`);
    assert.equal(wallet.balance().period?.status, "open");
    assert.equal(wallet.balance().leftCents, 5000);
  });
});
