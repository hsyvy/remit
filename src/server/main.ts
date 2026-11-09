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
import { PayPalWebhooks } from "../wallet/webhooks.ts";
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

if (!config.linkSecret) console.warn("REMIT_LINK_SECRET is not set: using a random one, so notification links and sign-ins stop working when the server restarts.");
const secret = config.linkSecret || LinkSigner.randomSecret();
const links = new LinkSigner(secret);
const notifier = makeNotifier(config.notify);
// The wallet is built before the notifications that read from it, so the hook looks it up when an event arrives.
let notifications: Notifications | undefined;

const wallet = new Wallet(db, paypal, {
  appUrl: config.appUrl,
  maxRequestCents: config.maxRequestCents,
  reviewer,
  onEvent: (event) => notifications?.onEvent(event),
});
// The simulator signs its own webhooks. The real sandbox needs the webhook's ID to verify them.
const webhooks = simulated || config.paypal.webhookId ? new PayPalWebhooks(db, wallet) : undefined;
const agent = new ShoppingAgent(db, wallet, search, claude, config.anthropic.model);
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
  webhooks,
  modes,
  agentToken: config.agentToken || undefined,
  ownerPassword: config.ownerPassword || undefined,
  // The link secret also signs the owner's session cookie, under its own derived key.
  sessionSecret: secret,
  links: { signer: links, appUrl: config.appUrl },
});

// The simulator sends its webhooks straight to the route, in process, so keyless demos take the same path.
simulated?.deliverWebhooksTo((d) =>
  app.request("/paypal/webhook", { method: "POST", headers: d.headers as Record<string, string>, body: d.body }),
);

const webhookMode = simulated
  ? "simulated, sent in process"
  : webhooks
    ? `on at ${config.appUrl}/paypal/webhook`
    : "off (set PAYPAL_WEBHOOK_ID); approvals are checked by asking PayPal";

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Remit on ${config.appUrl}`);
  console.log(`  PayPal: ${modes.paypal}  search: ${modes.search}  agent: ${modes.agent}  purpose check: ${modes.reviewer}`);
  console.log(`  PayPal webhooks: ${webhookMode}`);
  console.log(`  agent API and remote MCP at ${config.appUrl}/mcp: per-agent tokens from the Agents page; shared token ${config.agentToken ? "on" : "off (set REMIT_AGENT_TOKEN)"}`);
  console.log(`  notifications: ${notifier.name === "none" ? "log only (set NTFY_TOPIC or NOTIFY_WEBHOOK_URL)" : notifier.name}`);
});

// Scheduled close-out: when a period's end date passes, release what's left.
setInterval(() => {
  wallet.closeIfEnded().catch((err) => console.error("close-out:", err));
}, 60_000).unref();
