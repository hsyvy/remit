import type { Context, Env, Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { fmt } from "../money.ts";
import { errorText, type Wallet } from "../wallet/wallet.ts";
import type { LinkCheck, LinkSigner } from "./links.ts";
import { dateRange } from "./notices.ts";
import { approvePage, declinePage, messagePage, overridePage, planPage, type PurchaseDetail } from "./pages.ts";

/** What the plan link needs from the agent. The demo ShoppingAgent fits. */
export interface Planner {
  readonly enabled: boolean;
  readonly isBusy: boolean;
  send(text: string): Promise<void>;
}

export interface LinkRouteDeps {
  wallet: Wallet;
  links: LinkSigner;
  /** Public base URL: PayPal sends the owner back here. */
  appUrl: string;
  agent?: Planner;
}

export const PLAN_PROMPT =
  "The last budget period just closed. Read the history, then plan next week's budget starting today, " +
  "with evidence in each line's reason, and send it to me for approval. Don't buy anything yet.";

/**
 * One-tap links from notifications, at /link/<signed code>. They work without the owner password:
 * the signature is the authorization, and only for the one request (or closed period) and action
 * it was signed for. Opening a link (GET) changes nothing; the button on the page (POST) does.
 * Register before the owner password middleware.
 */
export function mountLinkRoutes<E extends Env>(app: Hono<E>, deps: LinkRouteDeps) {
  const { wallet, links, appUrl } = deps;

  // The link pages use the app's stylesheet and images, which hold nothing private.
  for (const path of ["/styles.css", "/link.css", "/assets/*"]) app.get(path, serveStatic({ root: "./web" }));

  app.use("/link/*", async (c, next) => {
    await next();
    // The code in the URL is a credential: keep it out of caches and Referer headers.
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex");
  });

  const self = (code: string) => `${appUrl}/link/${code}`;

  app.get("/link/:code", (c) => {
    const code = c.req.param("code");
    const check = links.verify(code);
    if (!check.ok) return badLink(c, check, appUrl);
    const { action, ref, expiresAt } = check.claim;
    try {
      if (action === "plan") {
        const busy = planBlocked(deps);
        if (busy) return c.html(messagePage({ title: "Nothing to plan", text: busy, chip: ["", "Week closed"], appUrl }));
        const p = wallet.periodRecap(ref).period;
        return c.html(planPage(`/link/${code}`, appUrl, dateRange(p.startsOn, p.endsOn), expiresAt));
      }
      if (action === "override") {
        const p = wallet.purchaseDetail(ref);
        if (!p.canOverride) return c.html(overrideDonePage(p, appUrl));
        return c.html(overridePage(p, `/link/${code}`, appUrl, expiresAt));
      }
      const r = wallet.requestDetail(ref);
      if (r.status !== "pending" && r.status !== "checkout") return c.html(decidedPage(r.status, appUrl));
      return c.html(action === "approve" ? approvePage(r, `/link/${code}`, appUrl, expiresAt) : declinePage(r, `/link/${code}`, appUrl, expiresAt));
    } catch (err) {
      return c.html(failedPage(err, appUrl), 400);
    }
  });

  app.post("/link/:code", async (c) => {
    const code = c.req.param("code");
    const check = links.verify(code);
    if (!check.ok) return badLink(c, check, appUrl);
    const { action, ref } = check.claim;
    try {
      if (action === "approve") {
        // The same checkout as the app's Approve button, with PayPal sending the owner back to this link.
        const { approveUrl } = await wallet.checkout(ref, [], { returnUrl: `${self(code)}/back`, cancelUrl: `${self(code)}/cancel` });
        return c.redirect(approveUrl, 303);
      }
      if (action === "override") {
        const p = wallet.purchaseDetail(ref);
        if (!p.canOverride) return c.html(overrideDonePage(p, appUrl), 409);
        const paid = await wallet.overridePurchase(ref);
        return c.html(
          messagePage({
            title: "Paid anyway",
            text: `${fmt(paid.amountCents)} for “${p.title}” was taken from your PayPal hold on your override. ${fmt(paid.lineLeftCents)} is left on ${p.lineLabel}.`,
            chip: ["ok", "Paid"],
            appUrl,
          }),
        );
      }
      if (action === "decline") {
        wallet.decline(ref);
        return c.html(messagePage({ title: "Declined", text: "Your agent sees that you declined. Nothing was held on PayPal.", chip: ["no", "Declined"], appUrl }));
      }
      const busy = planBlocked(deps);
      if (busy) return c.html(messagePage({ title: "Nothing to plan", text: busy, chip: ["", "Week closed"], appUrl }), 409);
      deps.agent!.send(PLAN_PROMPT).catch((err) => console.error("agent (plan link):", err));
      return c.html(
        messagePage({
          title: "Your agent is planning",
          text: "It reads the last weeks and drafts a budget. You get a notification with Approve and Decline when it's ready.",
          chip: ["ok", "Planning"],
          appUrl,
        }),
      );
    } catch (err) {
      return c.html(failedPage(err, appUrl), 400);
    }
  });

  // PayPal's return. completeApproval only succeeds if the owner really approved the order on PayPal.
  app.get("/link/:code/back", async (c) => {
    const code = c.req.param("code");
    const check = links.verify(code, "approve");
    if (!check.ok) return badLink(c, check, appUrl);
    try {
      const result = await wallet.completeApproval(check.claim.ref, c.req.query("token") ?? "");
      const text = result.alreadyApproved
        ? "This request was already approved. Your agent can spend within it."
        : `A ${fmt(result.holdCents ?? 0)} hold is in place on PayPal. Your agent can spend only within the lines you approved.`;
      return c.html(messagePage({ title: "Approved", text, chip: ["ok", "Hold active"], appUrl }));
    } catch (err) {
      return c.html(failedPage(err, appUrl), 400);
    }
  });

  // The owner left PayPal without approving, or PayPal refused the card. Ask PayPal which.
  app.get("/link/:code/cancel", async (c) => {
    const code = c.req.param("code");
    const check = links.verify(code, "approve");
    if (!check.ok) return badLink(c, check, appUrl);
    const results = await wallet.checkApprovals({ requestId: check.claim.ref, force: true }).catch(() => []);
    if (results.some((r) => r.outcome === "approved")) {
      return c.html(messagePage({ title: "Approved", text: "PayPal approved it. The hold is in place.", chip: ["ok", "Hold active"], appUrl }));
    }
    return c.html(
      messagePage({
        title: "Not approved yet",
        text: "You came back from PayPal without approving, or PayPal didn't take the payment method. The request is still waiting.",
        chip: ["ask", "Waiting for you"],
        appUrl,
        retry: { action: `/link/${code}`, label: "Try PayPal again" },
      }),
    );
  });
}

/** Why the plan link can't start a plan now, or null if it can. */
function planBlocked(deps: LinkRouteDeps): string | null {
  if (!deps.agent?.enabled) return "The built-in agent is off, so it can't plan. Ask your own agent to plan next week.";
  const current = deps.wallet.balance().period;
  if (current) return current.status === "open" ? "A budget is already open." : "A budget request is already waiting for you.";
  if (deps.agent.isBusy) return "Your agent is busy. Try again in a minute.";
  return null;
}

function badLink(c: Context, check: Exclude<LinkCheck, { ok: true }>, appUrl: string) {
  const text =
    check.why === "expired"
      ? "This link has expired. Links in notifications work for a day. Open Remit to see the request."
      : "This isn't a valid Remit link. Nothing was changed.";
  return c.html(messagePage({ title: "This link doesn't work", text, chip: ["no", check.why === "expired" ? "Expired" : "Invalid"], appUrl }), check.why === "expired" ? 410 : 403);
}

function decidedPage(status: string, appUrl: string) {
  const text =
    status === "approved"
      ? "You already approved this request. Your agent can spend within it."
      : status === "declined"
        ? "You already declined this request."
        : "This request is no longer waiting: its period closed.";
  return messagePage({ title: "Already decided", text, chip: [status === "approved" ? "ok" : "", capitalize(status)], appUrl });
}

/** A Pay anyway link for a purchase that can't be paid anyway any more. */
function overrideDonePage(p: PurchaseDetail, appUrl: string) {
  if (p.override && !p.override.error) {
    return messagePage({ title: "Already paid", text: `You already chose to pay for “${p.title}” anyway.`, chip: ["ok", "Paid anyway"], appUrl });
  }
  const text = p.override?.error
    ? `You chose to pay anyway, but the payment didn't go through: ${p.override.error}`
    : "This purchase can't be paid anyway now: its budget period is over, or it wasn't refused by the purpose check.";
  return messagePage({ title: "Can't pay this now", text, chip: ["no", "Not done"], appUrl });
}

function failedPage(err: unknown, appUrl: string) {
  return messagePage({ title: "That didn't go through", text: errorText(err), chip: ["no", "Not done"], appUrl });
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
