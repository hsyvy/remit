import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import { openDb, type Db } from "../src/db.ts";
import { PayPalError } from "../src/paypal/gateway.ts";
import { SimulatedPayPal } from "../src/paypal/simulated.ts";
import { createApp, type AppDeps } from "../src/server/app.ts";
import { walletToolDefs } from "../src/wallet/tools.ts";
import { Wallet, WalletError, type ReviewResult } from "../src/wallet/wallet.ts";

const APP = "http://localhost:3000";
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let db: Db;
let paypal: SimulatedPayPal;
let wallet: Wallet;
/** What the fake purpose check says next, and how often it was asked. */
let verdict: ReviewResult;
let reviews: number;

beforeEach(async () => {
  db = openDb(":memory:");
  paypal = new SimulatedPayPal(db, APP);
  verdict = { verdict: "reject", reason: "Headphones don't fit a birthday gift line for a 9-year-old who likes dinosaurs." };
  reviews = 0;
  wallet = new Wallet(db, paypal, {
    appUrl: APP,
    maxRequestCents: 50_000,
    reviewer: { review: async () => (reviews++, verdict) },
  });
  const { requestId } = wallet.requestBudget({
    summary: "Household week",
    startsOn: day(0),
    endsOn: day(6),
    lines: [
      { key: "groceries", label: "Groceries, 2 orders", amountCents: 8800, reason: "Last 4 weeks averaged $43.70 per order." },
      { key: "gift-sam", label: "Birthday gift for Sam", amountCents: 4000, reason: "Your task from Nov 4." },
    ],
    buffer: { amountCents: 1600, reason: "Price changes and shipping." },
  });
  const { orderId } = await wallet.checkout(requestId);
  paypal.approve(orderId);
  await wallet.completeApproval(requestId, orderId);
});

const buy = (lineKey: string, amountCents: number, title = "Headphones") =>
  wallet.spend({ lineKey, amountCents, title, merchant: "shop.example", reasoning: "Sam might like them.", agent: "remit" });

/** A purchase the purpose check refused. Returns its id. */
async function refused(lineKey = "gift-sam", amountCents = 4500) {
  await assert.rejects(buy(lineKey, amountCents), (e: WalletError) => e.code === "REVIEW_REJECTED");
  return wallet.state().purchases[0].id;
}

const purchase = (id: string) => wallet.state().purchases.find((p) => p.id === id)!;

describe("owner override of the purpose check", () => {
  it("pays a refused purchase through the normal capture path and keeps the review", async () => {
    const id = await refused();
    assert.equal(reviews, 1);
    const before = wallet.state().purchases[0];
    assert.equal(before.override, null);

    const result = await wallet.overridePurchase(id);
    assert.equal(reviews, 1, "the purpose check is not asked again");
    assert.equal(result.amountCents, 4500);
    assert.equal(result.fromLineCents, 4000);
    assert.equal(result.fromBufferCents, 500);
    assert.equal(result.lineLeftCents, 0);
    assert.equal(result.totalLeftCents, 14400 - 4500);
    assert.equal(result.captureIds.length, 1);

    const p = purchase(id);
    assert.equal(p.status, "captured");
    assert.equal(p.override?.by, "owner");
    assert.ok(p.override?.at);
    assert.deepEqual(p.review, before.review, "the original review is kept as it was");
    assert.equal(p.refusal, before.refusal);

    const state = wallet.state();
    assert.equal(state.holds[0].capturedCents, 4500);
    assert.equal(state.totals.spentCents, 4500);
    assert.equal(state.lines.find((l) => l.key === "buffer")!.leftCents, 1100);
    assert.equal(state.events[0].type, "overridden");
    assert.match(state.events[0].message, /You paid \$45\.00 for "Headphones" anyway, over the purpose check's refusal/);

    // It is an ordinary captured purchase from here on: refundable to the owner.
    await wallet.refund(id);
    assert.equal(purchase(id).status, "refunded");
  });

  it("allows it once", async () => {
    const id = await refused("gift-sam", 1000);
    const results = await Promise.allSettled([wallet.overridePurchase(id), wallet.overridePurchase(id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((failed.reason as WalletError).code, "ALREADY_OVERRIDDEN");
    await assert.rejects(wallet.overridePurchase(id), (e: WalletError) => e.code === "ALREADY_OVERRIDDEN");
    assert.equal(wallet.state().totals.spentCents, 1000);
  });

  it("fails with the normal refusal when the line no longer allows it", async () => {
    const id = await refused("gift-sam", 4500);
    // The owner moves the gift money away. Line 0 + buffer 1600 can't cover $45.
    await wallet.moveBetweenLines("gift-sam", "groceries", 4000);
    verdict = { verdict: "approve", reason: "Fine." };
    const normal = await buy("gift-sam", 4500).catch((e: WalletError) => e);
    assert.ok(normal instanceof WalletError && normal.code === "OVER_LINE");

    await assert.rejects(wallet.overridePurchase(id), (e: WalletError) => e.code === "OVER_LINE" && e.message === normal.message);
    assert.equal(purchase(id).status, "refused");
    assert.equal(purchase(id).override, null);
    assert.equal(wallet.state().events[0].type, "override_refused");
    assert.equal(wallet.state().totals.spentCents, 0);

    // A refused override doesn't use up the one try: after moving money back, it goes through.
    await wallet.moveBetweenLines("groceries", "gift-sam", 4000);
    assert.equal((await wallet.overridePurchase(id)).amountCents, 4500);
  });

  it("re-runs the total rule too", async () => {
    const id = await refused("groceries", 2000);
    // The line still has room, but PayPal no longer holds the money (the backstop case).
    db.prepare("UPDATE holds SET status = 'lapsing'").run();
    await assert.rejects(wallet.overridePurchase(id), (e: WalletError) => e.code === "OVER_BALANCE" && /Only \$0\.00 is still held/.test(e.message));
    assert.equal(purchase(id).status, "refused");
  });

  it("only applies to purchases the purpose check refused", async () => {
    // Refused by the line rule, before the purpose check ran.
    await assert.rejects(buy("gift-sam", 9500), (e: WalletError) => e.code === "OVER_LINE");
    const overLine = wallet.state().purchases[0].id;
    await assert.rejects(wallet.overridePurchase(overLine), (e: WalletError) => e.code === "NOT_OVERRIDABLE");

    verdict = { verdict: "approve", reason: "Fine." };
    const { purchaseId } = await buy("groceries", 1000, "Weekly order");
    await assert.rejects(wallet.overridePurchase(purchaseId), (e: WalletError) => e.code === "NOT_OVERRIDABLE");

    await assert.rejects(wallet.overridePurchase("pur_nope"), (e: WalletError) => e.code === "NOT_FOUND" && e.status === 404);
  });

  it("doesn't work after the period is closed", async () => {
    const id = await refused();
    await wallet.closePeriod();
    await assert.rejects(wallet.overridePurchase(id), (e: WalletError) => e.code === "NO_BUDGET");
    assert.equal(purchase(id).status, "refused");
  });

  it("records a failed capture and doesn't retry it", async () => {
    const id = await refused();
    const capture = paypal.capture.bind(paypal);
    paypal.capture = async () => {
      throw new PayPalError("Authorization voided", 422, "AUTHORIZATION_VOIDED");
    };
    await assert.rejects(wallet.overridePurchase(id), (e: WalletError) => e.code === "CAPTURE_FAILED");
    const p = purchase(id);
    assert.equal(p.status, "failed");
    assert.match(p.override?.error ?? "", /PayPal capture failed/);
    paypal.capture = capture;
    await assert.rejects(wallet.overridePurchase(id), (e: WalletError) => e.code === "ALREADY_OVERRIDDEN");
    assert.equal(wallet.state().totals.spentCents, 0);
  });

  it("adds the column to a database made before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "remit-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE purchases (id TEXT PRIMARY KEY, period_id TEXT NOT NULL, line_key TEXT NOT NULL, status TEXT NOT NULL, review TEXT)");
    old.close();
    const migrated = openDb(path);
    const columns = (migrated.prepare("PRAGMA table_info(purchases)").all() as { name: string }[]).map((c) => c.name);
    migrated.close();
    rmSync(dir, { recursive: true });
    assert.ok(columns.includes("owner_override"));
  });
});

describe("override route", () => {
  const modes = { paypal: "simulated", search: "demo", agent: "off", reviewer: "on", model: "test" };
  const app = () => createApp({ wallet, modes, agentToken: "agent-token", ownerPassword: "secret" } as unknown as AppDeps);
  const owner = { Authorization: `Basic ${Buffer.from("owner:secret").toString("base64")}` };

  it("is an owner route", async () => {
    const id = await refused();
    const res = await app().request(`/api/purchases/${id}/override`, { method: "POST", headers: owner });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { amountCents: number }).amountCents, 4500);
    assert.equal(purchase(id).status, "captured");

    const again = await app().request(`/api/purchases/${id}/override`, { method: "POST", headers: owner });
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "ALREADY_OVERRIDDEN");
  });

  it("is not reachable by an agent", async () => {
    const id = await refused();
    assert.ok(!Object.keys(walletToolDefs).some((name) => /override|anyway/i.test(name)));
    const agent = { Authorization: "Bearer agent-token" };
    assert.equal((await app().request(`/api/purchases/${id}/override`, { method: "POST", headers: agent })).status, 401);
    for (const name of ["override", "override_purchase", "pay_anyway"]) {
      assert.equal((await app().request(`/agent/v1/tools/${name}`, { method: "POST", headers: agent, body: JSON.stringify({ purchase_id: id }) })).status, 404);
    }
    assert.equal(purchase(id).status, "refused");
  });
});
