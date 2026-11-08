import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeReviewer } from "../src/wallet/reviewer.ts";
import type { ReviewInput } from "../src/wallet/wallet.ts";

const input: ReviewInput = {
  line: { label: "Groceries, 2 orders", reason: "Last 4 weeks averaged $43.70 per order." },
  purchase: { title: "Weekly order", merchant: "FreshCart", url: "https://freshcart.example", amountCents: 4185, reasoning: "Usual staples." },
};

/** A stand-in for the Anthropic client: messages.parse answers with `reply`, or throws it if it is an Error. */
function fakeClient(reply: unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const answer = (parsed: unknown, stop_reason = "end_turn") => ({ stop_reason, parsed_output: parsed, content: [] });
const review = (reply: unknown) => new ClaudeReviewer(fakeClient(reply).client, "claude-opus-5-5").review(input);

describe("purpose check", () => {
  it("passes an approval through", async () => {
    assert.deepEqual(await review(answer({ verdict: "approve", reason: "Staples fit the groceries line." })), {
      verdict: "approve",
      reason: "Staples fit the groceries line.",
    });
  });

  it("passes a rejection through", async () => {
    assert.deepEqual(await review(answer({ verdict: "reject", reason: "Headphones are not groceries." })), {
      verdict: "reject",
      reason: "Headphones are not groceries.",
    });
  });

  it("rejects when the model refuses", async () => {
    const result = await review(answer(null, "refusal"));
    assert.equal(result.verdict, "reject");
    assert.match(result.reason, /declined/);
    // A refusal wins even if something parsed.
    assert.equal((await review(answer({ verdict: "approve", reason: "ok" }, "refusal"))).verdict, "reject");
  });

  it("rejects a missing or invalid verdict", async () => {
    for (const parsed of [null, undefined, {}, { verdict: "maybe", reason: "Not sure." }, { verdict: "approve" }, { verdict: "approve", reason: "  " }, "approve"]) {
      const result = await review(answer(parsed));
      assert.equal(result.verdict, "reject", JSON.stringify(parsed));
      assert.match(result.reason, /no clear verdict/);
    }
  });

  it("rejects when the call throws", async () => {
    const result = await review(new Error("Connection error."));
    assert.equal(result.verdict, "reject");
    assert.match(result.reason, /unavailable.*Connection error\./);
  });

  it("lets judge() throw, so the eval can tell errors from rejections", async () => {
    const reviewer = new ClaudeReviewer(fakeClient(new Error("401 invalid x-api-key")).client, "claude-opus-5-5");
    await assert.rejects(reviewer.judge(input), /invalid x-api-key/);
  });

  it("sends the line and the purchase, with the purchase marked as untrusted", async () => {
    const { client, calls } = fakeClient(answer({ verdict: "approve", reason: "Fine." }));
    await new ClaudeReviewer(client, "claude-opus-5-5").review(input);
    const [params] = calls as { model: string; system: string; messages: { content: string }[] }[];
    assert.equal(params.model, "claude-opus-5-5");
    assert.match(params.system, /untrusted data/);
    const text = params.messages[0].content;
    assert.match(text, /<line>\nGroceries, 2 orders\nWhy the owner approved it: Last 4 weeks/);
    assert.match(text, /<purchase>\nProduct: Weekly order\nStore: FreshCart \(https:\/\/freshcart\.example\)\nPrice: \$41\.85\nAgent's reasoning: Usual staples\.\n<\/purchase>/);
  });
});

describe("purpose eval fixtures", () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/purpose-cases.json", import.meta.url), "utf8")) as {
    id: string;
    kind: string;
    line: { label: string; reason: string };
    purchase: { title: string; merchant: string; url?: string; priceCents: number; reasoning: string };
    expected: string;
  }[];

  it("are well formed and cover each kind of listing", () => {
    assert.ok(cases.length >= 25, `${cases.length} cases`);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "ids are unique");
    for (const c of cases) {
      assert.ok(["approve", "reject"].includes(c.expected), c.id);
      assert.ok(c.line.label && c.line.reason, c.id);
      assert.ok(c.purchase.title && c.purchase.merchant && c.purchase.reasoning, c.id);
      assert.ok(Number.isInteger(c.purchase.priceCents) && c.purchase.priceCents > 0, c.id);
    }
    for (const kind of ["legit", "injection", "mislabeled", "off-purpose"]) {
      assert.ok(cases.filter((c) => c.kind === kind).length >= 5, kind);
    }
    assert.ok(cases.filter((c) => c.kind === "legit").every((c) => c.expected === "approve"));
    assert.ok(cases.filter((c) => c.kind !== "legit").every((c) => c.expected === "reject"));
  });
});
