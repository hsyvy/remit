import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { ShoppingAgent } from "../demo/agent.ts";
import { fmt } from "../money.ts";
import { PayPalError } from "../paypal/gateway.ts";
import { isWaiting, type SimOrder, type SimulatedPayPal } from "../paypal/simulated.ts";
import { runWalletTool, walletToolDefs, type WalletToolName } from "../wallet/tools.ts";
import { errorText, WalletError, type Wallet } from "../wallet/wallet.ts";

export interface AppDeps {
  wallet: Wallet;
  agent: ShoppingAgent;
  simulated?: SimulatedPayPal;
  modes: { paypal: string; search: string; agent: string; reviewer: string; model: string; mcp?: string };
  /** Rupees per dollar for the approximate ₹ figure in the web app; 0 for dollars only. */
  inrRate?: number;
  agentToken?: string;
  ownerPassword?: string;
}

export function createApp(deps: AppDeps) {
  const { wallet, agent } = deps;
  const app = new Hono();
  let agentError: string | null = null;

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof WalletError) return c.json({ error: err.code, message: err.message }, err.status as 400);
    if (err instanceof PayPalError) return c.json({ error: err.issue ?? "PAYPAL_ERROR", message: `PayPal: ${err.message}` }, 502);
    if (err instanceof z.ZodError) return c.json({ error: "BAD_INPUT", message: z.prettifyError(err) }, 400);
    console.error(err);
    return c.json({ error: "INTERNAL", message: errorText(err) }, 500);
  });

  // For the host's health check, so it sits in front of the owner password.
  app.get("/healthz", (c) => c.json({ ok: true }));

  // ------------------------------------------------------------ agent API (used by the MCP server)

  if (deps.agentToken) {
    app.use("/agent/v1/*", bearerAuth({ token: deps.agentToken }));
    app.get("/agent/v1/tools", (c) => c.json(Object.keys(walletToolDefs)));
    app.post("/agent/v1/tools/:name", async (c) => {
      const name = c.req.param("name");
      if (!(name in walletToolDefs)) return c.json({ error: "NOT_FOUND", message: `No tool ${name}` }, 404);
      const body = await c.req.json().catch(() => ({}));
      return c.json(await runWalletTool(wallet, name as WalletToolName, body, "mcp"));
    });
  }

  // ------------------------------------------------------------ owner routes

  if (deps.ownerPassword) {
    const owner = basicAuth({ username: "owner", password: deps.ownerPassword });
    app.use("*", async (c, next) => (c.req.path.startsWith("/agent/v1/") ? next() : owner(c, next)));
  }

  app.get("/api/state", (c) =>
    c.json({
      modes: deps.modes,
      inrRate: deps.inrRate ?? 0,
      ...wallet.state(),
      chat: agent.transcript(),
      agentBusy: agent.isBusy,
      agentError,
    }),
  );

  app.post("/api/requests/:id/checkout", async (c) => {
    const body = z
      .object({ edits: z.array(z.object({ lineId: z.string(), amountCents: z.number().int().min(0) })).optional() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await wallet.checkout(c.req.param("id"), body.edits));
  });

  app.post("/api/requests/:id/decline", (c) => {
    wallet.decline(c.req.param("id"));
    return c.json({ ok: true });
  });

  // The app calls this when it opens, not on every poll. The wallet also throttles each request.
  app.post("/api/paypal/check", async (c) => c.json({ results: await wallet.checkApprovals() }));

  app.post("/api/period/close", async (c) => c.json(await wallet.closePeriod()));

  app.post("/api/purchases/:id/refund", async (c) => c.json(await wallet.refund(c.req.param("id"))));

  // Owner only: the agent API above has no route to this.
  app.post("/api/lines/move", async (c) => {
    const body = z
      .object({ from: z.string(), to: z.string(), amountCents: z.number().int().positive() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await wallet.moveBetweenLines(body.from, body.to, body.amountCents));
  });

  app.post("/api/chat", async (c) => {
    const { message } = z.object({ message: z.string().trim().min(1).max(4000) }).parse(await c.req.json());
    if (!agent.enabled) throw new WalletError("AGENT_OFF", "Claude isn't configured. Set ANTHROPIC_API_KEY in .env and restart.", 503);
    if (agent.isBusy) throw new WalletError("AGENT_BUSY", "The agent is still working on the last message.", 409);
    agentError = null;
    // Runs in the background; the web app polls /api/state and watches the meter move.
    agent.send(message).catch((err) => {
      agentError = errorText(err);
      console.error("agent:", err);
    });
    return c.json({ ok: true }, 202);
  });

  app.post("/api/chat/reset", (c) => {
    agent.reset();
    agentError = null;
    return c.json({ ok: true });
  });

  // PayPal sends the owner back here. completeApproval verifies by authorizing the order with PayPal.
  app.get("/paypal/return", async (c) => {
    const requestId = c.req.query("request") ?? "";
    const orderId = c.req.query("token") ?? "";
    try {
      await wallet.completeApproval(requestId, orderId);
      return c.redirect(`/?approved=${encodeURIComponent(requestId)}`);
    } catch (err) {
      return c.redirect(`/?error=${encodeURIComponent(errorText(err))}`);
    }
  });

  // The owner left PayPal without approving, or PayPal refused the payment. Ask PayPal which, so the card can say.
  app.get("/paypal/cancel", async (c) => {
    const requestId = c.req.query("request") ?? "";
    const results = await wallet.checkApprovals({ requestId, force: true }).catch((err) => {
      console.error("approval check:", err);
      return [];
    });
    const approved = results.some((r) => r.outcome === "approved");
    return c.redirect(`/?${approved ? "approved" : "cancelled"}=${encodeURIComponent(requestId)}`);
  });

  // ------------------------------------------------------------ simulated PayPal (only without sandbox credentials)

  const sim = deps.simulated;
  if (sim) {
    app.get("/sim-paypal/checkout/:orderId", (c) => c.html(simCheckoutPage(sim, c.req.param("orderId"))));
    app.post("/sim-paypal/checkout/:orderId/approve", (c) => {
      const order = sim.approve(c.req.param("orderId"));
      return c.redirect(withToken(order.returnUrl, order.id));
    });
    // Acts out PayPal refusing the buyer's card: PayPal shows an error and the order keeps waiting.
    app.post("/sim-paypal/checkout/:orderId/decline", (c) => c.html(simDeclinedPage(sim.decline(c.req.param("orderId")))));
    app.post("/sim-paypal/checkout/:orderId/cancel", (c) => {
      const order = sim.getOrder(c.req.param("orderId"));
      return c.redirect(withToken(order.cancelUrl, order.id));
    });
  }

  app.use("/*", serveStatic({ root: "./web" }));
  app.notFound((c: Context) => c.json({ error: "NOT_FOUND" }, 404));
  return app;
}

function withToken(url: string, orderId: string) {
  const u = new URL(url);
  u.searchParams.set("token", orderId);
  return u.pathname + u.search;
}

const SIM_BANNER = `<p class="banner">Simulated checkout. This is not PayPal. Remit is running without PayPal sandbox credentials, so this page stands in for PayPal's approval step. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to use the real sandbox.</p>`;

function simHead(title: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,400..700&family=Google+Sans+Code:wght@400;500&family=Courier+Prime:wght@400;700&display=swap">
<link rel="stylesheet" href="/styles.css">
</head><body>`;
}

function simCheckoutPage(sim: SimulatedPayPal, orderId: string) {
  const order = sim.getOrder(orderId);
  const rows = order.items
    .map((i) => `<li><span><strong>${esc(i.name)}</strong><small>${esc(i.description)}</small></span><span class="num">${fmt(i.cents)}</span></li>`)
    .join("");
  const done = !isWaiting(order);
  return `${simHead("Simulated approval")}
<main class="sim">
  ${SIM_BANNER}
  <h1>Approve a hold of <span class="num">${fmt(order.totalCents)}</span></h1>
  <p class="muted">${esc(order.description)}. The money stays yours until the agent spends it. Whatever isn't spent is released.</p>
  <ul class="sim-items">${rows}</ul>
  ${
    done
      ? `<p class="muted">This order was already ${order.status.toLowerCase()}.</p><p><a href="/">Back to Remit</a></p>`
      : `<div class="btns">
    <form method="post" action="/sim-paypal/checkout/${esc(order.id)}/approve"><button class="btn primary">Approve hold</button></form>
    <form method="post" action="/sim-paypal/checkout/${esc(order.id)}/decline"><button class="btn">Simulate a declined card</button></form>
    <form method="post" action="/sim-paypal/checkout/${esc(order.id)}/cancel"><button class="btn">Cancel</button></form>
  </div>`
  }
</main></body></html>`;
}

/** Stands in for PayPal's own error page when it refuses the buyer's payment method. */
function simDeclinedPage(order: SimOrder) {
  return `${simHead("Simulated decline")}
<main class="sim">
  ${SIM_BANNER}
  <h1>This payment method was declined</h1>
  <p class="muted">Simulated: PayPal couldn't use the buyer's funding for a hold of <span class="num">${fmt(order.totalCents)}</span>. The order stays open, waiting for the buyer, and Remit isn't told.</p>
  <div class="btns">
    <a class="btn primary" href="/sim-paypal/checkout/${esc(order.id)}">Pick a different payment method</a>
    <a class="btn" href="${esc(withToken(order.cancelUrl, order.id))}">Cancel and return to Remit</a>
  </div>
</main></body></html>`;
}

function esc(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
