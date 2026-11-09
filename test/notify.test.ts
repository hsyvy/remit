import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { openDb, type Db } from "../src/db.ts";
import { LinkSigner } from "../src/notify/links.ts";
import { Notifications } from "../src/notify/notices.ts";
import { FanoutNotifier, LogNotifier, makeNotifier, ntfyMessage, NtfyNotifier, WebhookNotifier, type Notice, type Notifier } from "../src/notify/notifier.ts";
import { SimulatedPayPal } from "../src/paypal/simulated.ts";
import { createApp, type AppDeps } from "../src/server/app.ts";
import { Wallet, WalletError, type ReviewResult } from "../src/wallet/wallet.ts";

const APP = "http://localhost:3000";
const SECRET = "test-secret-not-real";
const HOUR = 3_600_000;
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Records every notice; can be told to fail. */
class FakeNotifier implements Notifier {
  readonly name = "fake";
  sent: Notice[] = [];
  fail: "no" | "reject" | "throw" = "no";
  async send(notice: Notice) {
    if (this.fail === "throw") throw new Error("phone is off");
    if (this.fail === "reject") return Promise.reject(new Error("ntfy answered 500"));
    this.sent.push(notice);
  }
}

let db: Db;
let paypal: SimulatedPayPal;
let clock: Date;
let links: LinkSigner;
let notifier: FakeNotifier;
let notifications: Notifications;
let wallet: Wallet;
let logged: string[];
let agentOn: boolean;
/** What the purpose check says; "skipped" by default, as with no API key. */
let verdict: ReviewResult;

beforeEach(() => {
  db = openDb(":memory:");
  paypal = new SimulatedPayPal(db, APP);
  clock = new Date();
  links = new LinkSigner(SECRET, () => clock);
  notifier = new FakeNotifier();
  logged = [];
  agentOn = false;
  verdict = { verdict: "skipped", reason: "Purpose check is off." };
  let n: Notifications | undefined;
  wallet = new Wallet(db, paypal, { appUrl: APP, maxRequestCents: 50_000, now: () => clock, onEvent: (e) => n?.onEvent(e), reviewer: { review: async () => verdict } });
  n = notifications = new Notifications(wallet, notifier, links, { appUrl: APP, canPlan: () => agentOn, log: (m) => logged.push(m) });
});

function requestWeek(agentId?: string) {
  return wallet.requestBudget({
    agentId,
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

async function approve(requestId: string) {
  const { orderId } = await wallet.checkout(requestId);
  paypal.approve(orderId);
  await wallet.completeApproval(requestId, orderId);
}

const buy = (lineKey: string, amountCents: number, title = "Thing") =>
  wallet.spend({ lineKey, amountCents, title, merchant: "shop.example", reasoning: "Needed", agent: "remit" });

/** The signed code from a link URL. */
const codeOf = (url: string) => url.slice(`${APP}/link/`.length);

describe("link signing", () => {
  it("accepts its own link for the action and request it was signed for", () => {
    const code = links.sign("approve", "req_0123456789ab");
    const check = links.verify(code, "approve");
    assert.ok(check.ok);
    assert.equal(check.claim.ref, "req_0123456789ab");
    assert.equal(check.claim.action, "approve");
    assert.ok(Math.abs(check.claim.expiresAt.getTime() - (clock.getTime() + 24 * HOUR)) < 1000);
  });

  it("rejects a tampered link", () => {
    const code = links.sign("approve", "req_0123456789ab");
    const [action, ref, expires, sig] = code.split(".") as [string, string, string, string];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `${action}.req_ba9876543210.${expires}.${sig}`, // another request
      `decline.${ref}.${expires}.${sig}`, // another action
      `${action}.${ref}.${Number(expires) + 86_400}.${sig}`, // a later expiry
      `${action}.${ref}.${expires}.${flip(sig)}`, // a changed signature
      `${action}.${ref}.${expires}`, // no signature
      "",
    ]) {
      const check = links.verify(bad);
      assert.equal(check.ok, false, bad);
    }
    assert.equal(new LinkSigner("another-secret", () => clock).verify(code).ok, false);
  });

  it("rejects an expired link", () => {
    const code = links.sign("decline", "req_0123456789ab");
    clock = new Date(clock.getTime() + 24 * HOUR + 1000);
    const check = links.verify(code, "decline");
    assert.deepEqual(check, { ok: false, why: "expired" });
  });

  it("rejects a link used for the wrong action", () => {
    const code = links.sign("decline", "req_0123456789ab");
    assert.deepEqual(links.verify(code, "approve"), { ok: false, why: "wrong_action" });
  });
});

describe("notices", () => {
  it("sends a budget request with signed Approve and Decline links", async () => {
    const { requestId } = requestWeek();
    await notifications.idle();
    assert.equal(notifier.sent.length, 1);
    const n = notifier.sent[0]!;
    assert.equal(n.kind, "request");
    assert.equal(n.priority, "high");
    assert.match(n.title, /^Approve \$136\.50 for /);
    assert.match(n.body, /^Your agent asks for a budget: Household week/);
    assert.match(n.body, /Groceries, 2 orders: \$88\.00\. Last 4 weeks averaged/);
    assert.deepEqual(n.actions.map((a) => a.label), ["Approve", "Decline", "Open Remit"]);
    const approve = links.verify(codeOf(n.actions[0]!.url), "approve");
    const decline = links.verify(codeOf(n.actions[1]!.url), "decline");
    assert.ok(approve.ok && approve.claim.ref === requestId);
    assert.ok(decline.ok && decline.claim.ref === requestId);
    assert.equal(n.data.requestId, requestId);
  });

  it("sends a top-up with the line's amount now and after", async () => {
    await approve(requestWeek().requestId);
    const { requestId } = wallet.requestTopup({ lineKey: "dog-food", amountCents: 1000, reason: "The 12 kg bag went up to $42.50 this week." });
    await notifications.idle();
    const n = notifier.sent.at(-1)!;
    assert.equal(n.title, "Approve $10.00 more for Dog food, 12 kg bag?");
    assert.match(n.body, /has \$32\.50 now, \$42\.50 after/);
    assert.equal(n.data.requestId, requestId);
  });

  it("sends a refused purchase with the reason", async () => {
    await approve(requestWeek().requestId);
    notifier.sent = [];
    await assert.rejects(buy("dog-food", 6000, "Premium dog food 20 kg"), (e: WalletError) => e.code === "OVER_LINE");
    await notifications.idle();
    assert.equal(notifier.sent.length, 1);
    const n = notifier.sent[0]!;
    assert.equal(n.kind, "refusal");
    assert.equal(n.title, 'Refused $60.00 for "Premium dog food 20 kg"');
    assert.match(n.body, /more than "Dog food, 12 kg bag" allows/);
  });

  it("names the agent that asked", async () => {
    const { agent } = wallet.agents.create("Pantry bot");
    await approve(requestWeek(agent.id).requestId);
    wallet.requestTopup({ lineKey: "dog-food", amountCents: 1000, reason: "The 12 kg bag went up to $42.50 this week.", agentId: agent.id });
    await notifications.idle();
    const [budget, topup] = notifier.sent.filter((n) => n.kind === "request");
    assert.match(budget!.body, /^Pantry bot asks for a budget: /);
    assert.match(topup!.body, /^Pantry bot asks: The 12 kg bag/);
    assert.equal(budget!.data.askedBy, "Pantry bot");
  });

  it("sends no refusal notice for an agent the owner paused or revoked", async () => {
    const { agent } = wallet.agents.create("Pantry bot");
    await approve(requestWeek(agent.id).requestId);
    notifier.sent = [];
    wallet.agents.setStatus(agent.id, "paused");
    const spendAs = () => wallet.spend({ lineKey: "groceries", amountCents: 500, title: "Rice", merchant: "shop.example", reasoning: "Needed", agent: agent.id });
    await assert.rejects(spendAs(), (e: WalletError) => e.code === "AGENT_PAUSED");
    wallet.agents.revoke(agent.id);
    await assert.rejects(spendAs(), (e: WalletError) => e.code === "AGENT_REVOKED");
    await notifications.idle();
    assert.deepEqual(notifier.sent, []);
    // Both refusals are still in the ledger.
    assert.equal(wallet.state().purchases.filter((p) => p.status === "refused").length, 2);
  });

  it("offers Pay anyway only for a purpose check refusal", async () => {
    await approve(requestWeek().requestId);
    notifier.sent = [];
    await assert.rejects(buy("dog-food", 6000), (e: WalletError) => e.code === "OVER_LINE");
    verdict = { verdict: "reject", reason: "A dog bed isn't dog food. The line is for food." };
    await assert.rejects(buy("dog-food", 2500, "Dog bed"), (e: WalletError) => e.code === "REVIEW_REJECTED");
    await notifications.idle();
    const [overLine, rejected] = notifier.sent;
    assert.deepEqual(overLine!.actions.map((a) => a.label), ["Open ledger"]);
    assert.deepEqual(rejected!.actions.map((a) => a.label), ["Pay $25.00 anyway", "Open ledger"]);
    assert.match(rejected!.body, /^Purpose check: A dog bed isn't dog food\./);
    assert.match(rejected!.body, /Your agent · shop\.example · Dog food, 12 kg bag/);
    const link = links.verify(codeOf(rejected!.actions[0]!.url), "override");
    assert.ok(link.ok && link.claim.ref === wallet.state().purchases.find((p) => p.title === "Dog bed")!.id);
  });

  it("sends the recap when a period closes: per line, refusals and what was released", async () => {
    await approve(requestWeek().requestId);
    await buy("groceries", 4210, "Groceries order");
    await assert.rejects(buy("dog-food", 6000, "Premium dog food"));
    agentOn = true;
    notifier.sent = [];
    await wallet.closePeriod();
    await notifications.idle();
    assert.equal(notifier.sent.length, 1);
    const n = notifier.sent[0]!;
    assert.equal(n.kind, "recap");
    assert.match(n.title, /closed: spent \$42\.10 of \$136\.50$/);
    assert.match(n.body, /Groceries, 2 orders: spent \$42\.10 of \$88\.00/);
    assert.match(n.body, /Dog food, 12 kg bag: spent \$0\.00 of \$32\.50/);
    assert.match(n.body, /Refused 1 \(\$60\.00\): "Premium dog food" \$60\.00\./);
    // The simulated PayPal, like the real one, keeps a partly captured hold until it expires.
    assert.match(n.body, /\$94\.40 released when PayPal's hold expires on [A-Z][a-z]{2} \d{1,2}\./);
    assert.deepEqual(n.actions.map((a) => a.label), ["Open Remit", "Plan next week"]);
    const plan = links.verify(codeOf(n.actions[1]!.url), "plan");
    assert.ok(plan.ok && plan.claim.ref === (n.data.period as { id: string }).id);
  });

  it("leaves out the plan link when the agent is off", async () => {
    await approve(requestWeek().requestId);
    notifier.sent = [];
    await wallet.closePeriod();
    await notifications.idle();
    const n = notifier.sent[0]!;
    assert.deepEqual(n.actions.map((a) => a.label), ["Open Remit"]);
    assert.match(n.body, /\$136\.50 released to you now/);
  });

  it("a failing notifier never breaks the wallet", async () => {
    notifier.fail = "throw";
    const { requestId } = requestWeek();
    await approve(requestId);
    notifier.fail = "reject";
    const spent = await buy("groceries", 1000);
    assert.equal(spent.amountCents, 1000);
    await assert.rejects(buy("dog-food", 6000), (e: WalletError) => e.code === "OVER_LINE");
    await wallet.closePeriod();
    await notifications.idle();
    assert.equal(notifier.sent.length, 0);
    assert.ok(logged.some((l) => l.includes("phone is off")));
    assert.ok(logged.some((l) => l.includes("ntfy answered 500")));
    assert.equal(wallet.periodRecap(wallet.state().period!.id).spentCents, 1000);
  });

  it("an onEvent hook that throws doesn't break the wallet either", async () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const w = new Wallet(db, paypal, { appUrl: APP, maxRequestCents: 50_000, now: () => clock, onEvent: () => { throw new Error("boom"); } });
      const { requestId } = w.requestBudget({
        summary: "Week",
        startsOn: day(0),
        endsOn: day(6),
        lines: [{ key: "groceries", label: "Groceries", amountCents: 1000, reason: "Last 4 weeks averaged $43.70 per order." }],
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(w.pendingRequests()[0]!.id, requestId);
    } finally {
      console.error = quiet;
    }
  });
});

describe("notifiers", () => {
  const notice: Notice = {
    kind: "request",
    title: "Approve $10.00 more for Gift for Sam?",
    body: "Sam's set costs $50.",
    url: `${APP}/link/a`,
    actions: [
      { label: "Approve", url: `${APP}/link/a` },
      { label: "Decline", url: `${APP}/link/d` },
      { label: "Open Remit", url: `${APP}/app#req` },
      { label: "Fourth", url: `${APP}/` },
    ],
    priority: "high",
    data: { requestId: "req_1" },
  };

  it("publishes to ntfy as JSON with view actions and a bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await new NtfyNotifier({ url: "https://ntfy.example", topic: "remit-test", token: "tk_test" }, fake).send(notice);
    assert.equal(calls[0]!.url, "https://ntfy.example/");
    assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer tk_test");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body, ntfyMessage("remit-test", notice));
    assert.equal(body.topic, "remit-test");
    assert.equal(body.priority, 4);
    assert.equal(body.click, `${APP}/link/a`);
    assert.equal(body.actions.length, 3);
    assert.deepEqual(body.actions[0], { action: "view", label: "Approve", url: `${APP}/link/a`, clear: true });
  });

  it("posts the notice to a webhook and reports a failed answer", async () => {
    let posted: Record<string, unknown> = {};
    let status = 204;
    const fake = (async (_url: string, init: RequestInit) => {
      posted = JSON.parse(String(init.body));
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const hook = new WebhookNotifier("https://hooks.example/remit", fake);
    await hook.send(notice);
    assert.equal(posted.source, "remit");
    assert.equal(posted.kind, "request");
    assert.deepEqual(posted.data, { requestId: "req_1" });
    status = 500;
    await assert.rejects(hook.send(notice), /500/);
  });

  it("is chosen by settings", () => {
    const base = { ntfyUrl: "https://ntfy.sh", ntfyTopic: "", ntfyToken: "", webhookUrl: "" };
    assert.ok(makeNotifier(base) instanceof LogNotifier);
    assert.ok(makeNotifier({ ...base, ntfyTopic: "t" }) instanceof NtfyNotifier);
    assert.ok(makeNotifier({ ...base, webhookUrl: "https://h.example" }) instanceof WebhookNotifier);
    assert.ok(makeNotifier({ ...base, ntfyTopic: "t", webhookUrl: "https://h.example" }) instanceof FanoutNotifier);
  });
});

describe("one-tap link routes", () => {
  let app: ReturnType<typeof createApp>;
  let planned: string[];
  beforeEach(() => {
    planned = [];
    const agent = { enabled: true, isBusy: false, send: async (t: string) => void planned.push(t), transcript: () => [] };
    app = createApp({
      wallet,
      agent,
      simulated: paypal,
      modes: { paypal: "simulated", search: "demo", agent: "on", reviewer: "off", model: "test" },
      ownerPassword: "secret",
      links: { signer: links, appUrl: APP },
    } as unknown as AppDeps);
  });

  async function requestLinks() {
    const { requestId } = requestWeek();
    await notifications.idle();
    const n = notifier.sent.at(-1)!;
    return { requestId, approve: codeOf(n.actions[0]!.url), decline: codeOf(n.actions[1]!.url) };
  }

  it("work without the owner password, and opening one changes nothing", async () => {
    const { requestId, approve } = await requestLinks();
    assert.equal((await app.request("/api/state")).status, 401);
    const res = await app.request(`/link/${approve}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /Approve \$136\.50 for/);
    assert.match(html, /Groceries, 2 orders/);
    assert.match(html, /Last 4 weeks averaged \$43\.70 per order\./);
    assert.match(html, /Approve on PayPal/);
    assert.equal(wallet.pendingRequests()[0]!.status, "pending");
    assert.equal((await app.request("/styles.css")).status, 200);
    assert.equal(requestId, wallet.pendingRequests()[0]!.id);
  });

  it("approve goes through checkout to PayPal and back", async () => {
    const { requestId, approve } = await requestLinks();
    const post = await app.request(`/link/${approve}`, { method: "POST" });
    assert.equal(post.status, 303);
    const location = post.headers.get("location")!;
    assert.match(location, /\/sim-paypal\/checkout\//);
    const orderId = location.split("/").at(-1)!;
    // Returning without approving on PayPal does nothing.
    const early = await app.request(`/link/${approve}/back?token=${orderId}`);
    assert.equal(early.status, 400);
    assert.equal(wallet.balance().period?.status, "pending");

    paypal.approve(orderId);
    const back = await app.request(`/link/${approve}/back?token=${orderId}`);
    assert.equal(back.status, 200);
    assert.match(await back.text(), /Approved/);
    assert.equal(wallet.balance().period?.status, "open");
    assert.equal(wallet.balance().approvedCents, 13650);
    // The used link now only says it's decided.
    assert.match(await (await app.request(`/link/${approve}`)).text(), /Already decided/);
    assert.ok(requestId);
  });

  it("decline shows a confirm page, then declines on POST", async () => {
    const { decline } = await requestLinks();
    assert.match(await (await app.request(`/link/${decline}`)).text(), /Decline the \$136\.50 budget request\?/);
    assert.equal(wallet.pendingRequests().length, 1);
    const res = await app.request(`/link/${decline}`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(wallet.pendingRequests().length, 0);
    assert.equal(wallet.state().period?.status, "declined");
  });

  it("a tampered, expired or wrong-action link does nothing", async () => {
    const { approve, decline } = await requestLinks();
    const tampered = approve.slice(0, -2) + (approve.endsWith("AA") ? "BB" : "AA");
    assert.equal((await app.request(`/link/${tampered}`, { method: "POST" })).status, 403);
    // A decline link can't be used as PayPal's return for an approval.
    assert.equal((await app.request(`/link/${decline}/back?token=x`)).status, 403);
    assert.equal(wallet.pendingRequests()[0]!.status, "pending");

    clock = new Date(clock.getTime() + 25 * HOUR);
    const expired = await app.request(`/link/${decline}`, { method: "POST" });
    assert.equal(expired.status, 410);
    assert.equal(wallet.pendingRequests().length, 1);
  });

  it("the recap's plan link asks the agent to plan, once", async () => {
    agentOn = true;
    await approve(requestWeek().requestId);
    await wallet.closePeriod();
    await notifications.idle();
    const plan = codeOf(notifier.sent.at(-1)!.actions[1]!.url);
    assert.match(await (await app.request(`/link/${plan}`)).text(), /Plan the next budget\?/);
    assert.equal(planned.length, 0);
    assert.equal((await app.request(`/link/${plan}`, { method: "POST" })).status, 200);
    assert.equal(planned.length, 1);
    // Once a new request is waiting, the link doesn't start another plan.
    requestWeek();
    assert.equal((await app.request(`/link/${plan}`, { method: "POST" })).status, 409);
    assert.equal(planned.length, 1);
  });

  it("Pay anyway shows the refusal, pays on POST, and works once", async () => {
    await approve(requestWeek().requestId);
    verdict = { verdict: "reject", reason: "A dog bed isn't dog food." };
    await assert.rejects(buy("dog-food", 2500, "Dog bed"), (e: WalletError) => e.code === "REVIEW_REJECTED");
    await notifications.idle();
    const code = codeOf(notifier.sent.at(-1)!.actions[0]!.url);
    const id = wallet.state().purchases.find((p) => p.title === "Dog bed")!.id;

    const page = await (await app.request(`/link/${code}`)).text();
    assert.match(page, /Pay \$25\.00 anyway\?/);
    assert.match(page, /A dog bed isn&#39;t dog food\./);
    assert.equal(wallet.state().purchases.find((x) => x.id === id)!.status, "refused");

    const paid = await app.request(`/link/${code}`, { method: "POST" });
    assert.equal(paid.status, 200);
    assert.match(await paid.text(), /Paid anyway/);
    const p = wallet.state().purchases.find((x) => x.id === id)!;
    assert.equal(p.status, "captured");
    assert.equal(p.override?.by, "owner");

    assert.equal((await app.request(`/link/${code}`, { method: "POST" })).status, 409);
    assert.match(await (await app.request(`/link/${code}`)).text(), /Already paid/);
    // The link is only for Pay anyway: it can't approve or decline anything.
    assert.equal((await app.request(`/link/${code}/back?token=x`)).status, 403);
  });
});
