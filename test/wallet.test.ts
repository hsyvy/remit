import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import { openDb, type Db } from "../src/db.ts";
import { PayPalError } from "../src/paypal/gateway.ts";
import { SimulatedPayPal } from "../src/paypal/simulated.ts";
import { runWalletTool, walletToolDefs } from "../src/wallet/tools.ts";
import { Wallet, WalletError, type Reviewer } from "../src/wallet/wallet.ts";

const APP = "http://localhost:3000";
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let db: Db;
let paypal: SimulatedPayPal;
let clock: Date;
let reviewer: Reviewer | undefined;
let wallet: Wallet;

function makeWallet() {
  wallet = new Wallet(db, paypal, { appUrl: APP, maxRequestCents: 50_000, reviewer, now: () => clock });
}

beforeEach(() => {
  db = openDb(":memory:");
  paypal = new SimulatedPayPal(db, APP);
  clock = new Date();
  reviewer = undefined;
  makeWallet();
});

/** The brief's example week: groceries, dog food, a gift for Sam and a 10% buffer = $176.50. */
function requestWeek() {
  return wallet.requestBudget({
    summary: "Household week",
    startsOn: day(0),
    endsOn: day(6),
    lines: [
      { key: "groceries", label: "Groceries, 2 orders", amountCents: 8800, reason: "Last 4 weeks averaged $43.70 per order." },
      { key: "dog-food", label: "Dog food, 12 kg bag", amountCents: 3250, reason: "Last bought Oct 15, lasts about 4 weeks." },
      { key: "gift-sam", label: "Birthday gift for Sam", amountCents: 4000, reason: "Your task from Nov 4." },
    ],
    buffer: { amountCents: 1600, reason: "Price changes and shipping." },
  });
}

async function approve(requestId: string, edits?: { lineId: string; amountCents: number }[]) {
  const { orderId } = await wallet.checkout(requestId, edits);
  paypal.approve(orderId);
  await wallet.completeApproval(requestId, orderId);
}

const buy = (lineKey: string, amountCents: number, title = "Thing") =>
  wallet.spend({ lineKey, amountCents, title, merchant: "shop.example", reasoning: "Needed", agent: "remit" });

describe("budget requests", () => {
  it("opens the wallet only after the owner approves on PayPal", async () => {
    const { requestId, totalCents } = requestWeek();
    assert.equal(totalCents, 17650);
    await assert.rejects(buy("groceries", 1000), (e: WalletError) => e.code === "NO_BUDGET");

    const { orderId } = await wallet.checkout(requestId);
    // Hitting the return URL without approving on PayPal must not open the wallet.
    await assert.rejects(wallet.completeApproval(requestId, orderId), (e: PayPalError) => e.issue === "ORDER_NOT_APPROVED");
    assert.equal(wallet.balance().period?.status, "pending");

    paypal.approve(orderId);
    await wallet.completeApproval(requestId, orderId);
    const b = wallet.balance();
    assert.equal(b.period?.status, "open");
    assert.equal(b.approvedCents, 17650);
    assert.equal(b.leftCents, 17650);

    // A second visit to the return URL is harmless.
    assert.deepEqual(await wallet.completeApproval(requestId, orderId), { alreadyApproved: true });
    assert.equal(wallet.balance().leftCents, 17650);
  });

  it("lets the owner remove and resize lines before approving", async () => {
    const { requestId } = requestWeek();
    const lines = wallet.pendingRequests()[0].lines;
    const gift = lines.find((l) => l.key === "gift-sam")!;
    const groceries = lines.find((l) => l.key === "groceries")!;
    await approve(requestId, [
      { lineId: gift.id, amountCents: 0 },
      { lineId: groceries.id, amountCents: 6000 },
    ]);
    const b = wallet.balance();
    assert.equal(b.approvedCents, 6000 + 3250 + 1600);
    assert.deepEqual(b.lines.map((l) => l.key), ["groceries", "dog-food", "buffer"]);
    await assert.rejects(buy("gift-sam", 100), (e: WalletError) => e.code === "NO_SUCH_LINE");
  });

  it("refuses a second budget while one is open, and dates beyond one hold", async () => {
    await approve(requestWeek().requestId);
    assert.throws(() => requestWeek(), (e: WalletError) => e.code === "PERIOD_OPEN");
    db = openDb(":memory:");
    paypal = new SimulatedPayPal(db, APP);
    makeWallet();
    assert.throws(
      () => wallet.requestBudget({ summary: "Long", startsOn: day(0), endsOn: day(40), lines: [{ key: "x", label: "X", amountCents: 100, reason: "Owner asked for it on Nov 4." }] }),
      (e: WalletError) => e.code === "BAD_DATES",
    );
  });

  it("rejects budget lines without a reason the owner can check", () => {
    const ask = (reason: string, buffer?: string) =>
      wallet.requestBudget({
        summary: "Week",
        startsOn: day(0),
        endsOn: day(6),
        lines: [{ key: "groceries", label: "Groceries", amountCents: 8800, reason }],
        buffer: buffer === undefined ? undefined : { amountCents: 880, reason: buffer },
      });
    for (const reason of ["", "   ", "needed", "weekly food", "groceries again"]) {
      assert.throws(
        () => ask(reason),
        (e: WalletError) => e.code === "WEAK_REASON" && e.message.includes('"groceries"') && /Last 4 weeks averaged/.test(e.message),
        `reason ${JSON.stringify(reason)}`,
      );
    }
    assert.throws(() => ask("Last 4 weeks averaged $43.70 per order.", "Shipping"), (e: WalletError) => e.code === "WEAK_REASON" && e.message.includes('"buffer"'));
    assert.equal(wallet.pendingRequests().length, 0);
    assert.equal(ask("Last 4 weeks averaged $43.70 per order.", "Price changes and shipping.").totalCents, 9680);
  });

  it("caps request size", () => {
    assert.throws(
      () => wallet.requestBudget({ summary: "Big", startsOn: day(0), endsOn: day(6), lines: [{ key: "tv", label: "TV", amountCents: 90_000, reason: "Owner asked for a new TV." }] }),
      (e: WalletError) => e.code === "TOO_LARGE",
    );
  });
});

describe("approvals that don't go through", () => {
  const card = (requestId: string) => wallet.pendingRequests().find((r) => r.id === requestId)!;

  it("tells the owner when PayPal refused the card, and lets them try again", async () => {
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    assert.equal(card(requestId).approval, null);

    // PayPal declines on its own page and the order keeps waiting, as the real sandbox does.
    paypal.decline(orderId);
    const [result] = await wallet.checkApprovals({ requestId, force: true });
    assert.equal(result.outcome, "not_approved");
    assert.equal(card(requestId).status, "checkout");
    assert.equal(card(requestId).approval?.state, "not_approved");
    assert.equal(card(requestId).approval?.paypalStatus, "PAYER_ACTION_REQUIRED");
    assert.equal(wallet.balance().period?.status, "pending");
    assert.match(wallet.state().events[0].message, /PayPal didn't approve the \$176\.50 budget request/);

    // Approve again: a new order, and the old message goes away.
    const retry = await wallet.checkout(requestId);
    assert.notEqual(retry.orderId, orderId);
    assert.equal(card(requestId).approval, null);
    paypal.approve(retry.orderId);
    await wallet.completeApproval(requestId, retry.orderId);
    assert.equal(wallet.balance().period?.status, "open");
  });

  it("notices an abandoned PayPal page, and logs it once", async () => {
    const { requestId } = requestWeek();
    await wallet.checkout(requestId);
    await wallet.checkApprovals();
    clock = new Date(clock.getTime() + 60_000);
    await wallet.checkApprovals();
    assert.equal(card(requestId).approval?.state, "not_approved");
    assert.equal(wallet.state().events.filter((e) => /didn't approve/.test(e.message)).length, 1);
  });

  it("finishes an approval whose redirect back got lost", async () => {
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    const [result] = await wallet.checkApprovals();
    assert.equal(result.outcome, "approved");
    assert.equal(wallet.balance().period?.status, "open");
    assert.equal(wallet.balance().leftCents, 17650);
    // The return URL arriving late is still harmless.
    assert.deepEqual(await wallet.completeApproval(requestId, orderId), { alreadyApproved: true });
  });

  it("says so when PayPal voided the order", async () => {
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.voidOrder(orderId);
    await wallet.checkApprovals();
    assert.equal(card(requestId).approval?.state, "voided");
    assert.equal(card(requestId).status, "checkout");
  });

  it("asks PayPal at most once per 15 seconds unless forced", async () => {
    const { requestId } = requestWeek();
    await wallet.checkout(requestId);
    let calls = 0;
    const getOrderStatus = paypal.getOrderStatus.bind(paypal);
    paypal.getOrderStatus = (id) => (calls++, getOrderStatus(id));

    await wallet.checkApprovals();
    const [skipped] = await wallet.checkApprovals();
    assert.equal(calls, 1);
    assert.equal(skipped.outcome, "skipped");
    assert.equal(skipped.check?.state, "not_approved");
    await wallet.checkApprovals({ force: true });
    assert.equal(calls, 2);
    clock = new Date(clock.getTime() + 16_000);
    await wallet.checkApprovals();
    assert.equal(calls, 3);
  });

  it("leaves the request alone when PayPal can't be reached", async () => {
    const { requestId } = requestWeek();
    await wallet.checkout(requestId);
    paypal.getOrderStatus = async () => {
      throw new PayPalError("Service unavailable", 503);
    };
    const [result] = await wallet.checkApprovals();
    assert.equal(result.outcome, "unknown");
    assert.equal(card(requestId).approval, null);
    assert.equal(card(requestId).status, "checkout");
  });

  it("ignores requests that aren't in checkout", async () => {
    requestWeek();
    assert.deepEqual(await wallet.checkApprovals(), []);
  });

  it("adds the new column to a database made before it existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "remit-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE requests (id TEXT PRIMARY KEY, period_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, paypal_order_id TEXT, created_at TEXT NOT NULL, decided_at TEXT)");
    old.close();
    const migrated = openDb(path);
    const columns = (migrated.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name);
    migrated.close();
    rmSync(dir, { recursive: true });
    assert.ok(columns.includes("approval_check"));
  });

  it("adds the funding columns and tables to a database made before them", () => {
    const dir = mkdtempSync(join(tmpdir(), "remit-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE captures (id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, hold_id TEXT NOT NULL, capture_id TEXT NOT NULL, amount_cents INTEGER NOT NULL, final INTEGER NOT NULL, refund_id TEXT, created_at TEXT NOT NULL)");
    old.exec("INSERT INTO captures VALUES ('cap_1', 'pur_1', 'hold_1', 'C1', 500, 0, NULL, '2026-11-01T00:00:00Z')");
    old.close();
    const migrated = openDb(path);
    const columns = (migrated.prepare("PRAGMA table_info(captures)").all() as { name: string }[]).map((c) => c.name);
    const tables = (migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    const row = migrated.prepare("SELECT from_line_cents, from_buffer_cents FROM captures").get() as { from_line_cents: number | null; from_buffer_cents: number | null };
    migrated.close();
    rmSync(dir, { recursive: true });
    assert.ok(columns.includes("from_line_cents") && columns.includes("from_buffer_cents"));
    assert.ok(tables.includes("line_funding") && tables.includes("line_moves"));
    // Old captures stay unattributed.
    assert.deepEqual({ ...row }, { from_line_cents: null, from_buffer_cents: null });
  });
});

describe("spending", () => {
  beforeEach(async () => {
    await approve(requestWeek().requestId);
  });

  it("captures from the hold and drops the line", async () => {
    const result = await buy("dog-food", 3249, "Dog food 12 kg");
    assert.equal(result.lineLeftCents, 1);
    assert.equal(result.totalLeftCents, 17650 - 3249);
    const state = wallet.state();
    assert.equal(state.holds[0].capturedCents, 3249);
    assert.equal(state.totals.spentCents, 3249);
  });

  it("draws on the buffer when a line runs a little over", async () => {
    const result = await buy("gift-sam", 4500);
    assert.equal(result.fromLineCents, 4000);
    assert.equal(result.fromBufferCents, 500);
    const lines = wallet.balance().lines;
    assert.equal(lines.find((l) => l.key === "buffer")!.leftCents, 1100);
  });

  it("refuses the $95 gift and records the refusal", async () => {
    await assert.rejects(buy("gift-sam", 9500, "Headphones"), (e: WalletError) => e.code === "OVER_LINE" && /request_topup/.test(e.message));
    const state = wallet.state();
    assert.equal(state.purchases[0].status, "refused");
    assert.equal(state.totals.spentCents, 0);
    assert.equal(state.holds[0].capturedCents, 0);
  });

  it("never lets one line borrow from another", async () => {
    await buy("groceries", 8800);
    await buy("groceries", 1600); // all of the buffer
    await assert.rejects(buy("groceries", 1), (e: WalletError) => e.code === "OVER_LINE");
    assert.equal(wallet.balance().leftCents, 3250 + 4000);
  });

  it("rejects a top-up without a real reason", async () => {
    for (const reason of ["", "more", "more money"]) {
      assert.throws(() => wallet.requestTopup({ lineKey: "gift-sam", amountCents: 4000, reason }), (e: WalletError) => e.code === "WEAK_REASON", reason);
    }
    assert.equal(wallet.pendingRequests().length, 0);
  });

  it("top-ups are a new approval and a new hold, spent from the holds that fund the line", async () => {
    await assert.rejects(buy("gift-sam", 9500), WalletError);
    const topup = wallet.requestTopup({ lineKey: "gift-sam", amountCents: 4000, reason: "Sam asked for headphones" });
    assert.throws(() => wallet.requestTopup({ lineKey: "gift-sam", amountCents: 100, reason: "again" }), (e: WalletError) => e.code === "REQUEST_PENDING");
    await approve(topup.requestId);

    await buy("groceries", 8800);
    await buy("dog-food", 3250);
    // The gift line is 4000 from the budget hold and 4000 from the top-up; the buffer's 1500 is the budget hold's.
    const result = await buy("gift-sam", 9500, "Headphones");
    assert.equal(result.captureIds.length, 2);
    const holds = wallet.state().holds;
    assert.equal(holds[0].capturedCents, 12050 + 4000 + 1500);
    assert.equal(holds[0].status, "active");
    assert.equal(holds[1].capturedCents, 4000);
    assert.equal(holds[1].status, "captured");
  });

  it("asks the reviewer and refuses when it says no", async () => {
    reviewer = { review: async () => ({ verdict: "reject", reason: "Headphones are not groceries." }) };
    makeWallet();
    await assert.rejects(buy("groceries", 2000, "Headphones"), (e: WalletError) => e.code === "REVIEW_REJECTED");
    assert.equal(wallet.state().purchases[0].status, "refused");
    assert.equal(wallet.balance().leftCents, 17650);

    reviewer = { review: async () => { throw new Error("timeout"); } };
    makeWallet();
    await assert.rejects(buy("groceries", 2000), (e: WalletError) => e.code === "REVIEW_REJECTED" && /unavailable/.test(e.message));
  });

  it("reauthorizes after PayPal's 3-day honor period", async () => {
    await buy("groceries", 4000);
    clock = new Date(Date.now() + 4 * 24 * 3600 * 1000);
    // Period still open: it ends on day 6.
    await buy("groceries", 1000);
    const hold = wallet.state().holds[0];
    assert.equal(hold.capturedCents, 5000);
    assert.equal(hold.amountCents, 17650);
    assert.ok(wallet.state().events.some((e) => e.type === "reauthorized"));
  });

  it("refunds to the owner without giving the agent the money back", async () => {
    const { purchaseId } = await buy("dog-food", 3000);
    await wallet.refund(purchaseId);
    const state = wallet.state();
    assert.equal(state.purchases[0].status, "refunded");
    assert.equal(state.lines.find((l) => l.key === "dog-food")!.leftCents, 250);
  });

  it("serializes concurrent spends so the line can't be overspent", async () => {
    const results = await Promise.allSettled([buy("dog-food", 3000), buy("dog-food", 3000)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });
});

describe("moving money between lines", () => {
  beforeEach(async () => {
    await approve(requestWeek().requestId);
  });
  const line = (key: string) => wallet.balance().lines.find((l) => l.key === key)!;

  it("moves unspent money and records it in the activity feed", async () => {
    const result = await wallet.moveBetweenLines("groceries", "gift-sam", 1000);
    assert.equal(result.from.limitCents, 7800);
    assert.equal(result.to.limitCents, 5000);
    assert.equal(line("gift-sam").leftCents, 5000);
    const event = wallet.state().events[0];
    assert.equal(event.type, "moved");
    assert.equal(event.message, "You moved $10.00 from Groceries, 2 orders to Birthday gift for Sam.");
  });

  it("keeps the total and the holds the same, with no PayPal call", async () => {
    const before = wallet.state();
    const ordersBefore = db.prepare("SELECT COUNT(*) AS n FROM sim_paypal").get() as { n: number };
    await wallet.moveBetweenLines("dog-food", "buffer", 250);
    await wallet.moveBetweenLines("buffer", "groceries", 1850);
    const after = wallet.state();
    assert.equal(after.totals.approvedCents, before.totals.approvedCents);
    assert.equal(after.totals.heldCents, before.totals.heldCents);
    // Funding moves with the limit; the PayPal holds themselves don't change.
    const paypalSide = (holds: typeof before.holds) => holds.map(({ funding: _, ...h }) => h);
    assert.deepEqual(paypalSide(after.holds), paypalSide(before.holds));
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM sim_paypal").get(), ordersBefore);
    assert.equal(line("buffer").leftCents, 0);
    assert.equal(line("groceries").limitCents, 10650);
  });

  it("refuses to move more than is unspent on the source line", async () => {
    await buy("dog-food", 3000);
    await assert.rejects(wallet.moveBetweenLines("dog-food", "gift-sam", 251), (e: WalletError) => e.code === "OVER_UNSPENT");
    await assert.rejects(wallet.moveBetweenLines("dog-food", "dog-food", 100), (e: WalletError) => e.code === "SAME_LINE");
    await assert.rejects(wallet.moveBetweenLines("dog-food", "nope", 100), (e: WalletError) => e.code === "NO_SUCH_LINE");
    await assert.rejects(wallet.moveBetweenLines("dog-food", "gift-sam", 0), (e: WalletError) => e.code === "BAD_AMOUNT");
    // The buffer's unspent counts what other lines drew from it.
    await buy("gift-sam", 5000);
    await assert.rejects(wallet.moveBetweenLines("buffer", "groceries", 601), (e: WalletError) => e.code === "OVER_UNSPENT");
    assert.equal(line("dog-food").limitCents, 3250);
    assert.equal(line("buffer").limitCents, 1600);
  });

  it("lets a refused purchase go through after the owner moves money", async () => {
    await assert.rejects(buy("gift-sam", 9500, "Headphones"), (e: WalletError) => e.code === "OVER_LINE" && /move unspent money/.test(e.message));
    // Line 4000 + buffer 1600 leaves the headphones 3900 short.
    await wallet.moveBetweenLines("groceries", "gift-sam", 3900);
    const result = await buy("gift-sam", 9500, "Headphones");
    assert.equal(result.fromLineCents, 7900);
    assert.equal(result.fromBufferCents, 1600);
    assert.equal(wallet.state().holds.length, 1);
    assert.equal(wallet.balance().leftCents, 17650 - 9500);
  });

  it("creates the buffer when moving into a plan that had none", async () => {
    await wallet.closePeriod();
    const { requestId } = wallet.requestBudget({
      summary: "No buffer",
      startsOn: day(0),
      endsOn: day(6),
      lines: [{ key: "groceries", label: "Groceries", amountCents: 5000, reason: "Last 4 weeks averaged $50 per order." }, { key: "dog-food", label: "Dog food", amountCents: 3000, reason: "Last bag bought Oct 16, lasts about 4 weeks." }],
    });
    await approve(requestId);
    await wallet.moveBetweenLines("groceries", "buffer", 500);
    assert.equal(line("buffer").leftCents, 500);
    const result = await buy("dog-food", 3400);
    assert.equal(result.fromBufferCents, 400);
  });

  it("is not something an agent can call", () => {
    assert.ok(!Object.keys(walletToolDefs).some((name) => /move/i.test(name)));
  });
});

describe("which hold pays", () => {
  beforeEach(async () => {
    await approve(requestWeek().requestId);
  });
  const hold = (i: number) => wallet.state().holds[i];
  const funding = (i: number) => Object.fromEntries(hold(i).funding.map((f) => [f.lineKey, f.fundedCents]));
  const capturesOf = (purchaseId: string) =>
    db.prepare("SELECT hold_id, amount_cents, from_line_cents, from_buffer_cents FROM captures WHERE purchase_id = ? ORDER BY rowid").all(purchaseId) as {
      hold_id: string;
      amount_cents: number;
      from_line_cents: number | null;
      from_buffer_cents: number | null;
    }[];
  async function topup(lineKey: string, amountCents: number, label?: string) {
    await approve(wallet.requestTopup({ lineKey, label, amountCents, reason: "Sam asked for over-ear headphones." }).requestId);
  }

  it("records what each hold funds", async () => {
    await topup("headphones", 3000, "Headphones for Sam");
    assert.deepEqual(funding(0), { groceries: 8800, "dog-food": 3250, "gift-sam": 4000, buffer: 1600 });
    assert.deepEqual(funding(1), { headphones: 3000 });
  });

  it("pays a top-up's purchase from the top-up hold", async () => {
    await topup("headphones", 3000, "Headphones for Sam");
    const { purchaseId } = await buy("headphones", 2500, "Headphones");
    assert.equal(hold(0).capturedCents, 0);
    assert.equal(hold(1).capturedCents, 2500);
    assert.deepEqual(capturesOf(purchaseId).map((c) => [c.hold_id, c.amount_cents, c.from_line_cents, c.from_buffer_cents]), [[hold(1).id, 2500, 2500, 0]]);

    // Close-out: the untouched budget hold is voided, the partly captured top-up lapses.
    const closed = await wallet.closePeriod();
    assert.equal(closed.releasedCents, 17650);
    assert.equal(closed.lapsingCents, 500);
    assert.deepEqual(wallet.state().holds.map((h) => h.status), ["voided", "lapsing"]);
  });

  it("pays the line part and the buffer part from the holds that fund each", async () => {
    await topup("headphones", 3000, "Headphones for Sam");
    await topup("buffer", 2000);
    // Use up the budget hold's share of the buffer, so the rest of the buffer is the third hold's.
    await buy("groceries", 8800 + 1600);
    assert.equal(hold(0).capturedCents, 10400);

    const result = await buy("headphones", 4000, "Headphones");
    assert.equal(result.fromLineCents, 3000);
    assert.equal(result.fromBufferCents, 1000);
    const [h0, h1, h2] = wallet.state().holds;
    assert.equal(h0.capturedCents, 10400);
    assert.equal(h1.capturedCents, 3000);
    assert.equal(h1.status, "captured");
    assert.equal(h2.capturedCents, 1000);
    assert.deepEqual(
      capturesOf(result.purchaseId).map((c) => [c.hold_id, c.amount_cents, c.from_line_cents, c.from_buffer_cents]),
      [[h1.id, 3000, 3000, 0], [h2.id, 1000, 0, 1000]],
    );
  });

  it("takes one capture per hold when it pays both the line and the buffer", async () => {
    const result = await buy("gift-sam", 4500);
    assert.deepEqual(capturesOf(result.purchaseId).map((c) => [c.amount_cents, c.from_line_cents, c.from_buffer_cents]), [[4500, 4000, 500]]);
  });

  it("moves funding along with the limit", async () => {
    await topup("headphones", 3000, "Headphones for Sam");
    await wallet.moveBetweenLines("headphones", "groceries", 1000);
    assert.deepEqual(funding(1), { headphones: 2000, groceries: 1000 });
    assert.equal(funding(0).groceries, 8800);

    // Groceries is now 8800 on the budget hold and 1000 on the top-up hold.
    await buy("groceries", 9800);
    assert.equal(hold(0).capturedCents, 8800);
    assert.equal(hold(1).capturedCents, 1000);

    // Only unspent funding moves: dog food is all budget hold, so the gift gets budget-hold money.
    await wallet.moveBetweenLines("dog-food", "gift-sam", 250);
    assert.deepEqual(funding(0)["gift-sam"], 4250);
    assert.deepEqual(funding(0)["dog-food"], 3000);
    // Totals per hold never change.
    const sum = (i: number) => hold(i).funding.reduce((s, f) => s + f.fundedCents, 0);
    assert.equal(sum(0), 17650);
    assert.equal(sum(1), 3000);
  });

  it("moves the unspent part of a line funded by two holds", async () => {
    await topup("groceries", 1000);
    await buy("groceries", 8000); // all from the budget hold, which funds 8800 of the line
    await wallet.moveBetweenLines("groceries", "dog-food", 1500);
    assert.deepEqual(funding(0).groceries, 8000);
    assert.deepEqual(funding(1).groceries, 300);
    assert.deepEqual(funding(0)["dog-food"], 3250 + 800);
    assert.deepEqual(funding(1)["dog-food"], 700);
  });

  it("falls back to the budget hold, then any hold, for rows from before funding was tracked", async () => {
    await topup("headphones", 3000, "Headphones for Sam");
    // An older database: no funding rows and no line split on captures.
    db.exec("DELETE FROM line_funding");
    // Everything unattributed is the budget hold's, the top-up's line included.
    assert.deepEqual(funding(0), { groceries: 8800, "dog-food": 3250, "gift-sam": 4000, buffer: 1600, headphones: 3000 });
    assert.deepEqual(funding(1), {});

    await buy("headphones", 3000);
    assert.equal(hold(0).capturedCents, 3000);
    db.exec("UPDATE captures SET from_line_cents = NULL, from_buffer_cents = NULL");

    await buy("groceries", 8800);
    await buy("dog-food", 3250);
    // The budget hold has 2600 left but funds 4000 of the gift: the rest comes from the top-up hold.
    const result = await buy("gift-sam", 4000);
    assert.equal(result.captureIds.length, 2);
    assert.equal(hold(0).capturedCents, 17650);
    assert.equal(hold(0).status, "captured");
    assert.equal(hold(1).capturedCents, 1400);
    assert.equal(wallet.balance().leftCents, 1600);

    // A move on old rows writes the budget hold's share down first, then moves it.
    await wallet.moveBetweenLines("buffer", "groceries", 600);
    assert.equal(funding(0).buffer, 1000);
    assert.equal(funding(0).groceries, 9400);

    const closed = await wallet.closePeriod();
    assert.equal(closed.lapsingCents, 1600);
    assert.deepEqual(wallet.state().holds.map((h) => h.status), ["captured", "lapsing"]);
  });

  it("undoes earlier captures when a later one fails", async () => {
    await topup("gift-sam", 4000);
    const capture = paypal.capture.bind(paypal);
    let calls = 0;
    paypal.capture = async (id, opts) => {
      if (++calls === 2) throw new PayPalError("Declined", 422, "INSTRUMENT_DECLINED");
      return capture(id, opts);
    };
    await assert.rejects(buy("gift-sam", 6000), (e: WalletError) => e.code === "CAPTURE_FAILED");
    const undone = db.prepare("SELECT refund_id FROM captures").all() as { refund_id: string }[];
    assert.deepEqual(undone.map((c) => c.refund_id), ["undo"]);
    assert.equal(wallet.state().purchases[0].status, "failed");
    assert.equal(wallet.balance().lines.find((l) => l.key === "gift-sam")!.leftCents, 8000);
  });
});

describe("line moves", () => {
  beforeEach(async () => {
    await approve(requestWeek().requestId);
  });

  it("writes each move as its own record and returns it in the state", async () => {
    await wallet.moveBetweenLines("groceries", "gift-sam", 1000);
    await assert.rejects(wallet.moveBetweenLines("dog-food", "gift-sam", 9999), (e: WalletError) => e.code === "OVER_UNSPENT");
    await wallet.moveBetweenLines("dog-food", "buffer", 250);

    const rows = db.prepare("SELECT * FROM line_moves ORDER BY rowid").all() as { period_id: string; from_line_key: string; to_line_key: string; cents: number; who: string }[];
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.from_line_key, r.to_line_key, r.cents, r.who]),
      [["groceries", "gift-sam", 1000, "owner"], ["dog-food", "buffer", 250, "owner"]],
    );
    const state = wallet.state();
    assert.equal(rows[0].period_id, state.period!.id);
    assert.deepEqual(
      state.moves.map((m) => [m.fromKey, m.fromLabel, m.toKey, m.toLabel, m.cents, m.who]),
      [
        ["dog-food", "Dog food, 12 kg bag", "buffer", "Buffer", 250, "owner"],
        ["groceries", "Groceries, 2 orders", "gift-sam", "Birthday gift for Sam", 1000, "owner"],
      ],
    );
    assert.ok(state.moves.every((m) => typeof m.id === "string" && !Number.isNaN(Date.parse(m.createdAt))));
    // The activity feed still gets its moved events.
    assert.equal(state.events.filter((e) => e.type === "moved").length, 2);
  });

  it("only shows the current period's moves", async () => {
    await wallet.moveBetweenLines("groceries", "gift-sam", 1000);
    await wallet.closePeriod();
    assert.equal(wallet.state().moves.length, 1);
    await approve(requestWeek().requestId);
    assert.deepEqual(wallet.state().moves, []);
  });
});

describe("close-out", () => {
  it("voids an untouched hold", async () => {
    await approve(requestWeek().requestId);
    const result = await wallet.closePeriod();
    assert.equal(result.releasedCents, 17650);
    assert.equal(wallet.state().holds[0].status, "voided");
    await assert.rejects(buy("groceries", 100), (e: WalletError) => e.code === "NO_BUDGET");
  });

  it("reports when PayPal keeps a partly captured hold until it expires", async () => {
    await approve(requestWeek().requestId);
    await buy("groceries", 5000);
    const result = await wallet.closePeriod();
    assert.equal(result.lapsingCents, 12650);
    assert.match(result.notes[0], /PREVIOUSLY_CAPTURED/);
  });

  it("closes automatically after the end date", async () => {
    await approve(requestWeek().requestId);
    clock = new Date(Date.now() + 8 * 24 * 3600 * 1000);
    await wallet.closeIfEnded();
    assert.equal(wallet.balance().period, null);
  });
});

describe("simulated PayPal", () => {
  it("refuses to capture more than the hold", async () => {
    const { orderId } = await paypal.createAuthorizeOrder({ referenceId: "r", description: "d", items: [{ name: "a", description: "b", cents: 1000 }], returnUrl: APP, cancelUrl: APP });
    paypal.approve(orderId);
    const auth = await paypal.authorizeOrder(orderId);
    await paypal.capture(auth.authorizationId, { cents: 600, finalCapture: false, note: "", idempotencyKey: "a" });
    await assert.rejects(
      paypal.capture(auth.authorizationId, { cents: 500, finalCapture: false, note: "", idempotencyKey: "b" }),
      (e: PayPalError) => e.issue === "MAX_CAPTURE_AMOUNT_EXCEEDED",
    );
  });
});

describe("tool layer", () => {
  it("get_history returns closed periods with lines and dated purchases", async () => {
    assert.deepEqual(((await runWalletTool(wallet, "get_history", {}, "mcp")) as { periods: unknown[] }).periods, []);
    await approve(requestWeek().requestId);
    await buy("dog-food", 3249, "Dog food 12 kg");
    await buy("groceries", 4185, "Weekly order");
    await wallet.closePeriod();

    const history = (await runWalletTool(wallet, "get_history", {}, "mcp")) as {
      periods: { period: string; approved: string; spent: string; lines: Record<string, string>[]; purchases: Record<string, string>[] }[];
    };
    assert.equal(history.periods.length, 1);
    const [week] = history.periods;
    assert.equal(week.period, `${day(0)} to ${day(6)}`);
    assert.equal(week.approved, "$176.50");
    assert.equal(week.spent, "$74.34");
    assert.deepEqual(week.lines.find((l) => l.line === "dog-food"), { line: "dog-food", label: "Dog food, 12 kg bag", approved: "$32.50", used: "$32.49" });
    assert.deepEqual(
      week.purchases.map((p) => [p.date, p.title, p.amount, p.line]),
      [
        [day(0), "Dog food 12 kg", "$32.49", "dog-food"],
        [day(0), "Weekly order", "$41.85", "groceries"],
      ],
    );
  });

  it("takes dollars and returns readable balances", async () => {
    await runWalletTool(wallet, "request_budget", {
      summary: "Week",
      starts_on: day(0),
      ends_on: day(6),
      lines: [{ key: "groceries", label: "Groceries", amount: 88, reason: "Average of last 4 weeks" }],
      buffer: { amount: 8.8, reason: "Price changes and shipping." },
    }, "remit");
    await approve(wallet.pendingRequests()[0].id);
    const paid = await runWalletTool(wallet, "spend", { line: "groceries", amount: 41.85, title: "Weekly order", merchant: "FreshCart", reasoning: "Staples" }, "mcp");
    assert.equal((paid as { line_left: string }).line_left, "$46.15");
    const balance = (await runWalletTool(wallet, "get_balance", {}, "mcp")) as { left: string };
    assert.equal(balance.left, "$54.95");
  });
});
