import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { openDb, type Db } from "../src/db.ts";
import { PayPalError } from "../src/paypal/gateway.ts";
import { SimulatedPayPal } from "../src/paypal/simulated.ts";
import { runWalletTool } from "../src/wallet/tools.ts";
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

  it("top-ups are a new approval and a new hold, spent oldest first", async () => {
    await assert.rejects(buy("gift-sam", 9500), WalletError);
    const topup = wallet.requestTopup({ lineKey: "gift-sam", amountCents: 4000, reason: "Sam asked for headphones" });
    assert.throws(() => wallet.requestTopup({ lineKey: "gift-sam", amountCents: 100, reason: "again" }), (e: WalletError) => e.code === "REQUEST_PENDING");
    await approve(topup.requestId);

    await buy("groceries", 8800);
    await buy("dog-food", 3250);
    // Line has 8000 + buffer 1600. First hold has 17650 - 12050 = 5600 left, so this spans both holds.
    const result = await buy("gift-sam", 9500, "Headphones");
    assert.equal(result.captureIds.length, 2);
    const holds = wallet.state().holds;
    assert.equal(holds[0].capturedCents, 17650);
    assert.equal(holds[0].status, "captured");
    assert.equal(holds[1].capturedCents, 3900);
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
