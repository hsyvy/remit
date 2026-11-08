import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ShoppingAgent } from "../src/demo/agent.ts";
import { openDb, type Db } from "../src/db.ts";
import type { WebhookDelivery } from "../src/paypal/gateway.ts";
import { RestPayPal } from "../src/paypal/rest.ts";
import { SimulatedPayPal } from "../src/paypal/simulated.ts";
import { createApp } from "../src/server/app.ts";
import { Wallet } from "../src/wallet/wallet.ts";
import { PayPalWebhooks } from "../src/wallet/webhooks.ts";

const APP = "http://localhost:3000";
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
  const webhooks = new PayPalWebhooks(db, wallet);
  // A password is set to show PayPal doesn't need it.
  app = createApp({ wallet, agent: {} as ShoppingAgent, simulated: paypal, webhooks, modes, ownerPassword: "secret" });
});

/** Send the simulator's webhooks to the route, as the server does. */
function wireWebhooks() {
  paypal.deliverWebhooksTo((d) => post(d));
}

function post(d: WebhookDelivery) {
  return app.request("/paypal/webhook", { method: "POST", headers: d.headers as Record<string, string>, body: d.body });
}

function requestWeek() {
  return wallet.requestBudget({
    summary: "Household week",
    startsOn: day(0),
    endsOn: day(6),
    lines: [
      { key: "groceries", label: "Groceries, 2 orders", amountCents: 8800, reason: "Last 4 weeks averaged $43.70 per order." },
      { key: "dog-food", label: "Dog food, 12 kg bag", amountCents: 3250, reason: "Last bought Oct 15, lasts about 4 weeks." },
    ],
    buffer: { amountCents: 1600, reason: "Price changes and shipping." },
  });
}

const approvedEvent = (orderId: string, id = `WH-${orderId}`) => ({
  id,
  event_type: "CHECKOUT.ORDER.APPROVED",
  resource_type: "checkout-order",
  resource: { id: orderId, status: "APPROVED" },
});

const paypalEvents = () =>
  db.prepare("SELECT id, type, resource_id, action FROM paypal_events ORDER BY received_at").all() as {
    id: string;
    type: string;
    resource_id: string;
    action: string;
  }[];

const holdCount = () => (db.prepare("SELECT COUNT(*) AS n FROM holds").get() as { n: number }).n;

describe("PayPal webhooks", () => {
  it("rejects events that aren't verified, and changes nothing", async () => {
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);

    const unsigned = await app.request("/paypal/webhook", { method: "POST", body: JSON.stringify(approvedEvent(orderId)) });
    assert.equal(unsigned.status, 400);

    // Headers signed for one body, sent with another.
    const signed = paypal.signWebhook(approvedEvent(orderId));
    const forged = await post({ headers: signed.headers, body: JSON.stringify({ ...approvedEvent(orderId), id: "WH-OTHER" }) });
    assert.equal(forged.status, 400);
    assert.match(((await forged.json()) as { action: string }).action, /not verified/);

    assert.equal(paypalEvents().length, 0);
    assert.equal(holdCount(), 0);
    assert.equal(wallet.balance().period?.status, "pending");

    const ok = await post(signed);
    assert.equal(ok.status, 200);
    assert.equal(wallet.balance().period?.status, "open");
  });

  it("is off (404) without a webhook handler, as in sandbox mode without PAYPAL_WEBHOOK_ID", async () => {
    const off = createApp({ wallet, agent: {} as ShoppingAgent, modes, ownerPassword: "secret" });
    const res = await off.request("/paypal/webhook", { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
  });

  it("opens the period when PayPal reports the approval", async () => {
    wireWebhooks();
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    await paypal.webhooksSettled();

    const b = wallet.balance();
    assert.equal(b.period?.status, "open");
    assert.equal(b.approvedCents, 13650);
    assert.equal(b.leftCents, 13650);
    assert.equal(holdCount(), 1);
    const [event] = paypalEvents();
    assert.equal(event.type, "CHECKOUT.ORDER.APPROVED");
    assert.equal(event.resource_id, orderId);
    assert.match(event.action, /Approved request .* Hold of \$136\.50 placed/);

    // The redirect arriving afterwards is harmless.
    assert.deepEqual(await wallet.completeApproval(requestId, orderId), { alreadyApproved: true });
    assert.equal(holdCount(), 1);
  });

  it("ignores a redelivered event", async () => {
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    const delivery = paypal.signWebhook(approvedEvent(orderId));

    const [first, second] = await Promise.all([post(delivery), post(delivery)]);
    const third = await post(delivery);
    const bodies = (await Promise.all([first.json(), second.json(), third.json()])) as { duplicate?: boolean }[];
    assert.deepEqual([first.status, second.status, third.status], [200, 200, 200]);
    assert.equal(bodies.filter((b) => b.duplicate).length, 2);
    assert.equal(paypalEvents().length, 1);
    assert.equal(holdCount(), 1);
    assert.equal(wallet.balance().approvedCents, 13650);
  });

  it("places one hold when the webhook and the return redirect race", async () => {
    wireWebhooks();
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    // The webhook is already on its way; the owner's browser comes back at the same moment.
    const [redirect] = await Promise.all([wallet.completeApproval(requestId, orderId), paypal.webhooksSettled()]);
    assert.equal(redirect.alreadyApproved, false);
    assert.equal(holdCount(), 1);
    assert.equal(wallet.balance().approvedCents, 13650);
    assert.match(paypalEvents()[0].action, /already approved/);

    // And the other way round: a second budget, webhook first.
    await wallet.closePeriod();
    await paypal.webhooksSettled();
    const next = requestWeek();
    const order2 = await wallet.checkout(next.requestId);
    paypal.approve(order2.orderId);
    await Promise.all([paypal.webhooksSettled(), wallet.completeApproval(next.requestId, order2.orderId)]);
    assert.equal(holdCount(), 2);
    assert.equal(wallet.balance().approvedCents, 13650);
  });

  it("releases a lapsing hold when PayPal voids the expired authorization", async () => {
    wireWebhooks();
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    await paypal.webhooksSettled();
    await wallet.spend({ lineKey: "groceries", amountCents: 5000, title: "Weekly order", merchant: "shop.example", reasoning: "Staples", agent: "remit" });
    const closed = await wallet.closePeriod();
    assert.equal(closed.lapsingCents, 8650);
    const [hold] = wallet.state().holds;
    assert.equal(hold.status, "lapsing");

    paypal.expireAuthorization(hold.authorizationId);
    await paypal.webhooksSettled();
    const [after] = wallet.state().holds;
    assert.equal(after.status, "voided");
    assert.match(after.releaseNote ?? "", /expired\. \$86\.50 released/);
    assert.match(wallet.state().events[0].message, /expired\. The last \$86\.50 is released back to you/);
    assert.equal(paypalEvents().at(-1)?.type, "PAYMENT.AUTHORIZATION.VOIDED");
  });

  it("leaves a hold the wallet voided itself alone", async () => {
    wireWebhooks();
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    await paypal.webhooksSettled();
    await wallet.closePeriod();
    await paypal.webhooksSettled();
    assert.equal(wallet.state().holds[0].status, "voided");
    assert.match(wallet.state().holds[0].releaseNote ?? "", /^Voided, \$136\.50 released/);
    assert.match(paypalEvents().at(-1)?.action ?? "", /already voided/);
  });

  it("puts the watcher's note on the card when PayPal declines the order", async () => {
    wireWebhooks();
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.decline(orderId);
    await paypal.webhooksSettled();
    const card = wallet.pendingRequests().find((r) => r.id === requestId)!;
    assert.equal(card.status, "checkout");
    assert.equal(card.approval?.state, "not_approved");
    assert.match(wallet.state().events[0].message, /PayPal didn't approve the \$136\.50 budget request/);
    assert.equal(paypalEvents()[0].type, "CHECKOUT.ORDER.DECLINED");

    // A voided order gets the voided note.
    await post(paypal.signWebhook({ id: "WH-V", event_type: "CHECKOUT.ORDER.VOIDED", resource: { id: orderId } }));
    assert.equal(wallet.pendingRequests()[0].approval?.state, "voided");
  });

  it("logs refunds and reversals, and records unknown events without acting", async () => {
    wireWebhooks();
    const { requestId } = requestWeek();
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    await paypal.webhooksSettled();
    const paid = await wallet.spend({ lineKey: "groceries", amountCents: 4185, title: "Weekly order", merchant: "shop.example", reasoning: "Staples", agent: "remit" });
    const captureId = paid.captureIds[0];

    const refund = await post(
      paypal.signWebhook({
        id: "WH-R",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "refund",
        resource: { id: "REF1", amount: { value: "10.00" }, links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] },
      }),
    );
    assert.equal(refund.status, 200);
    assert.match(wallet.state().events[0].message, /PayPal reports a \$10\.00 refund for "Weekly order" that wasn't made in Remit/);

    await post(paypal.signWebhook({ id: "WH-X", event_type: "PAYMENT.CAPTURE.REVERSED", resource: { id: "REV1", amount: { value: "-41.85" }, links: [{ rel: "up", href: `/v2/payments/captures/${captureId}` }] } }));
    assert.match(wallet.state().events[0].message, /PayPal reversed the \$41\.85 payment for "Weekly order"/);
    // Logged only: the purchase and the totals stay as they were.
    assert.equal(wallet.balance().spentCents, 4185);

    const before = wallet.state().events.length;
    const unknown = await post(paypal.signWebhook({ id: "WH-U", event_type: "BILLING.SUBSCRIPTION.CREATED", resource: { id: "I-1" } }));
    assert.equal(unknown.status, 200);
    assert.match(paypalEvents().find((e) => e.id === "WH-U")!.action, /ignored/);
    assert.equal(wallet.state().events.length, before);
  });
});

describe("REST webhook verification", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-11-08T10:00:00Z",
  };

  it("asks PayPal with the headers, the webhook ID and the event exactly as received", async () => {
    const sent: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body) });
      if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      return new Response(JSON.stringify({ verification_status: "SUCCESS" }));
    }) as typeof fetch;
    const rest = new RestPayPal({ clientId: "id", clientSecret: "secret", baseUrl: "https://paypal.test", currency: "USD", webhookId: "WH123" });
    const body = '{"id":"WH-1",  "event_type":"CHECKOUT.ORDER.APPROVED","resource":{"id":"O1"}}';
    assert.equal(await rest.verifyWebhook({ headers, body }), true);
    const call = sent.find((s) => s.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    const parsed = JSON.parse(call.body);
    assert.equal(parsed.webhook_id, "WH123");
    assert.equal(parsed.transmission_sig, "sig");
    assert.equal(parsed.cert_url, headers["paypal-cert-url"]);
    assert.ok(call.body.endsWith(`"webhook_event":${body}}`));
  });

  it("says no without a webhook ID, missing headers, or a FAILURE", async () => {
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(url.endsWith("token") ? { access_token: "t", expires_in: 3600 } : { verification_status: "FAILURE" }))) as typeof fetch;
    const opts = { clientId: "id", clientSecret: "secret", baseUrl: "https://paypal.test", currency: "USD" };
    const body = '{"id":"WH-1"}';
    assert.equal(await new RestPayPal(opts).verifyWebhook({ headers, body }), false);
    const rest = new RestPayPal({ ...opts, webhookId: "WH123" });
    assert.equal(await rest.verifyWebhook({ headers: { ...headers, "paypal-transmission-sig": undefined }, body }), false);
    assert.equal(await rest.verifyWebhook({ headers, body }), false);
  });
});
