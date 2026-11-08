import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db.ts";
import { newId } from "../db.ts";
import { toValue } from "../money.ts";
import {
  AUTHORIZATION_MS,
  PayPalError,
  type Authorization,
  type CaptureInput,
  type CreateOrderInput,
  type PayPalGateway,
  type WebhookDelivery,
} from "./gateway.ts";

/**
 * A local stand-in for the PayPal sandbox, so the app runs end to end before credentials exist.
 * It enforces the same limits the brief relies on: no authorize before approval, no capture above
 * the hold (MAX_CAPTURE_AMOUNT_EXCEEDED), and no void after a capture (PREVIOUSLY_CAPTURED).
 * The owner approves on /sim-paypal/checkout/:orderId, which is clearly labelled as a simulation.
 * That page can also act out PayPal refusing the payment method, which leaves the order waiting, as on PayPal.
 * Like PayPal, it can send webhooks for approvals, declines and voided holds, signed with its own key.
 */
export class SimulatedPayPal implements PayPalGateway {
  readonly mode = "simulated" as const;
  /** Signs simulated webhooks. Made fresh each start: only this process sends or checks them. */
  private readonly webhookKey = randomBytes(32);
  private webhookTarget?: (delivery: WebhookDelivery) => unknown;
  private readonly deliveries = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly appUrl: string,
  ) {}

  async createAuthorizeOrder(input: CreateOrderInput) {
    const order: SimOrder = {
      id: newId("SIMORDER").toUpperCase(),
      referenceId: input.referenceId,
      // What PayPal returns for an order created with a payment_source: it waits for the buyer.
      status: "PAYER_ACTION_REQUIRED",
      declined: false,
      description: input.description,
      items: input.items,
      totalCents: input.items.reduce((sum, item) => sum + item.cents, 0),
      returnUrl: input.returnUrl,
      cancelUrl: input.cancelUrl,
    };
    this.put("order", order.id, order);
    return { orderId: order.id, approveUrl: `${this.appUrl}/sim-paypal/checkout/${order.id}` };
  }

  async getOrderStatus(orderId: string) {
    return this.order(orderId).status;
  }

  /** Called by the simulated checkout page when the owner clicks Approve. */
  approve(orderId: string): SimOrder {
    const order = this.order(orderId);
    if (isWaiting(order)) {
      order.status = "APPROVED";
      order.declined = false;
      this.put("order", order.id, order);
      this.sendWebhook("CHECKOUT.ORDER.APPROVED", "checkout-order", `Order ${order.id} approved`, orderResource(order));
    }
    return order;
  }

  /**
   * PayPal refused the buyer's payment method. Like PayPal, the order doesn't change status:
   * it keeps waiting so the buyer can pick another way to pay. The simulator also sends
   * CHECKOUT.ORDER.DECLINED; the real PayPal may not for a card refused on its own page.
   */
  decline(orderId: string): SimOrder {
    const order = this.order(orderId);
    if (isWaiting(order)) {
      order.declined = true;
      this.put("order", order.id, order);
      this.sendWebhook("CHECKOUT.ORDER.DECLINED", "checkout-order", `Order ${order.id} declined`, orderResource(order));
    }
    return order;
  }

  /** PayPal drops orders that are never approved. */
  voidOrder(orderId: string): SimOrder {
    const order = this.order(orderId);
    if (isWaiting(order)) {
      order.status = "VOIDED";
      this.put("order", order.id, order);
    }
    return order;
  }

  getOrder(orderId: string): SimOrder {
    return this.order(orderId);
  }

  async authorizeOrder(orderId: string): Promise<Authorization> {
    const order = this.order(orderId);
    if (order.status === "COMPLETED") throw new PayPalError("Order already authorized", 422, "ORDER_ALREADY_AUTHORIZED");
    if (order.status !== "APPROVED") throw new PayPalError("The payer has not approved this order", 422, "ORDER_NOT_APPROVED");
    order.status = "COMPLETED";
    this.put("order", order.id, order);
    return this.newAuthorization(order.totalCents);
  }

  async capture(authorizationId: string, input: CaptureInput) {
    const existing = this.get<SimCapture>("capture", `key:${input.idempotencyKey}`);
    if (existing) return { captureId: existing.id, status: "COMPLETED" };

    const auth = this.authorization(authorizationId);
    if (auth.status === "VOIDED") throw new PayPalError("Authorization was voided", 422, "AUTHORIZATION_VOIDED");
    if (auth.status === "CAPTURED") throw new PayPalError("Authorization already fully captured", 422, "AUTHORIZATION_ALREADY_CAPTURED");
    if (Date.parse(auth.expiresAt) < Date.now()) throw new PayPalError("Authorization expired", 422, "AUTHORIZATION_EXPIRED");
    if (input.cents <= 0) throw new PayPalError("Capture amount must be positive", 422, "INVALID_PARAMETER_VALUE");
    if (auth.capturedCents + input.cents > auth.cents) {
      throw new PayPalError("Capture amount exceeds the authorized amount", 422, "MAX_CAPTURE_AMOUNT_EXCEEDED");
    }

    auth.capturedCents += input.cents;
    auth.status = input.finalCapture || auth.capturedCents === auth.cents ? "CAPTURED" : "PARTIALLY_CAPTURED";
    this.put("authorization", auth.id, auth);

    const capture: SimCapture = { id: newId("SIMCAP").toUpperCase(), authorizationId, cents: input.cents, refundedCents: 0 };
    this.put("capture", capture.id, capture);
    this.put("capture", `key:${input.idempotencyKey}`, capture);
    return { captureId: capture.id, status: "COMPLETED" };
  }

  async reauthorize(authorizationId: string, cents: number) {
    const auth = this.authorization(authorizationId);
    if (auth.reauthorized) throw new PayPalError("Authorization can be reauthorized only once", 422, "MAX_NUMBER_OF_REAUTHORIZATIONS_REACHED");
    if (auth.status === "VOIDED" || auth.status === "CAPTURED") throw new PayPalError("Authorization is not active", 422, "AUTHORIZATION_ALREADY_CAPTURED");
    auth.status = "REAUTHORIZED";
    this.put("authorization", auth.id, auth);
    const next = this.newAuthorization(cents);
    const stored = this.authorization(next.authorizationId);
    stored.reauthorized = true;
    this.put("authorization", stored.id, stored);
    return next;
  }

  async voidAuthorization(authorizationId: string) {
    const auth = this.authorization(authorizationId);
    if (auth.capturedCents > 0) {
      throw new PayPalError("Authorization has been previously captured and hence cannot be voided", 422, "PREVIOUSLY_CAPTURED");
    }
    if (auth.status === "VOIDED") return;
    auth.status = "VOIDED";
    this.put("authorization", auth.id, auth);
    this.sendVoided(auth);
  }

  /**
   * Acts out an authorization reaching the end of its validity. PayPal then voids it, even after
   * partial captures, and reports it as PAYMENT.AUTHORIZATION.VOIDED.
   */
  expireAuthorization(authorizationId: string) {
    const auth = this.authorization(authorizationId);
    if (auth.status === "VOIDED" || auth.status === "CAPTURED") return;
    auth.status = "VOIDED";
    auth.expiresAt = new Date().toISOString();
    this.put("authorization", auth.id, auth);
    this.sendVoided(auth);
  }

  // ---------------------------------------------------------------- webhooks

  /** Where simulated webhooks go. Without a target, none are sent. */
  deliverWebhooksTo(target: (delivery: WebhookDelivery) => unknown) {
    this.webhookTarget = target;
  }

  /** Resolves once every webhook sent so far has been handled. For tests. */
  async webhooksSettled() {
    while (this.deliveries.size) await Promise.all([...this.deliveries]);
  }

  /** A webhook body with headers signed the simulator's way. */
  signWebhook(event: object): WebhookDelivery {
    const body = JSON.stringify(event);
    const id = newId("simtx");
    const time = new Date().toISOString();
    return {
      body,
      headers: {
        "content-type": "application/json",
        "paypal-auth-algo": "SIM-HMAC-SHA256",
        "paypal-transmission-id": id,
        "paypal-transmission-time": time,
        "paypal-transmission-sig": this.signature(id, time, body),
      },
    };
  }

  async verifyWebhook({ headers, body }: WebhookDelivery) {
    const id = headers["paypal-transmission-id"];
    const time = headers["paypal-transmission-time"];
    const sig = headers["paypal-transmission-sig"];
    if (!id || !time || !sig || headers["paypal-auth-algo"] !== "SIM-HMAC-SHA256") return false;
    const expected = Buffer.from(this.signature(id, time, body));
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private signature(id: string, time: string, body: string) {
    return createHmac("sha256", this.webhookKey).update(`${id}|${time}|${body}`).digest("base64");
  }

  private sendVoided(auth: SimAuthorization) {
    this.sendWebhook("PAYMENT.AUTHORIZATION.VOIDED", "authorization", `Authorization ${auth.id} voided`, {
      id: auth.id,
      status: "VOIDED",
      amount: { currency_code: "USD", value: toValue(auth.cents) },
      expiration_time: auth.expiresAt,
    });
  }

  /** Sends after the current call returns, as PayPal does, so the caller isn't held up. */
  private sendWebhook(eventType: string, resourceType: string, summary: string, resource: object) {
    const target = this.webhookTarget;
    if (!target) return;
    const delivery = this.signWebhook({
      id: newId("WH-SIM").toUpperCase(),
      event_version: "1.0",
      create_time: new Date().toISOString(),
      resource_type: resourceType,
      resource_version: "2.0",
      event_type: eventType,
      summary,
      resource,
    });
    const sent: Promise<void> = Promise.resolve()
      .then(() => target(delivery))
      .then(
        () => undefined,
        (err) => console.error("simulated webhook:", err),
      )
      .finally(() => this.deliveries.delete(sent));
    this.deliveries.add(sent);
  }

  async refund(captureId: string, cents: number, idempotencyKey: string) {
    const existing = this.get<{ id: string }>("capture", `refund:${idempotencyKey}`);
    if (existing) return { refundId: existing.id };
    const capture = this.get<SimCapture>("capture", captureId);
    if (!capture) throw new PayPalError("Capture not found", 404, "RESOURCE_NOT_FOUND");
    if (capture.refundedCents + cents > capture.cents) {
      throw new PayPalError("Refund exceeds the captured amount", 422, "REFUND_AMOUNT_EXCEEDED");
    }
    capture.refundedCents += cents;
    this.put("capture", capture.id, capture);
    const refund = { id: newId("SIMREF").toUpperCase() };
    this.put("capture", `refund:${idempotencyKey}`, refund);
    return { refundId: refund.id };
  }

  private newAuthorization(cents: number): Authorization {
    const auth: SimAuthorization = {
      id: newId("SIMAUTH").toUpperCase(),
      cents,
      capturedCents: 0,
      status: "CREATED",
      expiresAt: new Date(Date.now() + AUTHORIZATION_MS).toISOString(),
      reauthorized: false,
    };
    this.put("authorization", auth.id, auth);
    return { authorizationId: auth.id, cents, expiresAt: auth.expiresAt };
  }

  private order(id: string): SimOrder {
    const order = this.get<SimOrder>("order", id);
    if (!order) throw new PayPalError("Order not found", 404, "RESOURCE_NOT_FOUND");
    return order;
  }

  private authorization(id: string): SimAuthorization {
    const auth = this.get<SimAuthorization>("authorization", id);
    if (!auth) throw new PayPalError("Authorization not found", 404, "RESOURCE_NOT_FOUND");
    return auth;
  }

  private get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM sim_paypal WHERE kind = ? AND id = ?").get(kind, id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  private put(kind: string, id: string, data: unknown) {
    this.db
      .prepare("INSERT INTO sim_paypal (id, kind, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(id, kind, JSON.stringify(data));
  }
}

/** Still waiting for the buyer. CREATED is what orders made before PAYER_ACTION_REQUIRED was modelled still say. */
export function isWaiting(order: SimOrder) {
  return order.status === "PAYER_ACTION_REQUIRED" || order.status === "CREATED";
}

export interface SimOrder {
  id: string;
  /** The Remit request this order is for. Older simulated orders don't have it. */
  referenceId?: string;
  status: "PAYER_ACTION_REQUIRED" | "CREATED" | "APPROVED" | "COMPLETED" | "VOIDED";
  /** The simulated page refused the payment method at least once. */
  declined?: boolean;
  description: string;
  items: { name: string; description: string; cents: number }[];
  totalCents: number;
  returnUrl: string;
  cancelUrl: string;
}

/** The parts of an order PayPal puts in a checkout-order webhook. */
function orderResource(order: SimOrder) {
  return {
    id: order.id,
    intent: "AUTHORIZE",
    status: order.status,
    purchase_units: [
      {
        reference_id: order.referenceId,
        custom_id: order.referenceId,
        amount: { currency_code: "USD", value: toValue(order.totalCents) },
      },
    ],
  };
}

interface SimAuthorization {
  id: string;
  cents: number;
  capturedCents: number;
  status: "CREATED" | "PARTIALLY_CAPTURED" | "CAPTURED" | "VOIDED" | "REAUTHORIZED";
  expiresAt: string;
  reauthorized: boolean;
}

interface SimCapture {
  id: string;
  authorizationId: string;
  cents: number;
  refundedCents: number;
}
