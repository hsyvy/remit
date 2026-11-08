import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ShoppingAgent } from "../src/demo/agent.ts";
import { openDb, type Db } from "../src/db.ts";
import { SimulatedPayPal } from "../src/paypal/simulated.ts";
import { createApp } from "../src/server/app.ts";
import { hashToken } from "../src/wallet/agents.ts";
import { runWalletTool } from "../src/wallet/tools.ts";
import { Wallet, WalletError } from "../src/wallet/wallet.ts";

const APP = "http://localhost:3000";
const SHARED = "shared-test-token";
const modes = { paypal: "simulated", search: "demo", agent: "off", reviewer: "off", model: "test" };
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let db: Db;
let paypal: SimulatedPayPal;
let wallet: Wallet;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  paypal = new SimulatedPayPal(db, APP);
  wallet = new Wallet(db, paypal, { appUrl: APP, maxRequestCents: 50_000 });
  const agent = { transcript: () => [], isBusy: false } as unknown as ShoppingAgent;
  app = createApp({ wallet, agent, modes, agentToken: SHARED });
});

async function call(token: string, tool: string, body: unknown = {}) {
  const res = await app.request(`/agent/v1/tools/${tool}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function owner(path: string, body: unknown = {}) {
  const res = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function approve(requestId: string) {
  const { orderId } = await wallet.checkout(requestId);
  paypal.approve(orderId);
  await wallet.completeApproval(requestId, orderId);
}

const budget = {
  summary: "Household week",
  starts_on: day(0),
  ends_on: day(6),
  lines: [{ key: "groceries", label: "Groceries", amount: 88, reason: "Last 4 weeks averaged $43.70 per order." }],
  buffer: { amount: 10, reason: "Price changes and shipping." },
};
const purchase = (line: string, amount: number) => ({ line, amount, title: "Thing", merchant: "shop.example", reasoning: "Needed for the week" });

describe("agent tokens", () => {
  it("accepts a per-agent token, and only its hash is stored", async () => {
    const created = await owner("/api/agents", { name: "Desktop assistant" });
    assert.equal(created.status, 201);
    const token = created.body.token as string;
    const id = (created.body.agent as { id: string }).id;
    assert.match(token, /^remit_agt_/);

    const row = db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(id) as { token_hash: string };
    assert.equal(row.token_hash, hashToken(token));
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM agents").all()).includes(token));
    const listed = await (await app.request("/api/agents")).json();
    assert.ok(!JSON.stringify(listed).includes(token));

    assert.equal((await call(token, "get_balance")).status, 200);
    assert.equal((await call("remit_agt_wrong", "get_balance")).status, 401);
    assert.equal((await app.request("/agent/v1/tools")).status, 401);

    // The purchase records which agent made it.
    await call(token, "request_budget", budget);
    await approve(wallet.pendingRequests()[0].id);
    assert.equal((await call(token, "spend", purchase("groceries", 20))).status, 200);
    assert.equal(wallet.state().purchases[0].agent, id);
    assert.equal(wallet.agentSummaries().find((a) => a.id === id)!.spentCents, 2000);
  });

  it("stops a revoked token for good", async () => {
    const { body } = await owner("/api/agents", { name: "Old laptop" });
    const id = (body.agent as { id: string }).id;
    assert.equal((await owner(`/api/agents/${id}/revoke`)).status, 200);
    assert.equal((await call(body.token as string, "get_balance")).status, 401);
    assert.ok(!wallet.agentSummaries().some((a) => a.id === id));
    // The built-in agents can't be revoked.
    assert.equal((await owner("/api/agents/default/revoke")).body.error, "BUILTIN_AGENT");
  });

  it("keeps the shared REMIT_AGENT_TOKEN working as the default agent", async () => {
    assert.equal((await call(SHARED, "request_budget", budget)).status, 200);
    await approve(wallet.pendingRequests()[0].id);
    const paid = await call(SHARED, "spend", purchase("groceries", 41.85));
    assert.equal(paid.status, 200);
    assert.equal(paid.body.line_left, "$46.15");
    assert.equal(wallet.state().purchases[0].agent, "default");
    assert.equal(wallet.balance().lines.find((l) => l.key === "groceries")!.agentId, "default");
  });
});

describe("pausing an agent", () => {
  it("refuses its money calls, records the refusal, and still lets it read", async () => {
    const { body } = await owner("/api/agents", { name: "Desktop assistant" });
    const token = body.token as string;
    const id = (body.agent as { id: string }).id;
    await call(token, "request_budget", budget);
    await approve(wallet.pendingRequests()[0].id);

    assert.equal((await owner(`/api/agents/${id}/pause`)).status, 200);
    const spend = await call(token, "spend", purchase("groceries", 20));
    assert.equal(spend.status, 403);
    assert.equal(spend.body.error, "AGENT_PAUSED");
    const refused = wallet.state().purchases[0];
    assert.equal(refused.status, "refused");
    assert.equal(refused.agent, id);
    assert.match(refused.refusal!, /paused/);
    assert.equal(wallet.state().totals.spentCents, 0);

    const topup = await call(token, "request_topup", { line: "groceries", amount: 20, reason: "Prices went up 20% this week at FreshCart" });
    assert.equal(topup.body.error, "AGENT_PAUSED");
    assert.equal(wallet.pendingRequests().length, 0);
    assert.ok(wallet.state().events.some((e) => e.type === "request_refused" && /Desktop assistant/.test(e.message)));

    assert.equal((await call(token, "get_balance")).status, 200);
    assert.equal((await call(token, "get_history")).status, 200);

    await owner(`/api/agents/${id}/resume`);
    assert.equal((await call(token, "spend", purchase("groceries", 20))).status, 200);
  });

  it("refuses a budget request from a paused agent", async () => {
    await owner("/api/agents/default/pause");
    const res = await call(SHARED, "request_budget", budget);
    assert.equal(res.body.error, "AGENT_PAUSED");
    assert.equal(wallet.balance().period, null);
    assert.equal(wallet.state().events[0].type, "request_refused");
  });
});

describe("per-agent lines", () => {
  it("lets an agent spend only from its own lines and the shared buffer", async () => {
    const a = await owner("/api/agents", { name: "Agent A" });
    const b = await owner("/api/agents", { name: "Agent B" });
    const tokenA = a.body.token as string;
    const tokenB = b.body.token as string;

    // A plans the week; B adds a line of its own with a top-up.
    await call(tokenA, "request_budget", budget);
    await approve(wallet.pendingRequests()[0].id);
    const topup = await call(tokenB, "request_topup", { line: "printer-ink", label: "Printer ink", amount: 30, reason: "Cartridge ran out on Nov 3, last one cost $27" });
    assert.equal(topup.status, 200);
    await approve(wallet.pendingRequests()[0].id);

    const crossed = await call(tokenB, "spend", purchase("groceries", 5));
    assert.equal(crossed.status, 409);
    assert.equal(crossed.body.error, "LINE_NOT_YOURS");
    assert.equal(wallet.state().purchases[0].status, "refused");
    assert.equal((await call(tokenA, "spend", purchase("printer-ink", 5))).body.error, "LINE_NOT_YOURS");

    assert.equal((await call(tokenB, "spend", purchase("printer-ink", 25))).status, 200);
    assert.equal((await call(tokenB, "spend", purchase("buffer", 5))).status, 200);
    assert.equal((await call(tokenA, "spend", purchase("groceries", 40))).status, 200);

    // B can't top up A's line either, and its balance lists only the lines it can use.
    const steal = await call(tokenB, "request_topup", { line: "groceries", amount: 10, reason: "Want more groceries money this week" });
    assert.equal(steal.body.error, "LINE_NOT_YOURS");
    const balance = (await call(tokenB, "get_balance")).body as { lines: { line: string }[] };
    assert.deepEqual(balance.lines.map((l) => l.line).sort(), ["buffer", "printer-ink"]);
  });

  it("leaves lines without an owner usable by any agent", async () => {
    const { requestId } = wallet.requestBudget({
      summary: "Week",
      startsOn: day(0),
      endsOn: day(6),
      lines: [{ key: "groceries", label: "Groceries", amountCents: 8800, reason: "Last 4 weeks averaged $43.70 per order." }],
    });
    await approve(requestId);
    const { body } = await owner("/api/agents", { name: "Agent A" });
    assert.equal((await call(body.token as string, "spend", purchase("groceries", 10))).status, 200);
    assert.equal((await call(SHARED, "spend", purchase("groceries", 10))).status, 200);
    await runWalletTool(wallet, "spend", purchase("groceries", 10), "remit");
    assert.equal(wallet.state().totals.spentCents, 3000);
  });

  it("refuses an unknown agent ID passed straight to the wallet", async () => {
    await approve(wallet.requestBudget({
      summary: "Week",
      startsOn: day(0),
      endsOn: day(6),
      lines: [{ key: "groceries", label: "Groceries", amountCents: 8800, reason: "Last 4 weeks averaged $43.70 per order." }],
    }).requestId);
    await assert.rejects(
      wallet.spend({ lineKey: "groceries", amountCents: 100, title: "X", merchant: "Y", reasoning: "Z", agent: "nobody" }),
      (e: WalletError) => e.code === "UNKNOWN_AGENT",
    );
  });
});
