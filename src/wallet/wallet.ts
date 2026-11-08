import { newId, tx, type Db } from "../db.ts";
import { fmt } from "../money.ts";
import { HONOR_PERIOD_MS, PayPalError, type PayPalGateway } from "../paypal/gateway.ts";

/**
 * The wallet owns every money rule. The agent (in-process or over MCP) can only call
 * requestBudget, requestTopup, spend, balance and history; approvals come back from PayPal.
 * Moving money between lines is the owner's alone.
 */

export class WalletError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export interface Reviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}

export interface ReviewInput {
  line: { label: string; reason: string };
  purchase: { title: string; merchant: string; url?: string; amountCents: number; reasoning: string };
}

export interface ReviewResult {
  verdict: "approve" | "reject" | "skipped";
  reason: string;
}

export interface PlanLineInput {
  key: string;
  label: string;
  amountCents: number;
  reason: string;
}

export interface BudgetRequestInput {
  summary: string;
  startsOn: string;
  endsOn: string;
  lines: PlanLineInput[];
  buffer?: { amountCents: number; reason: string };
}

export interface TopupInput {
  lineKey: string;
  label?: string;
  amountCents: number;
  reason: string;
}

export interface SpendInput {
  lineKey: string;
  amountCents: number;
  title: string;
  merchant: string;
  url?: string;
  reasoning: string;
  agent: "remit" | "mcp";
}

/** What PayPal last said about an order the owner went to approve but didn't finish. */
export interface ApprovalCheck {
  /** not_approved: PayPal is still waiting (refused card or abandoned page). voided: PayPal dropped the order. failed: authorizing it failed. */
  state: "not_approved" | "voided" | "failed";
  paypalStatus: string;
  detail?: string;
  checkedAt: string;
}

export type ApprovalOutcome = "approved" | ApprovalCheck["state"] | "skipped" | "unknown";

export const BUFFER_KEY = "buffer";
const LINE_KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERIOD_DAYS = 28;
// A reason the owner can check needs a few words of evidence; "needed" or "food" is not one.
const MIN_REASON_CHARS = 15;
const MIN_REASON_WORDS = 3;
const LIVE = "('pending','captured','refunded')";
/** Ask PayPal about the same order at most this often, so reloading the app doesn't hammer it. */
const APPROVAL_CHECK_MS = 15_000;

export interface WalletOptions {
  appUrl: string;
  maxRequestCents: number;
  reviewer?: Reviewer;
  now?: () => Date;
}

export class Wallet {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Db,
    readonly paypal: PayPalGateway,
    private readonly opts: WalletOptions,
  ) {}

  // ---------------------------------------------------------------- agent: budget requests

  requestBudget(input: BudgetRequestInput) {
    const current = this.currentPeriod();
    if (current?.status === "open") {
      throw new WalletError("PERIOD_OPEN", `A budget is already open until ${current.ends_on}. Use request_topup for extra money.`);
    }
    if (current?.status === "pending") {
      throw new WalletError("REQUEST_PENDING", "A budget request is already waiting for the owner's approval.");
    }
    const summary = requireText(input.summary, "summary", 300);
    if (!DATE.test(input.startsOn) || !DATE.test(input.endsOn)) throw new WalletError("BAD_DATES", "Dates must be YYYY-MM-DD.");
    const today = this.today();
    if (input.endsOn < input.startsOn) throw new WalletError("BAD_DATES", "ends_on is before starts_on.");
    if (input.startsOn < addDays(today, -1)) throw new WalletError("BAD_DATES", "The period can't start in the past.");
    if (input.endsOn > addDays(today, MAX_PERIOD_DAYS)) {
      throw new WalletError("BAD_DATES", `The period must end within ${MAX_PERIOD_DAYS} days, so it fits inside one PayPal hold.`);
    }
    if (!input.lines.length || input.lines.length > 12) throw new WalletError("BAD_LINES", "A plan needs 1 to 12 lines.");

    const lines = input.lines.map((line) => checkLine(line));
    if (input.buffer && input.buffer.amountCents > 0) {
      lines.push(checkLine({ key: BUFFER_KEY, label: "Buffer", amountCents: input.buffer.amountCents, reason: input.buffer.reason }));
    }
    const keys = new Set(lines.map((l) => l.key));
    if (keys.size !== lines.length) throw new WalletError("BAD_LINES", "Each line needs a different key.");
    if (input.lines.some((l) => l.key === BUFFER_KEY)) throw new WalletError("BAD_LINES", `"${BUFFER_KEY}" is reserved; pass the buffer separately.`);
    const total = lines.reduce((sum, l) => sum + l.amountCents, 0);
    this.checkRequestSize(total);

    const periodId = newId("per");
    const requestId = newId("req");
    tx(this.db, () => {
      this.db
        .prepare("INSERT INTO periods (id, summary, starts_on, ends_on, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
        .run(periodId, summary, input.startsOn, input.endsOn, this.iso());
      this.insertRequest(requestId, periodId, "budget", summary, lines);
      this.event(periodId, "budget_requested", `Agent asked for ${fmt(total)} for ${input.startsOn} to ${input.endsOn}.`);
    });
    return { requestId, periodId, totalCents: total, status: "waiting_for_owner" as const, reviewUrl: `${this.opts.appUrl}/#${requestId}` };
  }

  requestTopup(input: TopupInput) {
    const period = this.openPeriod();
    const pending = this.db
      .prepare("SELECT id FROM requests WHERE period_id = ? AND kind = 'topup' AND status IN ('pending','checkout')")
      .get(period.id);
    if (pending) throw new WalletError("REQUEST_PENDING", "A top-up is already waiting for the owner. Wait for their decision.");

    const existing = this.envelope(period.id, input.lineKey);
    const label = existing?.label ?? input.label;
    if (!label) throw new WalletError("BAD_LINES", `There is no line "${input.lineKey}". Give a label to add it as a new line.`);
    const line = checkLine({ key: input.lineKey, label, amountCents: input.amountCents, reason: input.reason });
    this.checkRequestSize(line.amountCents);

    const requestId = newId("req");
    tx(this.db, () => {
      this.insertRequest(requestId, period.id, "topup", line.reason, [line]);
      this.event(period.id, "topup_requested", `Agent asked for ${fmt(line.amountCents)} more for "${label}": ${line.reason}`);
    });
    return { requestId, totalCents: line.amountCents, status: "waiting_for_owner" as const, reviewUrl: `${this.opts.appUrl}/#${requestId}` };
  }

  // ---------------------------------------------------------------- owner: approval on PayPal

  /** The owner sends a request to PayPal, with any lines removed or resized. Returns PayPal's approval page. */
  async checkout(requestId: string, edits: { lineId: string; amountCents: number }[] = []) {
    const request = this.request(requestId);
    if (request.status !== "pending" && request.status !== "checkout") {
      throw new WalletError("NOT_PENDING", `This request is already ${request.status}.`);
    }
    const lines = this.requestLines(requestId);
    const editById = new Map(edits.map((e) => [e.lineId, e.amountCents]));
    for (const id of editById.keys()) {
      if (!lines.some((l) => l.id === id)) throw new WalletError("BAD_LINES", `Unknown line ${id}.`);
    }
    const approved = lines.map((l) => {
      const cents = editById.get(l.id) ?? l.approved_cents ?? l.amount_cents;
      if (!Number.isInteger(cents) || cents < 0) throw new WalletError("BAD_AMOUNT", "Amounts must be zero or more.");
      return { ...l, approved_cents: cents };
    });
    const kept = approved.filter((l) => l.approved_cents > 0);
    if (!kept.length) throw new WalletError("BAD_LINES", "Nothing left to approve. Decline the request instead.");
    const total = kept.reduce((sum, l) => sum + l.approved_cents, 0);
    this.checkRequestSize(total);

    const period = this.period(request.period_id);
    const { orderId, approveUrl } = await this.paypal.createAuthorizeOrder({
      referenceId: requestId,
      description: request.kind === "budget" ? `Remit budget ${period.starts_on} to ${period.ends_on}` : `Remit top-up: ${request.reason}`,
      items: kept.map((l) => ({ name: l.label, description: l.reason, cents: l.approved_cents })),
      returnUrl: `${this.opts.appUrl}/paypal/return?request=${requestId}`,
      cancelUrl: `${this.opts.appUrl}/paypal/cancel?request=${requestId}`,
    });
    tx(this.db, () => {
      const update = this.db.prepare("UPDATE request_lines SET approved_cents = ? WHERE id = ?");
      for (const l of approved) update.run(l.approved_cents, l.id);
      // A new order starts with a clean slate: an earlier "PayPal didn't approve" was about the old one.
      this.db.prepare("UPDATE requests SET status = 'checkout', paypal_order_id = ?, approval_check = NULL WHERE id = ?").run(orderId, requestId);
    });
    return { orderId, approveUrl, totalCents: total };
  }

  /**
   * PayPal sent the owner back. We don't trust the redirect itself: authorizing the order only
   * succeeds if the owner really approved it on PayPal.
   */
  completeApproval(requestId: string, orderId: string) {
    return this.serial(async () => {
      const request = this.request(requestId);
      if (request.status === "approved") return { alreadyApproved: true };
      if (request.status !== "checkout" || request.paypal_order_id !== orderId) {
        throw new WalletError("NOT_IN_CHECKOUT", "This PayPal order doesn't match a request waiting for approval.");
      }
      const auth = await this.paypal.authorizeOrder(orderId);
      const lines = this.requestLines(requestId).filter((l) => (l.approved_cents ?? 0) > 0);
      const now = this.now();
      tx(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO holds (id, period_id, request_id, authorization_id, amount_cents, status, authorized_at, honor_until, expires_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          )
          .run(newId("hold"), request.period_id, requestId, auth.authorizationId, auth.cents, now.toISOString(),
            new Date(now.getTime() + HONOR_PERIOD_MS).toISOString(), auth.expiresAt);
        for (const l of lines) {
          this.db
            .prepare(
              `INSERT INTO envelopes (id, period_id, line_key, label, reason, limit_cents) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(period_id, line_key) DO UPDATE SET limit_cents = limit_cents + excluded.limit_cents`,
            )
            .run(newId("env"), request.period_id, l.line_key, l.label, l.reason, l.approved_cents!);
        }
        this.db.prepare("UPDATE requests SET status = 'approved', decided_at = ? WHERE id = ?").run(now.toISOString(), requestId);
        this.db.prepare("UPDATE periods SET status = 'open' WHERE id = ? AND status = 'pending'").run(request.period_id);
        const what = request.kind === "budget" ? "budget" : "top-up";
        const where = this.paypal.mode === "sandbox" ? "on PayPal" : "on the simulated PayPal page";
        this.event(request.period_id, "approved", `You approved a ${fmt(auth.cents)} ${what} ${where}. Hold ${auth.authorizationId} placed.`);
      });
      return { alreadyApproved: false, holdCents: auth.cents };
    });
  }

  /**
   * Ask PayPal about requests still in checkout. The owner may have come back without approving
   * (PayPal refused the card, or they left), or approved while the redirect back got lost.
   * Run when the owner opens the app or returns from PayPal, not on every poll: each request is
   * checked at most once per APPROVAL_CHECK_MS unless `force` is set.
   */
  async checkApprovals(opts: { requestId?: string; force?: boolean } = {}) {
    const rows = (
      opts.requestId
        ? this.db.prepare("SELECT * FROM requests WHERE id = ? AND status = 'checkout'").all(opts.requestId)
        : this.db.prepare("SELECT * FROM requests WHERE status = 'checkout' ORDER BY created_at").all()
    ) as unknown as RequestRow[];
    const results: { requestId: string; outcome: ApprovalOutcome; check: ApprovalCheck | null }[] = [];
    for (const row of rows) {
      const last = parseCheck(row.approval_check);
      if (!row.paypal_order_id) continue;
      if (!opts.force && last && this.now().getTime() - Date.parse(last.checkedAt) < APPROVAL_CHECK_MS) {
        results.push({ requestId: row.id, outcome: "skipped", check: last });
        continue;
      }
      results.push({ requestId: row.id, ...(await this.checkApproval(row, last)) });
    }
    return results;
  }

  private async checkApproval(row: RequestRow, last: ApprovalCheck | null): Promise<{ outcome: ApprovalOutcome; check: ApprovalCheck | null }> {
    const orderId = row.paypal_order_id!;
    let paypalStatus: string;
    try {
      paypalStatus = await this.paypal.getOrderStatus(orderId);
    } catch {
      // Couldn't reach PayPal: keep what we knew, and try again next time.
      return { outcome: "unknown", check: last };
    }

    let check: ApprovalCheck;
    if (paypalStatus === "APPROVED" || paypalStatus === "COMPLETED") {
      // Approved on PayPal, but the owner never made it back to /paypal/return. Finish the normal way.
      // COMPLETED means an earlier authorize reached PayPal; the authorize call is idempotent, so retrying is safe.
      try {
        await this.completeApproval(row.id, orderId);
        return { outcome: "approved", check: null };
      } catch (err) {
        check = { state: "failed", paypalStatus, detail: errorText(err), checkedAt: this.iso() };
      }
    } else if (paypalStatus === "VOIDED") {
      check = { state: "voided", paypalStatus, checkedAt: this.iso() };
    } else {
      // CREATED, SAVED or PAYER_ACTION_REQUIRED: PayPal is still waiting for the buyer. That's also
      // what a refused card looks like: PayPal keeps the order open so the buyer can pick another way to pay.
      check = { state: "not_approved", paypalStatus, checkedAt: this.iso() };
    }

    // The request may have changed while PayPal answered (approved, declined, or sent to PayPal again).
    const current = this.request(row.id);
    if (current.status !== "checkout" || current.paypal_order_id !== orderId) return { outcome: "skipped", check: null };
    this.noteApprovalCheck(row, check, last);
    return { outcome: check.state, check };
  }

  /** Put what PayPal said on the request card, and log it when it changed. Used by the watcher and by webhooks. */
  private noteApprovalCheck(row: RequestRow, check: ApprovalCheck, last: ApprovalCheck | null) {
    tx(this.db, () => {
      this.db.prepare("UPDATE requests SET approval_check = ? WHERE id = ?").run(JSON.stringify(check), row.id);
      if (last?.state !== check.state) {
        const what = row.kind === "budget" ? "budget request" : "top-up";
        const total = fmt(this.requestLines(row.id).reduce((sum, l) => sum + (l.approved_cents ?? 0), 0));
        const message =
          check.state === "voided"
            ? `PayPal voided the ${total} ${what} before it was approved. Approve it again to start over.`
            : `PayPal didn't approve the ${total} ${what}${check.detail ? `: ${check.detail}` : ""}. It's still waiting for you.`;
        this.event(row.period_id, "approval_not_done", message);
      }
    });
  }

  // ---------------------------------------------------------------- PayPal webhooks
  // Called by src/wallet/webhooks.ts once an event is verified. Each returns a short note of what
  // the wallet did, which is stored with the event.

  /** CHECKOUT.ORDER.APPROVED: finish the approval exactly as the return redirect does. */
  async approvedOnPayPal(orderId: string): Promise<string> {
    const row = this.requestForOrder(orderId);
    if (!row) return "No request uses this order.";
    if (row.status === "approved") return `Request ${row.id} was already approved.`;
    // completeApproval runs one at a time and re-reads the request, so a redirect racing this can't place a second hold.
    const result = await this.completeApproval(row.id, orderId);
    return result.holdCents !== undefined ? `Approved request ${row.id}. Hold of ${fmt(result.holdCents)} placed.` : `Request ${row.id} was already approved.`;
  }

  /** An order PayPal declined or dropped: the same "PayPal didn't approve this" note the watcher puts on the card. */
  notApprovedOnPayPal(orderId: string, state: "not_approved" | "voided", paypalStatus: string, detail?: string): string {
    const row = this.requestForOrder(orderId);
    if (!row) return "No request uses this order.";
    if (row.status !== "checkout") return `Request ${row.id} is ${row.status}. Nothing changed.`;
    this.noteApprovalCheck(row, { state, paypalStatus, detail, checkedAt: this.iso() }, parseCheck(row.approval_check));
    return `Request ${row.id} marked ${state === "voided" ? "voided" : "not approved"} by PayPal.`;
  }

  /** PAYMENT.AUTHORIZATION.VOIDED: PayPal voided a hold, either on request or because it expired. */
  voidedOnPayPal(authorizationId: string): Promise<string> {
    return this.serial(async () => {
      const hold = this.db.prepare("SELECT * FROM holds WHERE authorization_id = ?").get(authorizationId) as unknown as HoldRow | undefined;
      if (!hold) return "No hold uses this authorization.";
      if (hold.status === "voided" || hold.status === "captured") return `Hold ${hold.id} was already ${hold.status}. Nothing changed.`;
      const left = hold.amount_cents - hold.captured_cents;
      const lapsed = hold.status === "lapsing";
      const note = lapsed ? `PayPal's hold expired. ${fmt(left)} released.` : `Voided by PayPal, ${fmt(left)} released.`;
      const message = lapsed
        ? `PayPal's hold ${authorizationId} expired. The last ${fmt(left)} is released back to you.`
        : `PayPal voided hold ${authorizationId}. ${fmt(left)} is released back to you and can't be spent.`;
      tx(this.db, () => {
        this.db.prepare("UPDATE holds SET status = 'voided', release_note = ? WHERE id = ?").run(note, hold.id);
        this.event(hold.period_id, "released", message);
      });
      return `Hold ${hold.id} ${lapsed ? "expired" : "voided"}. ${fmt(left)} released.`;
    });
  }

  /** PAYMENT.CAPTURE.REFUNDED, REVERSED, DECLINED or DENIED: put it on the ledger. Totals don't change here. */
  captureNewsFromPayPal(eventType: string, captureId: string, cents: number | null): string {
    const row = this.db
      .prepare("SELECT c.refund_id, c.amount_cents, p.period_id, p.title FROM captures c JOIN purchases p ON p.id = c.purchase_id WHERE c.capture_id = ?")
      .get(captureId) as { refund_id: string | null; amount_cents: number; period_id: string; title: string } | undefined;
    if (!row) return "No purchase uses this capture.";
    const amount = fmt(cents ?? row.amount_cents);
    let message: string;
    if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
      if (row.refund_id) return `Refund for "${row.title}" was already recorded.`;
      message = `PayPal reports a ${amount} refund for "${row.title}" that wasn't made in Remit.`;
    } else if (eventType === "PAYMENT.CAPTURE.REVERSED") {
      message = `PayPal reversed the ${amount} payment for "${row.title}".`;
    } else {
      message = `PayPal declined the ${amount} payment for "${row.title}".`;
    }
    this.event(row.period_id, "paypal_notice", message);
    return `Logged: ${message}`;
  }

  private requestForOrder(orderId: string) {
    return this.db.prepare("SELECT * FROM requests WHERE paypal_order_id = ? ORDER BY created_at DESC LIMIT 1").get(orderId) as unknown as
      | RequestRow
      | undefined;
  }

  decline(requestId: string, why = "You declined") {
    const request = this.request(requestId);
    if (request.status !== "pending" && request.status !== "checkout") {
      throw new WalletError("NOT_PENDING", `This request is already ${request.status}.`);
    }
    tx(this.db, () => {
      this.db.prepare("UPDATE requests SET status = 'declined', decided_at = ? WHERE id = ?").run(this.iso(), requestId);
      if (request.kind === "budget") this.db.prepare("UPDATE periods SET status = 'declined' WHERE id = ?").run(request.period_id);
      this.event(request.period_id, "declined", `${why} the ${request.kind === "budget" ? "budget request" : "top-up"}.`);
    });
  }

  // ---------------------------------------------------------------- agent: spending

  spend(input: SpendInput) {
    return this.serial(async () => {
      const period = this.openPeriod();
      if (this.isPastEnd(period)) throw new WalletError("PERIOD_ENDED", `The budget period ended on ${period.ends_on}.`);
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new WalletError("BAD_AMOUNT", "Amount must be positive.");
      const title = requireText(input.title, "title", 200);
      const merchant = requireText(input.merchant, "merchant", 100);
      const reasoning = requireText(input.reasoning, "reasoning", 1000);

      const lines = this.lines(period.id);
      const line = lines.find((l) => l.key === input.lineKey);
      const refuse = (code: string, message: string): never => {
        this.recordRefusal(period.id, line?.envelopeId ?? null, input, message);
        throw new WalletError(code, message, 409);
      };
      if (!line) {
        refuse("NO_SUCH_LINE", `There is no approved line "${input.lineKey}". Approved lines: ${lines.map((l) => l.key).join(", ")}.`);
        throw new Error("unreachable");
      }

      // Envelope rule: spend from the line first, then the shared buffer. Never from another line.
      const buffer = lines.find((l) => l.key === BUFFER_KEY);
      const fromLine = Math.min(input.amountCents, line.leftCents);
      const fromBuffer = line.key === BUFFER_KEY ? 0 : input.amountCents - fromLine;
      const bufferLeft = buffer && line.key !== BUFFER_KEY ? buffer.leftCents : 0;
      if (input.amountCents - fromLine - fromBuffer > 0 || fromBuffer > bufferLeft) {
        const bufferNote = line.key === BUFFER_KEY ? "" : ` plus ${fmt(bufferLeft)} left in the buffer`;
        refuse(
          "OVER_LINE",
          `${fmt(input.amountCents)} is more than "${line.label}" allows: ${fmt(line.leftCents)} left on the line${bufferNote}. ` +
            "Don't charge it to another line. If it's still worth buying, tell the owner: they can move unspent money " +
            "from another line in the Remit app (no new PayPal approval), or you can ask for more with request_topup.",
        );
      }
      // Total rule: never more than what is still held. (Envelopes and holds are created together, so this is a backstop.)
      const heldLeft = this.heldLeft(period.id);
      if (input.amountCents > heldLeft) refuse("OVER_BALANCE", `Only ${fmt(heldLeft)} is still held for this period.`);

      const purchaseId = newId("pur");
      this.db
        .prepare(
          `INSERT INTO purchases (id, period_id, envelope_id, line_key, status, amount_cents, from_line_cents, from_buffer_cents,
             title, merchant, url, reasoning, agent, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(purchaseId, period.id, line.envelopeId, line.key, input.amountCents, fromLine, fromBuffer, title, merchant,
          input.url ?? null, reasoning, input.agent, this.iso());

      // Purpose check: an independent model call that sees the plan line and the purchase, not the page the agent read.
      const review = this.opts.reviewer
        ? await this.opts.reviewer
            .review({ line: { label: line.label, reason: line.reason }, purchase: { title, merchant, url: input.url, amountCents: input.amountCents, reasoning } })
            .catch((err): ReviewResult => ({ verdict: "reject", reason: `Purpose check unavailable, so the wallet refused to be safe: ${errorText(err)}` }))
        : { verdict: "skipped" as const, reason: "Purpose check is off." };
      this.db.prepare("UPDATE purchases SET review = ? WHERE id = ?").run(JSON.stringify(review), purchaseId);
      if (review.verdict === "reject") {
        const message = `Purpose check refused this purchase: ${review.reason}`;
        this.db.prepare("UPDATE purchases SET status = 'refused', refusal = ? WHERE id = ?").run(message, purchaseId);
        this.event(period.id, "spend_refused", `Refused ${fmt(input.amountCents)} for "${title}". ${message}`);
        throw new WalletError("REVIEW_REJECTED", message, 409);
      }

      const captures = await this.captureFromHolds(period.id, purchaseId, input.amountCents, title).catch((err) => {
        const message = `PayPal capture failed: ${errorText(err)}`;
        this.db.prepare("UPDATE purchases SET status = 'failed', refusal = ? WHERE id = ?").run(message, purchaseId);
        this.event(period.id, "spend_failed", `${fmt(input.amountCents)} for "${title}" failed. ${message}`);
        throw new WalletError("CAPTURE_FAILED", message, 502);
      });

      this.db.prepare("UPDATE purchases SET status = 'captured' WHERE id = ?").run(purchaseId);
      const via = input.agent === "mcp" ? " (via MCP)" : "";
      this.event(period.id, "spent", `Spent ${fmt(input.amountCents)} on "${title}" from ${merchant}, line "${line.label}"${via}.`);
      const after = this.lines(period.id).find((l) => l.key === line.key)!;
      return {
        purchaseId,
        amountCents: input.amountCents,
        fromLineCents: fromLine,
        fromBufferCents: fromBuffer,
        lineLeftCents: after.leftCents,
        totalLeftCents: this.heldLeft(period.id),
        captureIds: captures.map((c) => c.captureId),
        review,
      };
    });
  }

  /** Partial captures from the oldest hold first. A capture that empties a hold is marked final. */
  private async captureFromHolds(periodId: string, purchaseId: string, cents: number, title: string) {
    const holds = this.db
      .prepare("SELECT * FROM holds WHERE period_id = ? AND status = 'active' ORDER BY authorized_at")
      .all(periodId) as unknown as HoldRow[];
    const done: { holdId: string; captureId: string; cents: number }[] = [];
    let need = cents;
    try {
      for (const hold of holds) {
        if (need === 0) break;
        const left = hold.amount_cents - hold.captured_cents;
        if (left <= 0 || Date.parse(hold.expires_at) < this.now().getTime()) continue;
        const authorizationId = await this.maybeReauthorize(hold, left);
        const take = Math.min(left, need);
        const final = take === left;
        const { captureId } = await this.paypal.capture(authorizationId, {
          cents: take,
          finalCapture: final,
          note: `Remit: ${title}`,
          idempotencyKey: `${purchaseId}-${hold.id}`,
        });
        tx(this.db, () => {
          this.db
            .prepare("INSERT INTO captures (id, purchase_id, hold_id, capture_id, amount_cents, final, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(newId("cap"), purchaseId, hold.id, captureId, take, final ? 1 : 0, this.iso());
          this.db
            .prepare(`UPDATE holds SET captured_cents = captured_cents + ?, status = CASE WHEN ? THEN 'captured' ELSE status END WHERE id = ?`)
            .run(take, final ? 1 : 0, hold.id);
        });
        done.push({ holdId: hold.id, captureId, cents: take });
        need -= take;
      }
      if (need > 0) throw new WalletError("OVER_BALANCE", `The holds ran out ${fmt(need)} short.`);
      return done;
    } catch (err) {
      // Don't leave a purchase half paid: give back any piece already taken.
      for (const c of done) {
        await this.paypal.refund(c.captureId, c.cents, `undo-${c.captureId}`).catch(() => undefined);
        this.db.prepare("UPDATE captures SET refund_id = 'undo' WHERE capture_id = ?").run(c.captureId);
      }
      throw err;
    }
  }

  /**
   * PayPal only guarantees funds for 3 days. After that, reauthorize the remaining amount once
   * (allowed within the original approval) before capturing.
   */
  private async maybeReauthorize(hold: HoldRow, leftCents: number): Promise<string> {
    if (hold.reauthorized || Date.parse(hold.honor_until) > this.now().getTime()) return hold.authorization_id;
    try {
      const next = await this.paypal.reauthorize(hold.authorization_id, leftCents);
      // The new authorization covers only what was left, so restart its captured count.
      this.db
        .prepare(
          `UPDATE holds SET authorization_id = ?, amount_cents = captured_cents + ?, reauthorized = 1, honor_until = ?, expires_at = ? WHERE id = ?`,
        )
        .run(next.authorizationId, next.cents, new Date(this.now().getTime() + HONOR_PERIOD_MS).toISOString(), next.expiresAt, hold.id);
      this.event(hold.period_id, "reauthorized", `Hold reauthorized for the remaining ${fmt(next.cents)} after PayPal's 3-day honor period.`);
      hold.reauthorized = 1;
      return next.authorizationId;
    } catch {
      // Capturing on the original authorization usually still works; let that try decide.
      return hold.authorization_id;
    }
  }

  // ---------------------------------------------------------------- owner: close-out and refunds

  closePeriod(why = "You closed") {
    return this.serial(async () => {
      const period = this.currentPeriod();
      if (!period) throw new WalletError("NO_PERIOD", "There is no open budget to close.");
      const holds = this.db.prepare("SELECT * FROM holds WHERE period_id = ? AND status = 'active'").all(period.id) as unknown as HoldRow[];
      let released = 0;
      let lapsing = 0;
      const notes: string[] = [];
      for (const hold of holds) {
        const left = hold.amount_cents - hold.captured_cents;
        try {
          await this.paypal.voidAuthorization(hold.authorization_id);
          this.db.prepare("UPDATE holds SET status = 'voided', release_note = ? WHERE id = ?").run(`Voided, ${fmt(left)} released.`, hold.id);
          released += left;
        } catch (err) {
          // PayPal won't void an authorization that has partial captures (PREVIOUSLY_CAPTURED).
          // The rest is then released when the authorization expires.
          const issue = err instanceof PayPalError ? err.issue ?? err.message : errorText(err);
          const note = `PayPal kept the hold (${issue}). ${fmt(left)} is released when it expires on ${hold.expires_at.slice(0, 10)}.`;
          this.db.prepare("UPDATE holds SET status = 'lapsing', release_note = ? WHERE id = ?").run(note, hold.id);
          lapsing += left;
          notes.push(note);
        }
      }
      tx(this.db, () => {
        this.db
          .prepare("UPDATE requests SET status = 'expired', decided_at = ? WHERE period_id = ? AND status IN ('pending','checkout')")
          .run(this.iso(), period.id);
        this.db.prepare("UPDATE periods SET status = 'closed', closed_at = ? WHERE id = ?").run(this.iso(), period.id);
        const spent = this.spentCents(period.id);
        const parts = [`${why} the period. Spent ${fmt(spent)}.`];
        if (released) parts.push(`${fmt(released)} released back to you now.`);
        if (lapsing) parts.push(`${fmt(lapsing)} is released when PayPal's hold expires.`);
        this.event(period.id, "closed", parts.join(" "));
      });
      return { periodId: period.id, releasedCents: released, lapsingCents: lapsing, notes };
    });
  }

  /** Close any open period whose end date has passed. Run on a timer. */
  async closeIfEnded() {
    const period = this.currentPeriod();
    if (period?.status === "open" && this.isPastEnd(period)) return this.closePeriod("The wallet automatically closed");
  }

  refund(purchaseId: string) {
    return this.serial(async () => {
      const purchase = this.db.prepare("SELECT * FROM purchases WHERE id = ?").get(purchaseId) as unknown as PurchaseRow | undefined;
      if (!purchase) throw new WalletError("NOT_FOUND", "No such purchase.", 404);
      if (purchase.status !== "captured") throw new WalletError("NOT_REFUNDABLE", `This purchase is ${purchase.status}.`);
      const captures = this.db
        .prepare("SELECT * FROM captures WHERE purchase_id = ? AND refund_id IS NULL")
        .all(purchaseId) as unknown as { id: string; capture_id: string; amount_cents: number }[];
      for (const c of captures) {
        const { refundId } = await this.paypal.refund(c.capture_id, c.amount_cents, `refund-${c.id}`);
        this.db.prepare("UPDATE captures SET refund_id = ? WHERE id = ?").run(refundId, c.id);
      }
      // The money goes back to the owner, not to the agent's line: only the owner adds money.
      this.db.prepare("UPDATE purchases SET status = 'refunded' WHERE id = ?").run(purchaseId);
      this.event(purchase.period_id, "refunded", `Refunded ${fmt(purchase.amount_cents)} for "${purchase.title}" to you.`);
      return { refundedCents: purchase.amount_cents };
    });
  }

  // ---------------------------------------------------------------- owner: moving money between lines

  /**
   * Owner only; never part of the agent tool contract. Moves unspent money from one line to
   * another inside what is already held, so the total and the PayPal holds don't change.
   */
  moveBetweenLines(fromKey: string, toKey: string, cents: number) {
    return this.serial(async () => {
      const period = this.openPeriod();
      if (!Number.isInteger(cents) || cents <= 0) throw new WalletError("BAD_AMOUNT", "Amount must be positive.");
      if (fromKey === toKey) throw new WalletError("SAME_LINE", "Pick two different lines.");
      return tx(this.db, () => {
        const lines = this.lines(period.id);
        const from = lines.find((l) => l.key === fromKey);
        if (!from) throw new WalletError("NO_SUCH_LINE", `There is no approved line "${fromKey}".`);
        // The buffer can receive money even if the plan had none.
        const to = lines.find((l) => l.key === toKey) ?? (toKey === BUFFER_KEY ? this.addBuffer(period.id) : undefined);
        if (!to) throw new WalletError("NO_SUCH_LINE", `There is no approved line "${toKey}".`);
        if (cents > from.leftCents) {
          throw new WalletError("OVER_UNSPENT", `"${from.label}" has only ${fmt(Math.max(0, from.leftCents))} unspent.`);
        }
        const update = this.db.prepare("UPDATE envelopes SET limit_cents = limit_cents + ? WHERE id = ?");
        update.run(-cents, from.envelopeId);
        update.run(cents, to.envelopeId);
        this.event(period.id, "moved", `You moved ${fmt(cents)} from ${from.label} to ${to.label}.`);
        const after = this.lines(period.id);
        return {
          movedCents: cents,
          from: after.find((l) => l.key === from.key)!,
          to: after.find((l) => l.key === to.key)!,
          approvedCents: this.approvedCents(period.id),
        };
      });
    });
  }

  private addBuffer(periodId: string) {
    const id = newId("env");
    this.db
      .prepare("INSERT INTO envelopes (id, period_id, line_key, label, reason, limit_cents) VALUES (?, ?, ?, 'Buffer', ?, 0)")
      .run(id, periodId, BUFFER_KEY, "Money you moved here from other lines.");
    return { envelopeId: id, key: BUFFER_KEY, label: "Buffer" };
  }

  // ---------------------------------------------------------------- reads

  balance() {
    const period = this.currentPeriod();
    if (!period) return { period: null, lines: [], approvedCents: 0, spentCents: 0, leftCents: 0, pending: [] };
    const lines = this.lines(period.id);
    return {
      period: { id: period.id, summary: period.summary, startsOn: period.starts_on, endsOn: period.ends_on, status: period.status },
      lines,
      approvedCents: this.approvedCents(period.id),
      spentCents: this.spentCents(period.id),
      leftCents: this.heldLeft(period.id),
      pending: this.pendingRequests(period.id).map((r) => ({ id: r.id, kind: r.kind, status: r.status, totalCents: r.totalCents })),
    };
  }

  /** Earlier periods, for the agent to plan from. */
  history(limit = 6) {
    const periods = this.db
      .prepare("SELECT * FROM periods WHERE status = 'closed' ORDER BY ends_on DESC LIMIT ?")
      .all(limit) as unknown as PeriodRow[];
    return periods.map((p) => ({
      startsOn: p.starts_on,
      endsOn: p.ends_on,
      summary: p.summary,
      approvedCents: this.approvedCents(p.id),
      spentCents: this.spentCents(p.id),
      lines: this.lines(p.id).map((l) => ({ key: l.key, label: l.label, limitCents: l.limitCents, usedCents: l.usedCents })),
      purchases: (
        this.db
          .prepare("SELECT title, amount_cents, line_key, created_at FROM purchases WHERE period_id = ? AND status IN ('captured','refunded') ORDER BY created_at")
          .all(p.id) as unknown as { title: string; amount_cents: number; line_key: string; created_at: string }[]
      ).map((x) => ({ date: x.created_at.slice(0, 10), title: x.title, amountCents: x.amount_cents, line: x.line_key })),
    }));
  }

  /** Everything the owner's web app shows. */
  state() {
    const period = this.currentPeriod() ?? this.lastPeriod();
    const periodId = period?.id;
    return {
      balance: this.balance(),
      period: period ? { id: period.id, summary: period.summary, startsOn: period.starts_on, endsOn: period.ends_on, status: period.status } : null,
      lines: periodId ? this.lines(periodId) : [],
      requests: this.pendingRequests(),
      holds: periodId
        ? (this.db.prepare("SELECT * FROM holds WHERE period_id = ? ORDER BY authorized_at").all(periodId) as unknown as HoldRow[]).map((h) => ({
            id: h.id,
            authorizationId: h.authorization_id,
            amountCents: h.amount_cents,
            capturedCents: h.captured_cents,
            status: h.status,
            expiresAt: h.expires_at,
            honorUntil: h.honor_until,
            releaseNote: h.release_note,
          }))
        : [],
      totals: periodId
        ? { approvedCents: this.approvedCents(periodId), spentCents: this.spentCents(periodId), heldCents: this.heldLeft(periodId), refundedCents: this.refundedCents(periodId) }
        : { approvedCents: 0, spentCents: 0, heldCents: 0, refundedCents: 0 },
      purchases: periodId
        ? (this.db.prepare("SELECT * FROM purchases WHERE period_id = ? ORDER BY created_at DESC").all(periodId) as unknown as PurchaseRow[]).map((p) => ({
            id: p.id,
            lineKey: p.line_key,
            status: p.status,
            amountCents: p.amount_cents,
            fromBufferCents: p.from_buffer_cents,
            title: p.title,
            merchant: p.merchant,
            url: p.url,
            reasoning: p.reasoning,
            agent: p.agent,
            refusal: p.refusal,
            review: p.review ? (JSON.parse(p.review) as ReviewResult) : null,
            createdAt: p.created_at,
          }))
        : [],
      events: (this.db.prepare("SELECT type, message, created_at FROM events ORDER BY id DESC LIMIT 40").all() as unknown as {
        type: string;
        message: string;
        created_at: string;
      }[]).map((e) => ({ type: e.type, message: e.message, at: e.created_at })),
    };
  }

  pendingRequests(periodId?: string) {
    const rows = (
      periodId
        ? this.db.prepare("SELECT * FROM requests WHERE period_id = ? AND status IN ('pending','checkout') ORDER BY created_at").all(periodId)
        : this.db.prepare("SELECT * FROM requests WHERE status IN ('pending','checkout') ORDER BY created_at").all()
    ) as unknown as RequestRow[];
    return rows.map((r) => {
      const lines = this.requestLines(r.id);
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        reason: r.reason,
        createdAt: r.created_at,
        totalCents: lines.reduce((sum, l) => sum + (l.approved_cents ?? l.amount_cents), 0),
        approval: r.status === "checkout" ? parseCheck(r.approval_check) : null,
        lines: lines.map((l) => ({ id: l.id, key: l.line_key, label: l.label, reason: l.reason, amountCents: l.amount_cents, approvedCents: l.approved_cents })),
      };
    });
  }

  // ---------------------------------------------------------------- internals

  private lines(periodId: string) {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.line_key, e.label, e.reason, e.limit_cents,
           COALESCE((SELECT SUM(p.from_line_cents) FROM purchases p WHERE p.envelope_id = e.id AND p.status IN ${LIVE}), 0) AS line_used
         FROM envelopes e WHERE e.period_id = ? ORDER BY e.rowid`,
      )
      .all(periodId) as unknown as { id: string; line_key: string; label: string; reason: string; limit_cents: number; line_used: number }[];
    const bufferDraw = (
      this.db.prepare(`SELECT COALESCE(SUM(from_buffer_cents), 0) AS n FROM purchases WHERE period_id = ? AND status IN ${LIVE}`).get(periodId) as {
        n: number;
      }
    ).n;
    return rows.map((r) => {
      const used = r.line_used + (r.line_key === BUFFER_KEY ? bufferDraw : 0);
      return { envelopeId: r.id, key: r.line_key, label: r.label, reason: r.reason, limitCents: r.limit_cents, usedCents: used, leftCents: r.limit_cents - used };
    });
  }

  private heldLeft(periodId: string): number {
    const held = (
      this.db
        .prepare("SELECT COALESCE(SUM(amount_cents - captured_cents), 0) AS n FROM holds WHERE period_id = ? AND status = 'active'")
        .get(periodId) as { n: number }
    ).n;
    const pending = (
      this.db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchases WHERE period_id = ? AND status = 'pending'").get(periodId) as { n: number }
    ).n;
    return held - pending;
  }

  private approvedCents(periodId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(limit_cents), 0) AS n FROM envelopes WHERE period_id = ?").get(periodId) as { n: number }).n;
  }

  private spentCents(periodId: string): number {
    return (
      this.db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchases WHERE period_id = ? AND status IN ('captured','refunded')").get(periodId) as {
        n: number;
      }
    ).n;
  }

  private refundedCents(periodId: string): number {
    return (
      this.db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM purchases WHERE period_id = ? AND status = 'refunded'").get(periodId) as { n: number }
    ).n;
  }

  private recordRefusal(periodId: string, envelopeId: string | null, input: SpendInput, message: string) {
    this.db
      .prepare(
        `INSERT INTO purchases (id, period_id, envelope_id, line_key, status, amount_cents, title, merchant, url, reasoning, agent, refusal, created_at)
         VALUES (?, ?, ?, ?, 'refused', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId("pur"), periodId, envelopeId, input.lineKey, input.amountCents, input.title.slice(0, 200), input.merchant.slice(0, 100),
        input.url ?? null, input.reasoning.slice(0, 1000), input.agent, message, this.iso());
    this.event(periodId, "spend_refused", `Refused ${fmt(input.amountCents)} for "${input.title.slice(0, 80)}". ${message}`);
  }

  private insertRequest(id: string, periodId: string, kind: "budget" | "topup", reason: string, lines: PlanLineInput[]) {
    this.db
      .prepare("INSERT INTO requests (id, period_id, kind, status, reason, created_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .run(id, periodId, kind, reason, this.iso());
    const insert = this.db.prepare(
      "INSERT INTO request_lines (id, request_id, line_key, label, reason, amount_cents, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    lines.forEach((l, i) => insert.run(newId("line"), id, l.key, l.label, l.reason, l.amountCents, i));
  }

  private checkRequestSize(cents: number) {
    if (cents > this.opts.maxRequestCents) {
      throw new WalletError("TOO_LARGE", `The wallet accepts at most ${fmt(this.opts.maxRequestCents)} per request.`);
    }
  }

  private event(periodId: string | null, type: string, message: string) {
    this.db.prepare("INSERT INTO events (period_id, type, message, created_at) VALUES (?, ?, ?, ?)").run(periodId, type, message, this.iso());
  }

  private currentPeriod() {
    return this.db.prepare("SELECT * FROM periods WHERE status IN ('pending','open') ORDER BY created_at DESC LIMIT 1").get() as unknown as
      | PeriodRow
      | undefined;
  }

  private lastPeriod() {
    return this.db.prepare("SELECT * FROM periods WHERE source = 'live' ORDER BY created_at DESC LIMIT 1").get() as unknown as PeriodRow | undefined;
  }

  private openPeriod(): PeriodRow {
    const period = this.currentPeriod();
    if (!period || period.status !== "open") {
      throw new WalletError(
        "NO_BUDGET",
        period ? "The budget request is still waiting for the owner's approval." : "There is no approved budget. Ask for one with request_budget.",
        409,
      );
    }
    return period;
  }

  private period(id: string) {
    return this.db.prepare("SELECT * FROM periods WHERE id = ?").get(id) as unknown as PeriodRow;
  }

  private request(id: string): RequestRow {
    const row = this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as unknown as RequestRow | undefined;
    if (!row) throw new WalletError("NOT_FOUND", "No such request.", 404);
    return row;
  }

  private requestLines(requestId: string) {
    return this.db.prepare("SELECT * FROM request_lines WHERE request_id = ? ORDER BY position").all(requestId) as unknown as RequestLineRow[];
  }

  private envelope(periodId: string, key: string) {
    return this.db.prepare("SELECT * FROM envelopes WHERE period_id = ? AND line_key = ?").get(periodId, key) as unknown as
      | { id: string; label: string }
      | undefined;
  }

  private isPastEnd(period: PeriodRow) {
    return this.today() > period.ends_on;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  private iso() {
    return this.now().toISOString();
  }

  /** Local calendar date, YYYY-MM-DD. */
  private today() {
    const d = this.now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

function checkLine(line: PlanLineInput): PlanLineInput {
  if (!LINE_KEY.test(line.key)) throw new WalletError("BAD_LINES", `Line key "${line.key}" must be lowercase letters, digits, - or _.`);
  if (!Number.isInteger(line.amountCents) || line.amountCents <= 0) throw new WalletError("BAD_AMOUNT", `Line "${line.key}" needs a positive amount.`);
  return { key: line.key, label: requireText(line.label, "label", 80), amountCents: line.amountCents, reason: checkReason(line.key, line.reason) };
}

function checkReason(key: string, value: string | undefined): string {
  const text = (value ?? "").trim();
  if (text.length < MIN_REASON_CHARS || text.split(/\s+/).length < MIN_REASON_WORDS) {
    throw new WalletError(
      "WEAK_REASON",
      `Line "${key}" needs a reason the owner can check${text ? `, not just "${text.slice(0, 40)}"` : ""}. Cite the evidence, e.g. ` +
        `"Last bag bought Oct 16, a 12 kg bag lasts about 4 weeks" or "Last 4 weeks averaged $43.70 per order". ` +
        "Call get_history for past spending.",
    );
  }
  return requireText(text, "reason", 300);
}

function requireText(value: string | undefined, name: string, max: number): string {
  const text = (value ?? "").trim();
  if (!text) throw new WalletError("MISSING", `${name} is required.`);
  if (text.length > max) throw new WalletError("TOO_LONG", `${name} must be at most ${max} characters.`);
  return text;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseCheck(json: string | null): ApprovalCheck | null {
  return json ? (JSON.parse(json) as ApprovalCheck) : null;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PeriodRow {
  id: string;
  summary: string;
  starts_on: string;
  ends_on: string;
  status: string;
}

interface RequestRow {
  id: string;
  period_id: string;
  kind: "budget" | "topup";
  status: string;
  reason: string;
  paypal_order_id: string | null;
  approval_check: string | null;
  created_at: string;
}

interface RequestLineRow {
  id: string;
  line_key: string;
  label: string;
  reason: string;
  amount_cents: number;
  approved_cents: number | null;
}

interface HoldRow {
  id: string;
  period_id: string;
  authorization_id: string;
  amount_cents: number;
  captured_cents: number;
  status: string;
  honor_until: string;
  expires_at: string;
  reauthorized: number;
  release_note: string | null;
}

interface PurchaseRow {
  id: string;
  period_id: string;
  line_key: string;
  status: string;
  amount_cents: number;
  from_buffer_cents: number;
  title: string;
  merchant: string;
  url: string | null;
  reasoning: string;
  agent: string;
  refusal: string | null;
  review: string | null;
  created_at: string;
}
