import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { ShoppingAgent } from "../demo/agent.ts";
import { config, isLocalUrl, paypalMode } from "../config.ts";
import { openDb } from "../db.ts";
import { RestPayPal } from "../paypal/rest.ts";
import { SimulatedPayPal } from "../paypal/simulated.ts";
import { Channel3Search, DemoSearch } from "../demo/search.ts";
import { ClaudeReviewer } from "../wallet/reviewer.ts";
import { Wallet } from "../wallet/wallet.ts";
import { createApp } from "./app.ts";

// Anyone who can open a public web app can approve holds and run the agent, so it must have a password.
if (!isLocalUrl(config.appUrl) && !config.ownerPassword) {
  console.error(`Refusing to start: APP_URL is ${config.appUrl}, which is public, and REMIT_OWNER_PASSWORD is empty.`);
  console.error("Set REMIT_OWNER_PASSWORD, or use a localhost APP_URL.");
  process.exit(1);
}

const db = openDb(config.dbPath);

const simulated = paypalMode === "simulated" ? new SimulatedPayPal(db, config.appUrl) : undefined;
const paypal = simulated ?? new RestPayPal({ ...config.paypal, currency: config.currency });
const search = config.channel3Key ? new Channel3Search(config.channel3Key) : new DemoSearch();
const claude = config.anthropic.configured ? new Anthropic() : null;
const reviewer = claude && config.anthropic.reviewer ? new ClaudeReviewer(claude, config.anthropic.model) : undefined;

const wallet = new Wallet(db, paypal, { appUrl: config.appUrl, maxRequestCents: config.maxRequestCents, reviewer });
const agent = new ShoppingAgent(db, wallet, search, claude, config.anthropic.model, config.inrRate);

const modes = {
  paypal: paypal.mode,
  search: search.source,
  agent: claude ? "on" : "off",
  reviewer: reviewer ? "on" : "off",
  model: config.anthropic.model,
  mcp: config.agentToken ? "on" : "off",
};

const app = createApp({
  wallet,
  agent,
  simulated,
  modes,
  inrRate: config.inrRate,
  agentToken: config.agentToken || undefined,
  ownerPassword: config.ownerPassword || undefined,
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Remit on ${config.appUrl}`);
  console.log(`  PayPal: ${modes.paypal}  search: ${modes.search}  agent: ${modes.agent}  purpose check: ${modes.reviewer}`);
  console.log(`  agent API for MCP: ${config.agentToken ? "on" : "off (set REMIT_AGENT_TOKEN)"}`);
});

// Scheduled close-out: when a period's end date passes, release what's left.
setInterval(() => {
  wallet.closeIfEnded().catch((err) => console.error("close-out:", err));
}, 60_000).unref();
