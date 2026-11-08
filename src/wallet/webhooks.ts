import { nowIso, type Db } from "../db.ts";
import { fromValue } from "../money.ts";
import { PayPalError, type WebhookDelivery } from "../paypal/gateway.ts";
import { errorText, WalletError, type Wallet } from "./wallet.ts";

/** How long an event may stay "handling" before a redelivery takes it over. Handling takes a few seconds at most. */
const STALE_CLAIM_MS = 2 * 60_000;

export interface WebhookResult {
  status: 200 | 400;
  eventId?: string;
  /** What the wallet did with the event. */
  action: string;
  duplicate?: boolean;
}

/**
 * PayPal webhooks: verify the event, record its id once, then let the wallet act on it.
 * Asking PayPal (wallet.checkApprovals) stays as the fallback for anything missed.
 */
export class PayPalWebhooks {
  constructor(
    private readonly db: Db,
    private readonly wallet: Wallet,
  ) {}

  async receive(delivery: WebhookDelivery): Promise<WebhookResult> {
    let event: PayPalEvent;
    try {
      event = JSON.parse(delivery.body) as PayPalEvent;
    } catch {
      return { status: 400, action: "Not JSON. Nothing changed." };
    }
    if (!event || typeof event.id !== "string" || typeof event.event_type !== "string") {
      return { status: 400, action: "Not a PayPal event. Nothing changed." };
    }
    // Verify before anything else. If PayPal can't be reached this throws, and PayPal sends the event again later.
    if (!(await this.wallet.paypal.verifyWebhook(delivery))) {
      return { status: 400, eventId: event.id, action: "Signature not verified. Nothing changed." };
    }

    const resource = event.resource ?? {};
    const resourceId = typeof resource.id === "string" ? resource.id : null;
    // Claim the event id first, so a redelivery (even one arriving while this one runs) is ignored.
    const claimed = this.db
      .prepare("INSERT OR IGNORE INTO paypal_events (id, type, resource_id, received_at, action) VALUES (?, ?, ?, ?, 'handling')")
      .run(event.id, event.event_type, resourceId, nowIso());
    // A claim still "handling" after STALE_CLAIM_MS means the server stopped mid-event (a restart or a crash):
    // take it over, or PayPal's retries would be ignored for good.
    const retaken =
      claimed.changes === 0 &&
      this.db
        .prepare("UPDATE paypal_events SET received_at = ? WHERE id = ? AND action = 'handling' AND received_at < ?")
        .run(nowIso(), event.id, new Date(Date.now() - STALE_CLAIM_MS).toISOString()).changes === 1;
    if (claimed.changes === 0 && !retaken) {
      const seen = this.db.prepare("SELECT action FROM paypal_events WHERE id = ?").get(event.id) as { action: string };
      return { status: 200, eventId: event.id, duplicate: true, action: `Already received: ${seen.action}` };
    }

    let action: string;
    try {
      action = await this.handle(event.event_type, resource);
    } catch (err) {
      // PayPal unreachable or something unexpected: forget the event, so PayPal's retry gets handled.
      if (!(err instanceof WalletError) && !(err instanceof PayPalError && err.status < 500)) {
        this.db.prepare("DELETE FROM paypal_events WHERE id = ?").run(event.id);
        throw err;
      }
      action = `Failed: ${errorText(err)}`;
    }
    this.db.prepare("UPDATE paypal_events SET action = ? WHERE id = ?").run(action, event.id);
    return { status: 200, eventId: event.id, action };
  }

  private async handle(type: string, r: PayPalResource): Promise<string> {
    const id = typeof r.id === "string" ? r.id : "";
    switch (type) {
      case "CHECKOUT.ORDER.APPROVED":
        return this.wallet.approvedOnPayPal(id);
      // PayPal lists DECLINED for some payment methods. Its event list has no order-voided event,
      // but if one comes it means the same as the watcher seeing a VOIDED order.
      case "CHECKOUT.ORDER.DECLINED":
        return this.wallet.notApprovedOnPayPal(id, "not_approved", typeof r.status === "string" ? r.status : "DECLINED");
      case "CHECKOUT.ORDER.VOIDED":
        return this.wallet.notApprovedOnPayPal(id, "voided", "VOIDED");
      // PayPal hit a problem after the buyer approved but before the payment was captured.
      case "CHECKOUT.PAYMENT-APPROVAL.REVERSED":
        return this.wallet.notApprovedOnPayPal(typeof r.order_id === "string" ? r.order_id : id, "voided", "REVERSED", "PayPal reversed the approval");
      // Sent for a manual void and when an authorization reaches the end of its validity.
      case "PAYMENT.AUTHORIZATION.VOIDED":
        return this.wallet.voidedOnPayPal(id);
      case "PAYMENT.CAPTURE.REFUNDED":
      case "PAYMENT.CAPTURE.REVERSED":
      case "PAYMENT.CAPTURE.DECLINED":
      case "PAYMENT.CAPTURE.DENIED":
        return this.wallet.captureNewsFromPayPal(type, captureIdOf(r), centsOf(r));
      default:
        return "Not an event Remit acts on. Recorded and ignored.";
    }
  }
}

/** A refund or reversal links back to its capture with rel "up"; capture events carry the capture itself. */
function captureIdOf(r: PayPalResource): string {
  const up = r.links?.find((l) => l.rel === "up" && /\/captures\//.test(l.href ?? ""));
  const match = up?.href?.match(/\/captures\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : typeof r.id === "string" ? r.id : "";
}

function centsOf(r: PayPalResource): number | null {
  const value = r.amount?.value;
  if (typeof value !== "string" || !Number.isFinite(Number(value))) return null;
  return Math.abs(fromValue(value));
}

interface PayPalEvent {
  id: string;
  event_type: string;
  resource?: PayPalResource;
}

interface PayPalResource {
  id?: unknown;
  status?: unknown;
  order_id?: unknown;
  amount?: { value?: unknown };
  links?: { rel?: string; href?: string }[];
}
