import type { ShoppingAgent } from "../src/demo/agent.ts";
import { openDb } from "../src/db.ts";
import { SimulatedPayPal } from "../src/paypal/simulated.ts";
import { createApp, type AppDeps } from "../src/server/app.ts";
import { Wallet } from "../src/wallet/wallet.ts";

export const APP = "http://localhost:3000";
export const AGENT_TOKEN = "agent-token";
export const OWNER_PASSWORD = "owner-pass";

export const today = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A real wallet on the simulated PayPal and an in-memory database, behind the real Hono app. */
export function makeApp(opts: { agentToken?: string; ownerPassword?: string } = {}) {
  const db = openDb(":memory:");
  const paypal = new SimulatedPayPal(db, APP);
  const wallet = new Wallet(db, paypal, { appUrl: APP, maxRequestCents: 50_000 });
  // Only the /api routes touch the demo agent; these tests don't chat.
  const agent = { enabled: false, isBusy: false, transcript: () => [] } as unknown as ShoppingAgent;
  const modes = { paypal: "simulated", search: "demo", agent: "off", reviewer: "off", model: "test" };
  const app = createApp({ wallet, agent, simulated: paypal, modes, ...opts } satisfies AppDeps);
  return { app, wallet, paypal };
}

/** Requests a one-line budget and returns its id, still waiting for the owner. */
export function requestBudget(wallet: Wallet) {
  return wallet.requestBudget({
    summary: "Household week",
    startsOn: today(),
    endsOn: today(6),
    lines: [{ key: "groceries", label: "Groceries", amountCents: 5000, reason: "Last 4 weeks averaged $43.70 per order." }],
  });
}

/** Requests a budget and approves it the way the owner would on PayPal. */
export async function openBudget(wallet: Wallet, paypal: SimulatedPayPal) {
  const { requestId } = requestBudget(wallet);
  const { orderId } = await wallet.checkout(requestId);
  paypal.approve(orderId);
  await wallet.completeApproval(requestId, orderId);
}
