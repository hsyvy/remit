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
import { LinkSigner } from "../notify/links.ts";
import { Notifications } from "../notify/notices.ts";
import { makeNotifier } from "../notify/notifier.ts";

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

if (!config.linkSecret) console.warn("REMIT_LINK_SECRET is not set: using a random one, so notification links stop working when the server restarts.");
const links = new LinkSigner(config.linkSecret || LinkSigner.randomSecret());
const notifier = makeNotifier(config.notify);
// The wallet is built before the notifications that read from it, so the hook looks it up when an event arrives.
let notifications: Notifications | undefined;

const wallet = new Wallet(db, paypal, {
  appUrl: config.appUrl,
  maxRequestCents: config.maxRequestCents,
  reviewer,
  onEvent: (event) => notifications?.onEvent(event),
});
const agent = new ShoppingAgent(db, wallet, search, claude, config.anthropic.model, config.inrRate);
notifications = new Notifications(wallet, notifier, links, { appUrl: config.appUrl, canPlan: () => agent.enabled });

const modes = {
  paypal: paypal.mode,
  search: search.source,
  agent: claude ? "on" : "off",
  reviewer: reviewer ? "on" : "off",
  model: config.anthropic.model,
  mcp: config.agentToken ? "on" : "off",
  notify: notifier.name,
};

const app = createApp({
  wallet,
  agent,
  simulated,
  modes,
  inrRate: config.inrRate,
  agentToken: config.agentToken || undefined,
  ownerPassword: config.ownerPassword || undefined,
  links: { signer: links, appUrl: config.appUrl },
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Remit on ${config.appUrl}`);
  console.log(`  PayPal: ${modes.paypal}  search: ${modes.search}  agent: ${modes.agent}  purpose check: ${modes.reviewer}`);
  console.log(`  agent API for MCP: ${config.agentToken ? "on" : "off (set REMIT_AGENT_TOKEN)"}`);
  console.log(`  notifications: ${notifier.name === "none" ? "log only (set NTFY_TOPIC or NOTIFY_WEBHOOK_URL)" : notifier.name}`);
});

// Scheduled close-out: when a period's end date passes, release what's left.
setInterval(() => {
  wallet.closeIfEnded().catch((err) => console.error("close-out:", err));
}, 60_000).unref();
