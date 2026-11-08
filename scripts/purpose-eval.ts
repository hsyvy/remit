import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../src/config.ts";
import { fmt } from "../src/money.ts";
import { ClaudeReviewer } from "../src/wallet/reviewer.ts";
import { errorText, type ReviewResult } from "../src/wallet/wallet.ts";

/**
 * Runs the real purpose check over test/fixtures/purpose-cases.json and reports how often it agrees.
 * A false approve (a purchase that should be refused but was let through) is the costly mistake, so it is counted on its own.
 * Run: npm run purpose-eval        Needs ANTHROPIC_API_KEY. Uses REMIT_MODEL (default claude-opus-5-5).
 */

export interface PurposeCase {
  id: string;
  kind: "legit" | "injection" | "mislabeled" | "off-purpose";
  line: { label: string; reason: string };
  purchase: { title: string; merchant: string; url?: string; priceCents: number; reasoning: string };
  expected: "approve" | "reject";
}

if (!config.anthropic.configured) {
  console.error("The purpose eval calls Claude, so it needs ANTHROPIC_API_KEY. Set it in .env or the environment and run again.");
  process.exit(1);
}

const cases = JSON.parse(readFileSync(new URL("../test/fixtures/purpose-cases.json", import.meta.url), "utf8")) as PurposeCase[];
const reviewer = new ClaudeReviewer(new Anthropic(), config.anthropic.model);
console.log(`Purpose check eval: ${cases.length} cases, model ${config.anthropic.model}\n`);

type Outcome = { c: PurposeCase; result?: ReviewResult; error?: string };
const outcomes: Outcome[] = new Array(cases.length);
const CONCURRENCY = 4;
let next = 0;

async function worker() {
  while (next < cases.length) {
    const i = next++;
    const c = cases[i];
    try {
      // judge() throws on API errors, so a bad key or an outage shows as an error rather than as a correct rejection.
      const result = await reviewer.judge({
        line: c.line,
        purchase: { title: c.purchase.title, merchant: c.purchase.merchant, url: c.purchase.url, amountCents: c.purchase.priceCents, reasoning: c.purchase.reasoning },
      });
      outcomes[i] = { c, result };
    } catch (err) {
      outcomes[i] = { c, error: errorText(err) };
    }
    print(outcomes[i]);
  }
}

function print({ c, result, error }: Outcome) {
  const mark = error ? "ERROR" : result!.verdict === c.expected ? "ok   " : result!.verdict === "approve" ? "FALSE APPROVE" : "FALSE REJECT";
  console.log(`${mark.padEnd(13)} ${c.id} (${c.kind}, ${fmt(c.purchase.priceCents)})`);
  console.log(`              expected ${c.expected}, got ${error ? "error" : result!.verdict}: ${error ?? result!.reason}`);
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cases.length) }, worker));

const answered = outcomes.filter((o) => o.result);
const errors = outcomes.filter((o) => o.error);
const correct = answered.filter((o) => o.result!.verdict === o.c.expected);
const falseApproves = answered.filter((o) => o.c.expected === "reject" && o.result!.verdict === "approve");
const falseRejects = answered.filter((o) => o.c.expected === "approve" && o.result!.verdict === "reject");

console.log("");
if (answered.length) {
  console.log(`Accuracy: ${correct.length}/${answered.length} (${((correct.length / answered.length) * 100).toFixed(1)}%)`);
}
const kinds = [...new Set(cases.map((c) => c.kind))];
for (const kind of kinds) {
  const of = answered.filter((o) => o.c.kind === kind);
  if (of.length) console.log(`  ${kind.padEnd(12)} ${of.filter((o) => o.result!.verdict === o.c.expected).length}/${of.length}`);
}
console.log(`False approves: ${falseApproves.length}${falseApproves.length ? `  <-- money would have moved: ${falseApproves.map((o) => o.c.id).join(", ")}` : ""}`);
console.log(`False rejects: ${falseRejects.length}${falseRejects.length ? ` (${falseRejects.map((o) => o.c.id).join(", ")})` : ""}`);
if (errors.length) console.log(`Errors: ${errors.length} (not counted in accuracy). First: ${errors[0].error}`);

// Fail the run on any false approve or error, so it can gate a prompt or model change.
process.exit(falseApproves.length || errors.length ? 1 : 0);
