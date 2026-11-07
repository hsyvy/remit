import type { Db } from "../db.ts";
import { newId } from "../db.ts";
import {
  AUTHORIZATION_MS,
  PayPalError,
  type Authorization,
  type CaptureInput,
  type CreateOrderInput,
  type PayPalGateway,
} from "./gateway.ts";

/**
 * A local stand-in for the PayPal sandbox, so the app runs end to end before credentials exist.
 * It enforces the same limits the brief relies on: no authorize before approval, no capture above
 * the hold (MAX_CAPTURE_AMOUNT_EXCEEDED), and no void after a capture (PREVIOUSLY_CAPTURED).
 * The owner approves on /sim-paypal/checkout/:orderId, which is clearly labelled as a simulation.
 */
export class SimulatedPayPal implements PayPalGateway {
  readonly mode = "simulated" as const;

  constructor(
    private readonly db: Db,
    private readonly appUrl: string,
  ) {}

  async createAuthorizeOrder(input: CreateOrderInput) {
    const order: SimOrder = {
      id: newId("SIMORDER").toUpperCase(),
      status: "CREATED",
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
    if (order.status === "CREATED") {
      order.status = "APPROVED";
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

export interface SimOrder {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  description: string;
  items: { name: string; description: string; cents: number }[];
  totalCents: number;
  returnUrl: string;
  cancelUrl: string;
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
