import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { ShoppingAgent } from "../demo/agent.ts";
import { handleMcpRequest } from "../mcp/http.ts";
import { fmt } from "../money.ts";
import { PayPalError } from "../paypal/gateway.ts";
import { isWaiting, type SimOrder, type SimulatedPayPal } from "../paypal/simulated.ts";
import { agentFromAuthHeader, type AgentRecord } from "../wallet/agents.ts";
import type { LinkSigner } from "../notify/links.ts";
import { mountLinkRoutes } from "../notify/routes.ts";
import { runWalletTool, walletToolDefs, type WalletToolName } from "../wallet/tools.ts";
import { errorText, WalletError, type Wallet } from "../wallet/wallet.ts";
import type { PayPalWebhooks } from "../wallet/webhooks.ts";
import { LoginThrottle, OwnerSessions, safeNext, SESSION_COOKIE, SESSION_TTL_S } from "./session.ts";

export interface AppDeps {
  wallet: Wallet;
  agent: ShoppingAgent;
  simulated?: SimulatedPayPal;
  /** Set when PayPal webhooks are on: always with the simulator, and with PAYPAL_WEBHOOK_ID in sandbox mode. */
  webhooks?: PayPalWebhooks;
  modes: { paypal: string; search: string; agent: string; reviewer: string; model: string; mcp?: string };
  agentToken?: string;
  ownerPassword?: string;
  /** Signs the owner's session cookie. Unset: a random one per start, so a restart signs the owner out. */
  sessionSecret?: string;
  /** One-tap links from notifications. Signed links work without the owner password. */
  links?: { signer: LinkSigner; appUrl: string };
}

/** The one check for agent requests, on /agent/v1/* and /mcp: finds the agent the token belongs to. */
export function agentAuth(deps: AppDeps): MiddlewareHandler<{ Variables: { agent: AgentRecord } }> {
  return async (c, next) => {
    const found = agentFromAuthHeader(deps.wallet.agents, c.req.header("Authorization"), deps.agentToken);
    if (!found) {
      c.header("WWW-Authenticate", 'Bearer realm="remit"');
      return c.json({ error: "UNAUTHORIZED", message: "Unknown or revoked agent token. Add an agent in the Remit app to get one." }, 401);
    }
    c.set("agent", found);
    await next();
  };
}

export function createApp(deps: AppDeps) {
  const { wallet, agent } = deps;
  const app = new Hono<{ Variables: { agent: AgentRecord } }>();
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

  // PayPal can't send the owner password, so this also sits in front of it. Every event is verified instead.
  app.post("/paypal/webhook", async (c) => {
    if (!deps.webhooks) return c.json({ error: "NOT_FOUND", message: "PayPal webhooks are off. Set PAYPAL_WEBHOOK_ID." }, 404);
    const result = await deps.webhooks.receive({ headers: c.req.header(), body: await c.req.text() });
    return c.json(result, result.status);
  });

  // ------------------------------------------------------------ agent API (used by the MCP servers)

  // Each agent has its own token from the Agents page; the shared REMIT_AGENT_TOKEN is the built-in "default" agent.
  const requireAgent = agentAuth(deps);
  app.use("/agent/v1/*", requireAgent);
  app.use("/mcp", requireAgent);
  app.get("/agent/v1/tools", (c) => c.json(Object.keys(walletToolDefs)));
  app.post("/agent/v1/tools/:name", async (c) => {
    const name = c.req.param("name");
    if (!(name in walletToolDefs)) return c.json({ error: "NOT_FOUND", message: `No tool ${name}` }, 404);
    const body = await c.req.json().catch(() => ({}));
    return c.json(await runWalletTool(wallet, name as WalletToolName, body, c.get("agent").id));
  });

  // Remote MCP over Streamable HTTP, for hosted agents. Stateless, so there is no stream to GET or session to DELETE.
  app.post("/mcp", (c) => handleMcpRequest(wallet, c.req.raw, c.get("agent").id));
  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405),
  );

  // ------------------------------------------------------------ one-tap links (signed, so in front of the owner password)

  if (deps.links) mountLinkRoutes(app, { wallet, links: deps.links.signer, appUrl: deps.links.appUrl, agent });

  // ------------------------------------------------------------ owner routes

  // The landing page and the sign-in page are public. Everything else here needs the owner's session cookie
  // (or, for scripts, the same password as Basic auth). Without a password (localhost only) it's all open.
  const sessions = deps.ownerPassword
    ? new OwnerSessions(deps.sessionSecret || randomBytes(32).toString("base64url"), deps.ownerPassword)
    : undefined;
  const throttle = new LoginThrottle();
  const isOwner = (c: Context) => !sessions || sessions.verify(getCookie(c, SESSION_COOKIE)) || basicOwner(sessions, c.req.header("Authorization"));

  app.get("/login", async (c) => {
    if (isOwner(c)) return c.redirect(safeNext(c.req.query("next")));
    return serveFile(c, "./web/login.html");
  });

  app.post("/login", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const next = safeNext(typeof form.next === "string" ? form.next : undefined);
    if (!sessions) return c.redirect(next, 303);
    const who = clientAddress(c);
    const back = (error: string) => c.redirect(`/login?error=${error}&next=${encodeURIComponent(next)}`, 303);
    if (throttle.blocked(who)) return back("wait");
    if (typeof form.password !== "string" || !sessions.checkPassword(form.password)) {
      throttle.fail(who);
      return back("wrong");
    }
    throttle.clear(who);
    setCookie(c, SESSION_COOKIE, sessions.issue(), {
      path: "/",
      httpOnly: true,
      secure: isHttps(c),
      sameSite: "Lax",
      maxAge: SESSION_TTL_S,
    });
    return c.redirect(next, 303);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isHttps(c) });
    return c.redirect("/", 303);
  });

  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/agent/v1/") || path === "/mcp" || isPublicPath(path) || isOwner(c)) return next();
    // A page load goes to the sign-in page and comes back; API calls get a 401 the web app turns into the same trip.
    if (c.req.method === "GET" && !c.req.path.startsWith("/api/")) {
      const url = new URL(c.req.url);
      return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    return c.json({ error: "UNAUTHORIZED", message: "Sign in to Remit." }, 401);
  });

  app.get("/app", (c) => serveFile(c, "./web/app.html"));

  app.get("/api/state", (c) =>
    c.json({
      signIn: !!sessions,
      modes: deps.modes,
      ...wallet.state(),
      agents: wallet.agentSummaries(),
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

  // Owner only: pay for a purchase the purpose check refused. The agent API has no route to this.
  app.post("/api/purchases/:id/override", async (c) => c.json(await wallet.overridePurchase(c.req.param("id"))));

  // Owner only: the agent API above has no route to this.
  app.post("/api/lines/move", async (c) => {
    const body = z
      .object({ from: z.string(), to: z.string(), amountCents: z.number().int().positive() })
      .parse(await c.req.json().catch(() => ({})));
    return c.json(await wallet.moveBetweenLines(body.from, body.to, body.amountCents));
  });

  // ------------------------------------------------------------ owner: agents

  app.get("/api/agents", (c) => c.json({ agents: wallet.agentSummaries(), sharedToken: !!deps.agentToken }));

  // The token is in this response only. Remit keeps just its hash.
  app.post("/api/agents", async (c) => {
    const { name } = z.object({ name: z.string() }).parse(await c.req.json().catch(() => ({})));
    return c.json(wallet.agents.create(name), 201);
  });

  app.post("/api/agents/:id/pause", (c) => c.json({ agent: wallet.agents.setStatus(c.req.param("id"), "paused") }));
  app.post("/api/agents/:id/resume", (c) => c.json({ agent: wallet.agents.setStatus(c.req.param("id"), "active") }));
  app.post("/api/agents/:id/revoke", (c) => c.json({ agent: wallet.agents.revoke(c.req.param("id")) }));

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
      return c.redirect(`/app?approved=${encodeURIComponent(requestId)}`);
    } catch (err) {
      return c.redirect(`/app?error=${encodeURIComponent(errorText(err))}`);
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
    return c.redirect(`/app?${approved ? "approved" : "cancelled"}=${encodeURIComponent(requestId)}`);
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

/** Pages and files anyone can load: the landing page, the sign-in page, and static code, styles and images (no data). */
function isPublicPath(path: string) {
  return /^\/(index\.html|login|logout|[\w-]+\.(css|js)|assets\/[\w.-]+)?$/.test(path);
}

function basicOwner(sessions: OwnerSessions, header: string | undefined) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon >= 0 && decoded.slice(0, colon) === "owner" && sessions.checkPassword(decoded.slice(colon + 1));
}

/** Render and most hosts end TLS at a proxy, so the app itself sees http. */
function isHttps(c: Context) {
  return c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https" || new URL(c.req.url).protocol === "https:";
}

function clientAddress(c: Context) {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
}

async function serveFile(c: Context, path: string): Promise<Response> {
  try {
    return c.html(await readFile(path, "utf8"));
  } catch {
    return c.json({ error: "NOT_FOUND" }, 404);
  }
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
      ? `<p class="muted">This order was already ${order.status.toLowerCase()}.</p><p><a href="/app">Back to Remit</a></p>`
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
  <p class="muted">Simulated: PayPal couldn't use the buyer's funding for a hold of <span class="num">${fmt(order.totalCents)}</span>. The order stays open, waiting for the buyer. The simulator also sends Remit a declined-order webhook.</p>
  <div class="btns">
    <a class="btn primary" href="/sim-paypal/checkout/${esc(order.id)}">Pick a different payment method</a>
    <a class="btn" href="${esc(withToken(order.cancelUrl, order.id))}">Cancel and return to Remit</a>
  </div>
</main></body></html>`;
}

function esc(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
