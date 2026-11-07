import { z } from "zod";
import { fmt, toCents } from "../money.ts";
import type { Wallet } from "./wallet.ts";

/**
 * The four money tools any agent gets, defined once. The in-process Claude agent and the MCP
 * server both use these schemas, and both end up in the same Wallet methods.
 */

const dollars = z.number().positive().max(100_000).describe("US dollars, e.g. 32.50");
const lineKey = z.string().describe('Short lowercase id for a plan line, e.g. "groceries" or "gift-sam"');

export const walletToolDefs = {
  get_balance: {
    description:
      "See the current budget: each approved plan line with how much is left, the total still held on PayPal, and any requests waiting for the owner.",
    input: z.object({}),
  },
  request_budget: {
    description:
      "Ask the owner for a budget for a period of up to 28 days. Each line needs a concrete reason the owner can check " +
      "(past spending, how often something runs out, a task they gave you, prices you found). The owner reviews it, may " +
      "remove or change lines, and approves on PayPal, which places a hold. You can't spend until they approve.",
    input: z.object({
      summary: z.string().describe("One sentence on what this budget covers"),
      starts_on: z.string().describe("YYYY-MM-DD"),
      ends_on: z.string().describe("YYYY-MM-DD, at most 28 days from today"),
      lines: z
        .array(
          z.object({
            key: lineKey,
            label: z.string().describe('What the owner sees, e.g. "Dog food, 12 kg bag"'),
            amount: dollars,
            reason: z.string().describe("Why this amount, with the evidence"),
          }),
        )
        .min(1)
        .max(12),
      buffer: z
        .object({ amount: dollars, reason: z.string() })
        .optional()
        .describe("Shared extra for price changes and shipping, usually about 10%. Any line can draw on it."),
    }),
  },
  request_topup: {
    description:
      "Ask the owner for more money mid-period, for an existing line or a new one. It's a new PayPal approval by the owner. Use it after the wallet refuses a purchase that is still worth making.",
    input: z.object({
      line: lineKey,
      label: z.string().optional().describe("Required when adding a new line"),
      amount: dollars,
      reason: z.string().describe("Why the extra money is needed, for the owner"),
    }),
  },
  spend: {
    description:
      "Pay for one purchase from an approved plan line. The wallet checks the line and the total, then takes the money " +
      "from the PayPal hold. If it refuses, don't retry on another line or split the purchase; tell the owner or use request_topup.",
    input: z.object({
      line: lineKey.describe("The approved plan line this purchase belongs to"),
      amount: dollars.describe("Total price including shipping, in US dollars"),
      title: z.string().describe("Product name"),
      merchant: z.string().describe("Store or domain"),
      url: z.string().optional().describe("Product page"),
      reasoning: z.string().describe("Why this product, for the owner's ledger"),
    }),
  },
} as const;

export type WalletToolName = keyof typeof walletToolDefs;

export async function runWalletTool(wallet: Wallet, name: WalletToolName, raw: unknown, agent: "remit" | "mcp") {
  switch (name) {
    case "get_balance": {
      const b = wallet.balance();
      if (!b.period) return { budget: "none", note: "No budget yet. Ask for one with request_budget." };
      return {
        period: `${b.period.startsOn} to ${b.period.endsOn}`,
        status: b.period.status === "pending" ? "waiting for the owner to approve" : b.period.status,
        approved: fmt(b.approvedCents),
        spent: fmt(b.spentCents),
        left: fmt(b.leftCents),
        lines: b.lines.map((l) => ({ line: l.key, label: l.label, approved: fmt(l.limitCents), left: fmt(l.leftCents) })),
        waiting_for_owner: b.pending.map((p) => ({ kind: p.kind, amount: fmt(p.totalCents) })),
      };
    }
    case "request_budget": {
      const input = walletToolDefs.request_budget.input.parse(raw);
      const result = wallet.requestBudget({
        summary: input.summary,
        startsOn: input.starts_on,
        endsOn: input.ends_on,
        lines: input.lines.map((l) => ({ key: l.key, label: l.label, amountCents: toCents(l.amount), reason: l.reason })),
        buffer: input.buffer ? { amountCents: toCents(input.buffer.amount), reason: input.buffer.reason } : undefined,
      });
      return { status: "sent to the owner for approval on PayPal", total: fmt(result.totalCents), review_link: result.reviewUrl };
    }
    case "request_topup": {
      const input = walletToolDefs.request_topup.input.parse(raw);
      const result = wallet.requestTopup({ lineKey: input.line, label: input.label, amountCents: toCents(input.amount), reason: input.reason });
      return { status: "sent to the owner for approval on PayPal", amount: fmt(result.totalCents), review_link: result.reviewUrl };
    }
    case "spend": {
      const input = walletToolDefs.spend.input.parse(raw);
      const result = await wallet.spend({
        lineKey: input.line,
        amountCents: toCents(input.amount),
        title: input.title,
        merchant: input.merchant,
        url: input.url,
        reasoning: input.reasoning,
        agent,
      });
      return {
        status: "paid",
        amount: fmt(result.amountCents),
        from_buffer: result.fromBufferCents ? fmt(result.fromBufferCents) : undefined,
        line_left: fmt(result.lineLeftCents),
        total_left: fmt(result.totalLeftCents),
        purpose_check: result.review.verdict === "skipped" ? undefined : result.review.reason,
        store_checkout: "Simulated: the payment was taken from the PayPal hold; this demo does not place a real store order.",
      };
    }
  }
}
