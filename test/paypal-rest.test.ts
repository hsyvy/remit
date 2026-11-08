import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { PayPalError } from "../src/paypal/gateway.ts";
import { RestPayPal } from "../src/paypal/rest.ts";

const BASE = "https://paypal.test";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

let seen: Seen[];
let tokens: number;
/** The fake PayPal's answer for API calls (not the token endpoint). */
let reply: (req: Seen) => { status: number; body?: unknown };

beforeEach(() => {
  seen = [];
  tokens = 0;
  reply = () => ({ status: 200, body: {} });
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const req: Seen = {
      method: init.method ?? "GET",
      path: new URL(url).pathname,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    };
    seen.push(req);
    if (req.path === "/v1/oauth2/token") {
      tokens++;
      return Response.json({ access_token: `token-${tokens}`, expires_in: 3600 });
    }
    const { status, body } = reply(req);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

const client = () => new RestPayPal({ clientId: "id", clientSecret: "secret", baseUrl: BASE, currency: "USD" });
const apiCalls = () => seen.filter((s) => s.path !== "/v1/oauth2/token");

/** A PayPal error body as the Orders and Payments APIs send it. */
const paypalError = (status: number, issue: string, description: string) => ({
  status,
  body: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed.", debug_id: "dbg-1", details: [{ issue, description }] },
});

describe("PayPal REST client", () => {
  it("signs in once and reuses the token", async () => {
    const paypal = client();
    reply = () => ({ status: 200, body: { id: "ORDER-1", status: "CREATED" } });
    await paypal.getOrderStatus("ORDER-1");
    await paypal.getOrderStatus("ORDER-1");

    assert.equal(tokens, 1);
    const signIn = seen[0];
    assert.equal(signIn.method, "POST");
    assert.equal(signIn.headers.Authorization, `Basic ${Buffer.from("id:secret").toString("base64")}`);
    assert.equal(signIn.body, "grant_type=client_credentials");
    assert.deepEqual(apiCalls().map((c) => c.headers.Authorization), ["Bearer token-1", "Bearer token-1"]);
  });

  it("signs in again when the token is about to expire", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const paypal = client();
    reply = () => ({ status: 200, body: { id: "ORDER-1", status: "CREATED" } });
    await paypal.getOrderStatus("ORDER-1");
    mock.timers.tick(3000 * 1000);
    await paypal.getOrderStatus("ORDER-1");
    assert.equal(tokens, 1);
    // Inside the last minute of the hour, it gets a fresh token first.
    mock.timers.tick(570 * 1000);
    await paypal.getOrderStatus("ORDER-1");
    assert.equal(tokens, 2);
    assert.equal(apiCalls().at(-1)?.headers.Authorization, "Bearer token-2");
  });

  it("reports a failed sign-in as a PayPal error", async () => {
    mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
    await assert.rejects(client().getOrderStatus("ORDER-1"), (e: PayPalError) => e instanceof PayPalError && e.status === 401);
  });

  it("sends a PayPal-Request-Id on every write, stable for retries", async () => {
    const paypal = client();
    reply = (req) => {
      if (req.path.endsWith("/authorize")) {
        const authorization = { id: "AUTH-1", status: "CREATED", amount: { value: "50.00" } };
        return { status: 201, body: { id: "ORDER-1", status: "COMPLETED", purchase_units: [{ payments: { authorizations: [authorization] } }] } };
      }
      if (req.path.endsWith("/capture")) return { status: 201, body: { id: "CAP-1", status: "COMPLETED" } };
      if (req.path.endsWith("/refund")) return { status: 201, body: { id: "REF-1" } };
      if (req.path.endsWith("/reauthorize")) return { status: 201, body: { id: "AUTH-2", status: "CREATED", amount: { value: "30.00" } } };
      return { status: 204 };
    };

    const auth = await paypal.authorizeOrder("ORDER-1");
    assert.deepEqual([auth.authorizationId, auth.cents], ["AUTH-1", 5000]);
    await paypal.capture("AUTH-1", { cents: 1250, finalCapture: false, note: "Rice", idempotencyKey: "spend-abc" });
    await paypal.capture("AUTH-1", { cents: 1250, finalCapture: false, note: "Rice", idempotencyKey: "spend-abc" });
    await paypal.reauthorize("AUTH-1", 3000);
    await paypal.voidAuthorization("AUTH-1");
    await paypal.refund("CAP-1", 500, "refund-xyz");

    assert.deepEqual(
      apiCalls().map((c) => [c.method, c.path, c.headers["PayPal-Request-Id"]]),
      [
        ["POST", "/v2/checkout/orders/ORDER-1/authorize", "authorize-ORDER-1"],
        ["POST", "/v2/payments/authorizations/AUTH-1/capture", "spend-abc"],
        ["POST", "/v2/payments/authorizations/AUTH-1/capture", "spend-abc"],
        ["POST", "/v2/payments/authorizations/AUTH-1/reauthorize", "reauthorize-AUTH-1"],
        ["POST", "/v2/payments/authorizations/AUTH-1/void", "void-AUTH-1"],
        ["POST", "/v2/payments/captures/CAP-1/refund", "refund-xyz"],
      ],
    );
    const capture = JSON.parse(apiCalls()[1].body!);
    assert.deepEqual(capture.amount, { currency_code: "USD", value: "12.50" });
    assert.equal(capture.final_capture, false);
  });

  it("gives a new order its own PayPal-Request-Id and returns the approval link", async () => {
    const paypal = client();
    reply = () => ({ status: 201, body: { id: "ORDER-9", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://paypal.test/approve/9" }] } });
    const input = {
      referenceId: "req-1",
      description: "Household week",
      items: [{ name: "Groceries", description: "Two orders", cents: 5000 }],
      returnUrl: "http://localhost:3000/paypal/return",
      cancelUrl: "http://localhost:3000/paypal/cancel",
    };
    assert.deepEqual(await paypal.createAuthorizeOrder(input), { orderId: "ORDER-9", approveUrl: "https://paypal.test/approve/9" });
    await paypal.createAuthorizeOrder(input);
    const [a, b] = apiCalls().map((c) => c.headers["PayPal-Request-Id"]);
    assert.ok(a && b && a !== b);
    assert.equal(JSON.parse(apiCalls()[0].body!).intent, "AUTHORIZE");
  });

  for (const [issue, call] of [
    ["MAX_CAPTURE_AMOUNT_EXCEEDED", (p: RestPayPal) => p.capture("AUTH-1", { cents: 99_999, finalCapture: false, note: "Too much", idempotencyKey: "k" })],
    ["PREVIOUSLY_CAPTURED", (p: RestPayPal) => p.voidAuthorization("AUTH-1")],
    ["ORDER_NOT_APPROVED", (p: RestPayPal) => p.authorizeOrder("ORDER-1")],
  ] as const) {
    it(`maps PayPal's ${issue} to a PayPalError with the issue`, async () => {
      reply = () => paypalError(422, issue, `PayPal says ${issue}.`);
      await assert.rejects(call(client()), (e: PayPalError) => {
        assert.ok(e instanceof PayPalError);
        assert.equal(e.status, 422);
        assert.equal(e.issue, issue);
        assert.equal(e.debugId, "dbg-1");
        assert.equal(e.message, `PayPal says ${issue}.`);
        return true;
      });
    });
  }

  it("falls back to the error name when PayPal sends no details", async () => {
    reply = () => ({ status: 404, body: { name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." } });
    await assert.rejects(client().getOrderStatus("NOPE"), (e: PayPalError) => e.issue === "RESOURCE_NOT_FOUND" && e.status === 404);
  });
});
