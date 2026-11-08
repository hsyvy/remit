import { fmt } from "../money.ts";
import type { Wallet } from "../wallet/wallet.ts";
import { dateRange } from "./notices.ts";

/** Server-rendered phone pages for the one-tap links. Styled like the app (web/styles.css) plus web/link.css. */

export type RequestDetail = ReturnType<Wallet["requestDetail"]>;

const MARK = `<span class="mk" aria-hidden="true"></span>Remit`;

function page(title: string, chip: string, main: string, foot = "") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/assets/mark.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,400..700&family=Google+Sans+Code:wght@400;500&family=Courier+Prime:wght@400;700&display=swap">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/link.css">
</head><body>
<div class="lk">
  <header class="hd glass"><span class="ws">${MARK}</span>${chip}</header>
  <main class="body">${main}</main>
  ${foot ? `<div class="foot glass">${foot}</div>` : ""}
</div>
</body></html>`;
}

const chip = (kind: "ask" | "ok" | "no" | "", text: string) => `<span class="chip ${kind}"><i></i>${esc(text)}</span>`;

function heading(r: RequestDetail, verb: "Approve" | "Decline") {
  if (r.kind === "topup") return `${verb} ${fmt(r.totalCents)} more for ${r.lines[0]!.label}?`;
  return verb === "Approve" ? `Approve ${fmt(r.totalCents)} for ${dateRange(r.period.startsOn, r.period.endsOn)}?` : `Decline the ${fmt(r.totalCents)} budget request?`;
}

function requestPaper(r: RequestDetail) {
  const asked = `<span>Your agent, ${esc(dateRange(r.createdAt.slice(0, 10), r.createdAt.slice(0, 10)))}</span>`;
  if (r.kind === "topup") {
    const line = r.lines[0]!;
    const now = line.current?.limitCents ?? 0;
    return `<section class="paper" aria-label="The request">
  <p class="why">“${esc(line.reason)}”${asked}</p>
  <div class="sum">
    <div><span>${esc(line.label)} now</span><span class="money">${fmt(now)}</span></div>
    <div><span>Top-up</span><span class="money">+ ${fmt(line.amountCents)}</span></div>
    <div class="tot"><span>After</span><span class="money">${fmt(now + line.amountCents)}</span></div>
  </div>
</section>`;
  }
  const rows = r.lines
    .map((l) => `<li><div><b>${esc(l.label)}</b><small>${esc(l.reason)}</small></div><span class="money">${fmt(l.amountCents)}</span></li>`)
    .join("");
  return `<section class="paper" aria-label="The request">
  <p class="why first">“${esc(r.reason)}”${asked}</p>
  <ul class="lines">${rows}</ul>
  <div class="sum"><div class="tot"><span>Total hold</span><span class="money">${fmt(r.totalCents)}</span></div></div>
</section>`;
}

/** "Nov 9, 12:13 UTC" */
function until(at: Date) {
  const iso = at.toISOString();
  return `${dateRange(iso.slice(0, 10), iso.slice(0, 10))}, ${iso.slice(11, 16)} UTC`;
}

function expiry(expiresAt: Date) {
  return `<p class="k fine">This link is only for this request, and works until ${esc(until(expiresAt))}.</p>`;
}

export function approvePage(r: RequestDetail, action: string, appUrl: string, expiresAt: Date) {
  const release = `Anything unspent is released when the period closes after ${dateRange(r.period.endsOn, r.period.endsOn)}.`;
  const note =
    r.kind === "topup"
      ? `A new hold on PayPal, for this line only. ${release}`
      : `One hold on PayPal for the total. Your agent can spend only within each line. ${release}`;
  return page(
    "Approve on PayPal",
    chip("ask", r.status === "checkout" ? "Sent to PayPal" : "Waiting for you"),
    `<h1 class="t">${esc(heading(r, "Approve"))}</h1>
${requestPaper(r)}
<p class="note">${esc(note)}</p>
${expiry(expiresAt)}`,
    `<form method="post" action="${esc(action)}"><button class="btn pri">Approve on PayPal</button></form>
<a class="btn" href="${esc(`${appUrl}/#${r.id}`)}">Review or edit in Remit</a>`,
  );
}

export function declinePage(r: RequestDetail, action: string, appUrl: string, expiresAt: Date) {
  const note =
    r.kind === "topup"
      ? "Nothing new is held on PayPal. Your agent sees that you declined and keeps to the lines it has."
      : "Nothing is held on PayPal. Your agent sees that you declined and can ask again with a new plan.";
  return page(
    "Decline request",
    chip("ask", "Waiting for you"),
    `<h1 class="t">${esc(heading(r, "Decline"))}</h1>
${requestPaper(r)}
<p class="note">${esc(note)}</p>
${expiry(expiresAt)}`,
    `<form method="post" action="${esc(action)}"><button class="btn danger">Decline</button></form>
<a class="btn" href="${esc(`${appUrl}/#${r.id}`)}">Open Remit instead</a>`,
  );
}

export function planPage(action: string, appUrl: string, range: string, expiresAt: Date) {
  return page(
    "Plan next week",
    chip("", "Week closed"),
    `<h1 class="t">Plan the next budget?</h1>
<p class="note">${esc(range)} is closed. Your agent reads the history and drafts next week's budget, with a reason for each line. Nothing is held until you approve it on PayPal.</p>
<p class="k fine">This link only asks for a plan, and works until ${esc(until(expiresAt))}.</p>`,
    `<form method="post" action="${esc(action)}"><button class="btn pri">Ask my agent to plan</button></form>
<a class="btn" href="${esc(appUrl)}/#ledger">Open Remit</a>`,
  );
}

/** The end of a flow, or a link that can't be used. */
export function messagePage(opts: { title: string; text: string; chip: [kind: "ask" | "ok" | "no" | "", text: string]; appUrl: string; retry?: { action: string; label: string } }) {
  const retry = opts.retry ? `<form method="post" action="${esc(opts.retry.action)}"><button class="btn pri">${esc(opts.retry.label)}</button></form>` : "";
  return page(
    opts.title,
    chip(...opts.chip),
    `<h1 class="t">${esc(opts.title)}</h1>
<p class="note">${esc(opts.text)}</p>`,
    `${retry}<a class="btn${retry ? "" : " pri"}" href="${esc(opts.appUrl)}/">Open Remit</a>`,
  );
}

function esc(text: string) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
