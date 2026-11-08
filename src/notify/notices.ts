import { fmt } from "../money.ts";
import { errorText, type Wallet, type WalletEvent } from "../wallet/wallet.ts";
import type { LinkSigner } from "./links.ts";
import type { Notice, Notifier } from "./notifier.ts";

/** The plan link in a recap stays good a little longer: a recap is often read later. */
const PLAN_LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_BODY_LINES = 6;

export interface NotificationOptions {
  appUrl: string;
  /** True when the demo agent can plan the next budget; the recap then carries a "Plan next week" link. */
  canPlan?: () => boolean;
  log?: (message: string) => void;
}

/**
 * Turns wallet events into notices for the owner: a request waiting for them, a refused purchase,
 * and the recap when a period closes. Sending happens in the background; a failure is logged and
 * never reaches the wallet.
 */
export class Notifications {
  private readonly inflight = new Set<Promise<void>>();
  private readonly log: (message: string) => void;

  constructor(
    private readonly wallet: Wallet,
    readonly notifier: Notifier,
    private readonly links: LinkSigner,
    private readonly opts: NotificationOptions,
  ) {
    this.log = opts.log ?? ((m) => console.error(m));
  }

  /** Pass as WalletOptions.onEvent. */
  readonly onEvent = (event: WalletEvent): void => {
    let notice: Notice | null;
    try {
      notice = this.build(event);
    } catch (err) {
      this.log(`notify: couldn't build a notice for ${event.type}: ${errorText(err)}`);
      return;
    }
    if (!notice) return;
    const sent = this.notifier
      .send(notice)
      .catch((err) => this.log(`notify: ${this.notifier.name} failed to send "${notice.title}": ${errorText(err)}`))
      .finally(() => this.inflight.delete(sent));
    this.inflight.add(sent);
  };

  /** Resolves once every notice started so far has been sent or has failed. For tests and shutdown. */
  async idle() {
    // Events reach onEvent in a microtask, so let those run first.
    await new Promise((resolve) => setImmediate(resolve));
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  build(event: WalletEvent): Notice | null {
    if (!event.periodId) return null;
    switch (event.type) {
      case "budget_requested":
        return this.requestNotice(event.periodId, "budget");
      case "topup_requested":
        return this.requestNotice(event.periodId, "topup");
      case "spend_refused":
        return this.refusalNotice(event);
      case "closed":
        // A period closed before anything was approved has nothing to recap.
        return this.wallet.periodRecap(event.periodId).approvedCents ? this.recapNotice(event.periodId) : null;
      default:
        return null;
    }
  }

  linkUrl(code: string) {
    return `${this.opts.appUrl}/link/${code}`;
  }

  private requestNotice(periodId: string, kind: "budget" | "topup"): Notice | null {
    // Only one budget request, and one top-up, can wait per period, so this finds the one just made.
    const pending = this.wallet.pendingRequests(periodId).filter((r) => r.kind === kind && r.status === "pending");
    const summary = pending.at(-1);
    if (!summary) return null;
    const r = this.wallet.requestDetail(summary.id);
    const approve = this.linkUrl(this.links.sign("approve", r.id));
    const decline = this.linkUrl(this.links.sign("decline", r.id));

    let title: string;
    const body: string[] = [];
    if (r.kind === "budget") {
      title = `Approve ${fmt(r.totalCents)} for ${dateRange(r.period.startsOn, r.period.endsOn)}?`;
      body.push(`Your agent asks for a budget: ${r.reason}`);
      body.push(...capped(r.lines.map((l) => `${l.label}: ${fmt(l.amountCents)}. ${l.reason}`)));
    } else {
      const line = r.lines[0]!;
      title = `Approve ${fmt(r.totalCents)} more for ${line.label}?`;
      body.push(line.reason);
      const now = line.current?.limitCents ?? 0;
      body.push(`${line.label} has ${fmt(now)} now, ${fmt(now + line.amountCents)} after.`);
    }
    body.push("Approving opens PayPal to place the hold.");

    return {
      kind: "request",
      title,
      body: body.join("\n"),
      url: approve,
      actions: [
        { label: "Approve", url: approve },
        { label: "Decline", url: decline },
        { label: "Open Remit", url: `${this.opts.appUrl}/#${r.id}` },
      ],
      priority: "high",
      data: {
        event: kind === "budget" ? "budget_requested" : "topup_requested",
        requestId: r.id,
        kind: r.kind,
        totalCents: r.totalCents,
        reason: r.reason,
        period: r.period,
        lines: r.lines.map((l) => ({ key: l.key, label: l.label, amountCents: l.amountCents, reason: l.reason })),
        links: { approve, decline, expiresInHours: Math.round(this.links.ttlMs / 3_600_000) },
      },
    };
  }

  private refusalNotice(event: WalletEvent): Notice {
    const refusal = this.wallet.periodRecap(event.periodId!).refusals.at(-1);
    const ledger = `${this.opts.appUrl}/#ledger`;
    return {
      kind: "refusal",
      title: refusal ? `Refused ${fmt(refusal.amountCents)} for "${clip(refusal.title, 60)}"` : "A purchase was refused",
      // The refusal text goes on to coach the agent; the owner needs only its first sentence.
      body: refusal ? `${firstSentence(refusal.reason)}\nMerchant: ${refusal.merchant}. Line: ${refusal.lineKey}.` : event.message,
      url: ledger,
      actions: [{ label: "Open ledger", url: ledger }],
      priority: "default",
      data: { event: "spend_refused", periodId: event.periodId, message: event.message, refusal: refusal ?? null },
    };
  }

  private recapNotice(periodId: string): Notice {
    const recap = this.wallet.periodRecap(periodId);
    const range = dateRange(recap.period.startsOn, recap.period.endsOn);
    const body: string[] = [];
    body.push(...capped(recap.lines.map((l) => `${l.label}: spent ${fmt(l.spentCents)} of ${fmt(l.approvedCents)}`)));
    if (recap.refundedCents) body.push(`Refunded to you: ${fmt(recap.refundedCents)}.`);
    if (recap.refusals.length) {
      const total = recap.refusals.reduce((sum, r) => sum + r.amountCents, 0);
      const first = recap.refusals.slice(0, 2).map((r) => `"${clip(r.title, 40)}" ${fmt(r.amountCents)}`);
      const more = recap.refusals.length > 2 ? `, and ${recap.refusals.length - 2} more` : "";
      body.push(`Refused ${recap.refusals.length} (${fmt(total)}): ${first.join(", ")}${more}.`);
    } else {
      body.push("No purchases refused.");
    }
    const released: string[] = [];
    if (recap.releasedCents) released.push(`${fmt(recap.releasedCents)} released to you now`);
    if (recap.lapsingCents) released.push(`${fmt(recap.lapsingCents)} released when PayPal's hold expires on ${dateRange(recap.lapsesOn!, recap.lapsesOn!)}`);
    body.push(released.length ? `${capitalize(released.join("; "))}.` : "Nothing was left to release.");

    const app = `${this.opts.appUrl}/#ledger`;
    const actions = [{ label: "Open Remit", url: app }];
    const plan = this.opts.canPlan?.() ? this.linkUrl(this.links.sign("plan", periodId, PLAN_LINK_TTL_MS)) : null;
    if (plan) {
      actions.push({ label: "Plan next week", url: plan });
      body.push("Tap Plan next week to have your agent draft the next budget for you to approve.");
    }

    return {
      kind: "recap",
      title: `${range} closed: spent ${fmt(recap.spentCents)} of ${fmt(recap.approvedCents)}`,
      body: body.join("\n"),
      url: app,
      actions,
      priority: "default",
      data: { event: "closed", ...recap, links: { app, plan } },
    };
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 9 – 15", or "Nov 28 – Dec 4" across months. */
export function dateRange(startsOn: string, endsOn: string) {
  const [, sm, sd] = startsOn.split("-").map(Number) as [number, number, number];
  const [, em, ed] = endsOn.split("-").map(Number) as [number, number, number];
  if (startsOn === endsOn) return `${MONTHS[sm - 1]} ${sd}`;
  return sm === em ? `${MONTHS[sm - 1]} ${sd} – ${ed}` : `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}`;
}

function capped(lines: string[]) {
  if (lines.length <= MAX_BODY_LINES) return lines;
  return [...lines.slice(0, MAX_BODY_LINES - 1), `and ${lines.length - MAX_BODY_LINES + 1} more lines`];
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstSentence(text: string) {
  return text.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? text;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
