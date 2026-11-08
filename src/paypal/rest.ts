import { randomUUID } from "node:crypto";
import { fromValue, toValue } from "../money.ts";
import {
  AUTHORIZATION_MS,
  PayPalError,
  type Authorization,
  type CaptureInput,
  type CreateOrderInput,
  type PayPalGateway,
  type WebhookDelivery,
} from "./gateway.ts";

/** PayPal Orders v2 and Payments v2 over REST, against the sandbox. */
export class RestPayPal implements PayPalGateway {
  readonly mode = "sandbox" as const;
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly opts: { clientId: string; clientSecret: string; baseUrl: string; currency: string; webhookId?: string },
  ) {}

  async createAuthorizeOrder(input: CreateOrderInput) {
    const total = input.items.reduce((sum, item) => sum + item.cents, 0);
    const money = (cents: number) => ({ currency_code: this.opts.currency, value: toValue(cents) });
    const order = await this.call<PayPalOrder>("POST", "/v2/checkout/orders", {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.referenceId,
          description: clip(input.description, 127),
          amount: { ...money(total), breakdown: { item_total: money(total) } },
          items: input.items.map((item) => ({
            name: clip(item.name, 127),
            description: clip(item.description, 127),
            quantity: "1",
            unit_amount: money(item.cents),
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Remit",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        },
      },
    });
    const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!link) throw new PayPalError("PayPal returned no approval link", 500);
    return { orderId: order.id, approveUrl: link.href };
  }

  async getOrderStatus(orderId: string) {
    const order = await this.call<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    return order.status;
  }

  async authorizeOrder(orderId: string): Promise<Authorization> {
    const order = await this.call<PayPalOrder>(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
      {},
      `authorize-${orderId}`,
    );
    const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalError("PayPal returned no authorization", 500);
    return toAuthorization(auth);
  }

  async capture(authorizationId: string, input: CaptureInput) {
    const capture = await this.call<{ id: string; status: string }>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
      {
        amount: { currency_code: this.opts.currency, value: toValue(input.cents) },
        final_capture: input.finalCapture,
        note_to_payer: clip(input.note, 255),
      },
      input.idempotencyKey,
    );
    return { captureId: capture.id, status: capture.status };
  }

  async reauthorize(authorizationId: string, cents: number) {
    const auth = await this.call<PayPalAuthorization>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`,
      { amount: { currency_code: this.opts.currency, value: toValue(cents) } },
      `reauthorize-${authorizationId}`,
    );
    return toAuthorization(auth);
  }

  async voidAuthorization(authorizationId: string) {
    await this.call(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
      undefined,
      `void-${authorizationId}`,
    );
  }

  async refund(captureId: string, cents: number, idempotencyKey: string) {
    const refund = await this.call<{ id: string }>(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      { amount: { currency_code: this.opts.currency, value: toValue(cents) } },
      idempotencyKey,
    );
    return { refundId: refund.id };
  }

  async verifyWebhook({ headers, body }: WebhookDelivery) {
    if (!this.opts.webhookId) return false;
    const fields = {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: this.opts.webhookId,
    };
    if (Object.values(fields).some((v) => !v)) return false;
    // Send the event exactly as received: parsing and re-serializing it can change the bytes and fail the check.
    const raw = `${JSON.stringify(fields).slice(0, -1)},"webhook_event":${body}}`;
    const result = await this.call<{ verification_status?: string }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      undefined,
      undefined,
      raw,
    );
    return result.verification_status === "SUCCESS";
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await fetch(`${this.opts.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError(`PayPal sign-in failed (${res.status}). Check the client ID and secret.`, res.status);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown, requestId?: string, rawBody?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "PayPal-Request-Id": requestId ?? randomUUID(),
    };
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = json.details?.[0];
      throw new PayPalError(
        detail?.description ?? json.message ?? `PayPal ${method} ${path} failed (${res.status})`,
        res.status,
        detail?.issue ?? json.name,
        json.debug_id,
      );
    }
    return json as T;
  }
}

interface PayPalOrder {
  id: string;
  status: string;
  links?: { rel: string; href: string }[];
  purchase_units?: { payments?: { authorizations?: PayPalAuthorization[] } }[];
}

interface PayPalAuthorization {
  id: string;
  status: string;
  amount: { value: string };
  expiration_time?: string;
}

function toAuthorization(auth: PayPalAuthorization): Authorization {
  return {
    authorizationId: auth.id,
    cents: fromValue(auth.amount.value),
    expiresAt: auth.expiration_time ?? new Date(Date.now() + AUTHORIZATION_MS).toISOString(),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
