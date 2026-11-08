// Remit owner app. Polls /api/state and renders it into three views (this week, requests, ledger)
// plus the agent chat; no build step.

const $ = (id) => document.getElementById(id);
const money = (cents) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
// Approximate rupee figure next to a dollar amount. PayPal itself works in USD.
const inr = (cents) => (state?.inrRate ? `≈ ₹${Math.round((cents / 100) * state.inrRate).toLocaleString("en-IN")}` : "");
const both = (cents) => `${money(cents)}${state?.inrRate ? ` <span class="inr">${inr(cents)}</span>` : ""}`;
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const pct = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const day = (iso) => new Date(`${iso}T12:00:00`);
const monthDay = (iso) => day(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const weekdayDate = (iso) => day(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
/** "Nov 9 – 15", or "Oct 26 – Nov 1" across a month. */
function range(startIso, endIso) {
  const a = day(startIso);
  const b = day(endIso);
  return a.getMonth() === b.getMonth()
    ? `${monthDay(startIso)} – ${b.getDate()}`
    : `${monthDay(startIso)} – ${monthDay(endIso)}`;
}
/** "Sun 21:14" */
const when = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
};

const ASSET = "/assets";
const STAMP = {
  paid: `${ASSET}/stamp-paid.webp`,
  refused: `${ASSET}/stamp-refused.webp`,
  ask: `${ASSET}/stamp-ask.webp`,
  approved: `${ASSET}/stamp-approved.webp`,
  returned: `${ASSET}/stamp-returned.webp`,
};
const stamp = (kind, alt) => `<img class="stamp" src="${STAMP[kind]}" alt="${esc(alt)}">`;
// One envelope colour per line, in plan order; the shared buffer always gets the pink one.
const ENVELOPES = ["gro", "dog", "gift"];
const SPARK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.5 3.2 1.8 5 5 5.6v.4c-3.2.6-4.5 2.4-5 5.5h-.4c-.5-3.1-1.8-4.9-5-5.5v-.4c3.2-.6 4.5-2.4 5-5.6z" fill="currentColor"/></svg>`;
const PLUG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

let state = null;
let pollTimer = null;
let ledgerFilter = "all";
const rendered = { requests: "", chat: "", move: "", ledger: "" };

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Request failed (${res.status})`);
  return json;
}

async function refresh() {
  try {
    state = await api("/api/state");
    render();
  } catch (err) {
    flash(err.message, true);
  }
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, state?.agentBusy ? 1200 : 5000);
}

let flashTimer = null;
function flash(text, isError = false) {
  $("flash").innerHTML = text ? `<p class="${isError ? "err" : ""}" role="${isError ? "alert" : "status"}">${esc(text)}</p>` : "";
  clearTimeout(flashTimer);
  if (text && !isError) flashTimer = setTimeout(() => flash(""), 8000);
}

// ------------------------------------------------------------ routing

const VIEWS = ["week", "requests", "ledger", "agent"];

/** The view for the current hash. A request id (from an agent's review link) opens Requests. */
function currentView() {
  const hash = location.hash.slice(1);
  if (VIEWS.includes(hash)) return hash;
  if (hash && state?.requests.some((r) => r.id === hash)) return "requests";
  return "week";
}

function showView() {
  const view = currentView();
  $("app").dataset.view = view;
  // On wide screens the chat is always beside the page, so #agent shows this week behind it.
  const page = view === "agent" ? "week" : view;
  for (const v of ["week", "requests", "ledger"]) $(`view-${v}`).hidden = v !== page;
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.dataset.nav === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (view === "agent") $("log").scrollTop = $("log").scrollHeight;
}

function go(view) {
  if (location.hash !== `#${view}`) location.hash = view;
  else showView();
}

window.addEventListener("hashchange", () => {
  showView();
  const hash = location.hash.slice(1);
  if (VIEWS.includes(hash)) window.scrollTo({ top: 0 });
  else revealRequest(hash);
});

/** Scroll to a request card; the first one keeps the page title in view. */
function revealRequest(id) {
  const card = document.getElementById(id);
  if (!card) return;
  if (card === $("requests").firstElementChild) window.scrollTo({ top: 0 });
  else card.scrollIntoView({ block: "start" });
}

// ------------------------------------------------------------ render

function render() {
  renderSide();
  renderWeek();
  renderRequests();
  renderLedger();
  renderChat();
  showView();
}

function renderSide() {
  const m = state.modes;
  const agent = (on, title, note, icon) =>
    `<div class="agent${on ? "" : " off"}"><span class="pic">${icon}</span><span>${esc(title)}<small>${esc(note)}</small></span></div>`;
  $("agents").innerHTML = [
    agent(m.agent === "on", "Remit’s shopping agent", m.agent === "on" ? "Built in. Plans and shops here." : "Off. Needs ANTHROPIC_API_KEY.", SPARK),
    agent(m.mcp === "on", "Your own agents", m.mcp === "on" ? "Connect over MCP with a token." : "Off. Needs REMIT_AGENT_TOKEN.", PLUG),
  ].join("");

  const chip = (text, live) => `<span class="chip sm plate ${live ? "live" : "stand-in"}"><i></i>${esc(text)}</span>`;
  $("modes").innerHTML = [
    chip(m.paypal === "sandbox" ? "PayPal sandbox" : "Simulated checkout", m.paypal === "sandbox"),
    chip(m.agent === "on" ? `Agent · ${m.model}` : "Agent off", m.agent === "on"),
    chip(m.reviewer === "on" ? "Purpose check on" : "Purpose check off", m.reviewer === "on"),
    chip(m.search === "channel3" ? "Channel3 search" : "Built-in catalog", m.search === "channel3"),
  ].join("");

  const { period, totals } = state;
  let foot = "<b>No hold</b>Nothing is held on PayPal until you approve a plan.";
  if (period?.status === "open") foot = `<b>${money(totals.heldCents)} held on PayPal</b>What’s left is released on ${esc(weekdayDate(period.endsOn))}.`;
  else if (period?.status === "closed") foot = `<b>Period closed</b>${esc(range(period.startsOn, period.endsOn))}. Your agent can’t spend until you approve a new plan.`;
  $("sfoot").innerHTML = foot;

  const n = state.requests.length;
  $("req-count").hidden = !n;
  $("req-count").textContent = String(n);
}

// ------------------------------------------------------------ this week

const isWeek = (p) => (day(p.endsOn) - day(p.startsOn)) / 86_400_000 <= 7;

function renderWeek() {
  const { period, totals, purchases, holds, requests } = state;
  const waitingCents = requests.reduce((s, r) => s + r.totalCents, 0);
  const asks = requests.map(askRow).join("");

  if (!period || period.status === "declined") {
    $("week-title").textContent = "No plan yet";
    $("week-sub").textContent = "Your agent can’t spend anything until you approve a plan on PayPal.";
    $("week-acts").innerHTML = "";
    $("week-body").innerHTML = asks || emptyPlan();
    $("week-grid").hidden = !state.events.length;
    $("lines").innerHTML = `<p class="empty">Lines appear here once you approve a plan.</p>`;
    $("move-form").hidden = true;
    renderEvents();
    wireEmpty();
    return;
  }

  const span = range(period.startsOn, period.endsOn);
  const closed = period.status === "closed";
  const pending = period.status === "pending";
  $("week-title").textContent = closed ? `Closed: ${span}` : isWeek(period) ? "This week" : "This period";
  $("week-sub").textContent = closed ? period.summary : `${span}. ${period.summary}`;

  const label = isWeek(period) ? "week" : "period";
  $("week-acts").innerHTML = pending
    ? `<span class="chip ask"><i></i>Waiting for you</span>`
    : closed
      ? `<span class="chip plate"><i></i>Closed</span>`
      : `<span class="chip plate live"><i></i>Hold active on PayPal</span><button class="btn sm" id="close-period" type="button">Close the ${label}</button>`;

  const paid = purchases.filter((p) => p.status === "captured" || p.status === "refunded").length;
  const refused = purchases.filter((p) => p.status === "refused").length;
  // After close, everything not captured comes back: voided holds at once, partly captured ones when PayPal's hold expires.
  const unspent = holds.reduce((s, h) => s + h.amountCents - h.capturedCents, 0);
  const notes = [
    totals.refundedCents ? `${money(totals.refundedCents)} refunded to you.` : "",
    ...holds.filter((h) => h.releaseNote).map((h) => h.releaseNote),
  ].filter(Boolean);

  const headline = pending
    ? `<div class="k">Left to spend</div><div class="big">$0.00</div><div class="k">until you approve the plan</div>`
    : closed
      ? `<div class="k">Not spent, back to you</div><div class="big">${money(unspent)}<span class="inr">${inr(unspent)}</span></div><div class="k">of ${money(totals.approvedCents)} approved</div>`
      : `<div class="k">Left to spend</div><div class="big">${money(totals.heldCents)}<span class="inr">${inr(totals.heldCents)}</span></div><div class="k">of ${money(totals.approvedCents)} held on PayPal</div>`;

  $("week-body").innerHTML = `
    <section class="purse glass" aria-label="Balance" aria-live="polite">
      <div>${headline}</div>
      <div class="stats">
        <div><div class="k">Spent · ${plural(paid, "purchase")}</div><div class="v">${money(totals.spentCents)}</div></div>
        <div><div class="k">Refused</div><div class="v">${refused}</div></div>
        ${waitingCents ? `<div><div class="k">Waiting for you</div><div class="v amber">${money(waitingCents)}</div></div>` : ""}
      </div>
      <div class="purse-notes">${notes.map((n) => `<span>${esc(n)}</span>`).join("")}</div>
    </section>
    ${asks}`;

  $("close-period")?.addEventListener("click", async (e) => {
    if (!confirm(`Close the ${label} now? Unspent money is released and your agent can’t spend until you approve a new plan.`)) return;
    e.target.disabled = true;
    try {
      await api("/api/period/close", {});
      flash(`The ${label} is closed. What wasn’t spent is released to you.`);
    } catch (err) {
      flash(err.message, true);
    }
    refresh();
  });

  $("week-grid").hidden = false;
  renderLines();
  renderEvents();
}

function emptyPlan() {
  const on = state.modes.agent === "on";
  return `
    <section class="paper empty-state">
      <div>
        <h2>Ask your agent for a plan</h2>
        <p>It looks at what you usually buy and proposes a budget with a reason for every line. You can change it, then approve it on PayPal. Nothing is held until you do.</p>
        ${on ? `<p style="margin-top:18px"><button class="btn pri" id="ask-plan" type="button">Plan my budget for this week</button></p>` : ""}
      </div>
      <img src="${ASSET}/gro-front.webp" alt="">
    </section>`;
}

function wireEmpty() {
  $("ask-plan")?.addEventListener("click", () => {
    send("Plan my budget for this week");
    if (matchMedia("(max-width: 1280px)").matches) go("agent");
  });
}

function askRow(r) {
  const label = r.kind === "topup" ? r.lines[0]?.label : null;
  const head = label
    ? `Your agent is asking for ${money(r.totalCents)} more for ${esc(label)}.`
    : `Your agent is asking for ${money(r.totalCents)} for ${state.period?.status === "pending" ? esc(range(state.period.startsOn, state.period.endsOn)) : "a new plan"}.`;
  const why = r.kind === "topup" ? r.lines[0]?.reason || r.reason : r.reason;
  return `
    <section class="askrow paper" aria-label="Request waiting for you">
      ${stamp("ask", "Ask you")}
      <p>${head}<span>${esc(why)}</span></p>
      <a class="btn pri sm" href="#${esc(r.id)}">Review request</a>
    </section>`;
}

function envelopeFor(line, index, lines) {
  if (line.key === "buffer") return `${ASSET}/buf-front.webp`;
  const order = lines.filter((l) => l.key !== "buffer").indexOf(line);
  return `${ASSET}/${ENVELOPES[(order < 0 ? index : order) % ENVELOPES.length]}-front.webp`;
}

function renderLines() {
  const lines = state.lines;
  $("lines").innerHTML = lines.length
    ? lines
        .map(
          (l, i) => `
      <div class="ln">
        <img src="${envelopeFor(l, i, lines)}" alt="">
        <b>${esc(l.label)}<span class="key">${esc(l.key)}</span></b>
        <span class="amt"><b class="money">${money(l.leftCents)}</b> left of ${both(l.limitCents)}</span>
        <small>${esc(l.reason)}</small>
        <div class="track" role="img" aria-label="${money(l.usedCents)} used of ${money(l.limitCents)}"><div class="fill" style="width:${pct(l.usedCents, l.limitCents)}%"></div></div>
      </div>`,
        )
        .join("")
    : `<p class="empty">Lines appear here once you approve the plan.</p>`;
  renderMoveForm();
}

// Owner-only: move unspent money between lines. Options are rebuilt only when the lines change,
// so a poll doesn't wipe what the owner picked.
function renderMoveForm() {
  const open = state.period?.status === "open";
  const lines = state.lines;
  $("move-form").hidden = !open || lines.length < 2;
  const sig = JSON.stringify(lines.map((l) => [l.key, l.leftCents]));
  if (sig === rendered.move) return;
  rendered.move = sig;
  for (const id of ["move-from", "move-to"]) {
    const select = $(id);
    const picked = select.value;
    select.innerHTML = lines.map((l) => `<option value="${esc(l.key)}">${esc(l.label)} · ${money(l.leftCents)} left</option>`).join("");
    if (lines.some((l) => l.key === picked)) select.value = picked;
  }
  if ($("move-from").value === $("move-to").value) $("move-to").value = lines.find((l) => l.key !== $("move-from").value)?.key ?? "";
}

/** Fill the move form for a line that came up short, taking from the line with the most unspent. */
function prefillMove(toKey, cents) {
  const from = state.lines.filter((l) => l.key !== toKey).sort((a, b) => b.leftCents - a.leftCents)[0];
  if (from) $("move-from").value = from.key;
  $("move-to").value = toKey;
  $("move-amount").value = (cents / 100).toFixed(2);
  const form = $("move-form");
  const reveal = () => {
    form.scrollIntoView({ block: "center", behavior: "smooth" });
    form.classList.remove("flash-in");
    void form.offsetWidth;
    form.classList.add("flash-in");
    $("move-amount").focus({ preventScroll: true });
  };
  // Coming from the ledger: wait for the view switch (which scrolls to the top) before scrolling to the form.
  if (location.hash === "#week") reveal();
  else {
    window.addEventListener("hashchange", () => requestAnimationFrame(reveal), { once: true });
    location.hash = "week";
  }
}

/** How much more a refused purchase needs on its line (line plus buffer), or 0 if it would fit now. */
function shortfall(p) {
  const line = state.lines.find((l) => l.key === p.lineKey);
  if (!line) return 0;
  const buffer = line.key === "buffer" ? null : state.lines.find((l) => l.key === "buffer");
  return Math.max(0, p.amountCents - line.leftCents - (buffer?.leftCents ?? 0));
}

$("move-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const from = $("move-from").value;
  const to = $("move-to").value;
  const amountCents = Math.round(Number($("move-amount").value) * 100);
  if (from === to) return flash("Pick two different lines.", true);
  if (!(amountCents > 0)) return flash("Enter an amount to move.", true);
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/lines/move", { from, to, amountCents });
    const label = (key) => state.lines.find((l) => l.key === key)?.label ?? key;
    flash(`Moved ${money(amountCents)} from ${label(from)} to ${label(to)}. Your agent can try again.`);
    $("move-amount").value = "";
  } catch (err) {
    flash(err.message, true);
  }
  button.disabled = false;
  refresh();
});

// Which stamp an activity entry gets, by event type.
const EVENT_STAMP = {
  spent: ["paid", "Paid"],
  spend_refused: ["refused", "Refused"],
  spend_failed: ["refused", "Failed"],
  budget_requested: ["ask", "Asked you"],
  topup_requested: ["ask", "Asked you"],
  approved: ["approved", "Approved"],
  closed: ["returned", "Returned"],
  refunded: ["returned", "Returned"],
};

function renderEvents() {
  $("events").innerHTML = state.events.length
    ? state.events
        .slice(0, 14)
        .map((e) => {
          const s = EVENT_STAMP[e.type];
          return `<li class="row${s ? "" : " plain"}"><div><div class="tt">${esc(e.message)}</div><div class="m">${esc(when(e.at))}</div></div>${s ? stamp(s[0], s[1]) : ""}</li>`;
        })
        .join("")
    : `<li class="empty">Nothing yet.</li>`;
}

// ------------------------------------------------------------ requests

function renderRequests() {
  const sig = JSON.stringify([state.requests.map((r) => [r.id, r.status, r.totalCents, r.approval?.state, r.approval?.detail]), state.period?.id]);
  if (sig === rendered.requests) return;
  rendered.requests = sig;
  $("requests").innerHTML = state.requests.length
    ? state.requests.map(requestCard).join("")
    : `<section class="paper empty-state"><div><h2>Nothing waiting for you</h2><p>When your agent proposes a plan or asks for more money, it shows up here for you to review and approve on PayPal.</p></div><img src="${STAMP.approved}" alt="" class="stamp"></section>`;
  for (const r of state.requests) wireRequest(r);
  if (location.hash && state.requests.some((r) => `#${r.id}` === location.hash)) {
    requestAnimationFrame(() => revealRequest(location.hash.slice(1)));
  }
}

// What to tell the owner when they went to PayPal but the approval didn't go through.
function approvalNote(a) {
  if (!a) return "";
  const text =
    a.state === "voided"
      ? "PayPal cancelled this approval before it was finished. Approve it again to start over."
      : a.state === "failed"
        ? `PayPal didn't approve this: ${a.detail}. Try again, or pick a different payment method on PayPal's page.`
        : "PayPal didn't approve this. Try again, or pick a different payment method on PayPal's page.";
  return `<p class="warn" role="status" style="margin-bottom:16px">${esc(text)}</p>`;
}

function requestCard(r) {
  const budget = r.kind === "budget";
  const pendingPeriod = state.period?.status === "pending" ? state.period : null;
  const ends = budget ? pendingPeriod?.endsOn : state.period?.endsOn;
  const target = budget ? (pendingPeriod ? range(pendingPeriod.startsOn, pendingPeriod.endsOn) : "New plan") : `+ ${money(r.totalCents)}`;
  const lines = r.lines
    .map((l) => {
      const cents = l.approvedCents ?? l.amountCents;
      const kept = cents > 0;
      return `
      <div class="lgrp ${kept ? "" : "removed"}" data-line="${esc(l.id)}" data-kept="${kept}">
        <div class="lrow">
          <span class="lbl">${esc(l.label)}</span><span class="dots"></span>
          <span class="amt-in">$<input type="text" inputmode="decimal" value="${((kept ? cents : l.amountCents) / 100).toFixed(2)}" aria-label="Amount for ${esc(l.label)}"></span>
          <button class="x2" type="button" aria-pressed="${!kept}" aria-label="Strike ${esc(l.label)}" title="Strike or restore this line">×</button>
        </div>
        <p class="why">${esc(l.reason)}${state.inrRate ? ` <span class="inr" data-inr>${inr(kept ? cents : l.amountCents)}</span>` : ""}</p>
      </div>`;
    })
    .join("");
  const facts = budget
    ? [
        `PayPal holds <span data-total-text>${money(r.totalCents)}</span>. It stays in your account.`,
        `Your agent can spend only from these ${plural(r.lines.length, "line")}, one purchase at a time.`,
        "Each purchase is checked against its line before money moves.",
        ends ? `Whatever is left on ${esc(weekdayDate(ends))} is released to you.` : "Whatever isn’t spent is released to you.",
      ]
    : [
        `PayPal places a separate hold of <span data-total-text>${money(r.totalCents)}</span>.`,
        `It adds to ${esc(r.lines[0]?.label ?? "this line")} only. Your other lines don’t change.`,
        `Purchases take from the oldest hold first.${ends ? ` Anything unspent is released on ${esc(weekdayDate(ends))}.` : ""}`,
      ];
  return `
    <article class="req" id="${esc(r.id)}" aria-label="${budget ? "Budget request" : "Top-up request"}">
      <div class="paper sheet">
        <div class="lrow hd"><b>${budget ? "Budget request" : "Top-up request"}</b><span class="dots"></span><b>${esc(target)}</b></div>
        ${approvalNote(r.approval)}
        ${r.reason && (budget || r.reason !== r.lines[0]?.reason) ? `<p class="note">${esc(r.reason)}</p>` : ""}
        ${lines}
        <div class="lrow tot"><b>Total</b><span class="dots"></span><b data-total>${money(r.totalCents)}</b></div>
        <div class="hand">Prepared by your agent, ${esc(when(r.createdAt))}</div>
      </div>
      <aside class="approve glass" aria-label="Approve">
        <div><div class="k">You’re approving</div><div class="big" data-total>${money(r.totalCents)}</div>${state.inrRate ? `<div class="k" data-total-inr>${inr(r.totalCents)}</div>` : ""}</div>
        <ul class="facts">${facts.map((f) => `<li>${f}</li>`).join("")}</ul>
        <div class="acts">
          <button class="btn pri" data-act="approve" type="button">${r.approval ? "Try again on PayPal" : `<span>Approve <span data-total>${money(r.totalCents)}</span> on PayPal</span>`}</button>
          <button class="btn ghost" data-act="decline" type="button">Decline</button>
        </div>
      </aside>
    </article>`;
}

function wireRequest(r) {
  const card = document.getElementById(r.id);
  const typed = (row) => {
    const cents = Math.round(Number(row.querySelector("input").value.replace(/[$,\s]/g, "")) * 100);
    return Number.isFinite(cents) ? Math.max(0, cents) : 0;
  };
  const readEdits = () =>
    [...card.querySelectorAll("[data-line]")].map((row) => ({
      lineId: row.dataset.line,
      amountCents: row.dataset.kept === "true" ? typed(row) : 0,
    }));
  const update = () => {
    const edits = readEdits();
    card.querySelectorAll("[data-line]").forEach((row, i) => {
      row.classList.toggle("removed", edits[i].amountCents === 0);
      const inrEl = row.querySelector("[data-inr]");
      if (inrEl) inrEl.textContent = inr(typed(row));
    });
    const total = edits.reduce((s, e) => s + e.amountCents, 0);
    card.querySelectorAll("[data-total], [data-total-text]").forEach((el) => (el.textContent = money(total)));
    const inrTotal = card.querySelector("[data-total-inr]");
    if (inrTotal) inrTotal.textContent = inr(total);
    card.querySelector('[data-act="approve"]').disabled = total === 0;
  };
  card.addEventListener("input", update);
  card.querySelectorAll(".x2").forEach((btn) =>
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-line]");
      const kept = row.dataset.kept !== "true";
      row.dataset.kept = String(kept);
      btn.setAttribute("aria-pressed", String(!kept));
      if (kept && typed(row) === 0) {
        const line = r.lines.find((l) => l.id === row.dataset.line);
        row.querySelector("input").value = ((line?.amountCents ?? 0) / 100).toFixed(2);
      }
      update();
    }),
  );
  card.querySelector('[data-act="approve"]').addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { approveUrl } = await api(`/api/requests/${r.id}/checkout`, { edits: readEdits() });
      location.href = approveUrl;
    } catch (err) {
      flash(err.message, true);
      btn.disabled = false;
    }
  });
  card.querySelector('[data-act="decline"]').addEventListener("click", async () => {
    if (!confirm("Decline this request? Your agent can’t spend that money.")) return;
    try {
      await api(`/api/requests/${r.id}/decline`, {});
      flash("Declined. Your agent can’t spend that money.");
    } catch (err) {
      flash(err.message, true);
    }
    rendered.requests = "";
    refresh();
  });
}

// ------------------------------------------------------------ ledger

const STATUS = {
  captured: ["ok", "Paid"],
  refused: ["no", "Refused"],
  refunded: ["", "Refunded"],
  failed: ["no", "Failed"],
  pending: ["ask", "Paying"],
};
const FILTERS = [
  ["all", "All", () => true],
  ["paid", "Paid", (p) => p.status === "captured"],
  ["refused", "Refused", (p) => p.status === "refused" || p.status === "failed"],
  ["refunded", "Refunded", (p) => p.status === "refunded"],
];

// An OVER_LINE refusal: refused before the purpose check ran, on a line that still exists and is still short.
const canMoveFor = (p) => p.status === "refused" && !p.review && state.period?.status === "open" && state.lines.length > 1 && shortfall(p) > 0;

function renderLedger() {
  const items = state.purchases;
  // Re-render only when something changed, so a poll doesn't swap the buttons under the owner's pointer.
  const sig = JSON.stringify([ledgerFilter, items.map((p) => [p.id, p.status]), state.lines.map((l) => l.leftCents), state.period?.status, state.totals]);
  if (sig === rendered.ledger) return;
  rendered.ledger = sig;
  const seg = $("ledger-filter");
  seg.innerHTML = FILTERS.filter(([key, , test]) => key === "all" || key === ledgerFilter || items.some(test))
    .map(([key, label, test]) => `<button type="button" data-filter="${key}" aria-pressed="${key === ledgerFilter}">${label}<span>${items.filter(test).length}</span></button>`)
    .join("");
  const test = FILTERS.find(([key]) => key === ledgerFilter)?.[2] ?? (() => true);
  const shown = items.filter(test);
  const lineLabel = (key) => state.lines.find((l) => l.key === key)?.label ?? key;

  $("purchases").innerHTML = shown.length
    ? `<ol class="entries">${shown
        .map((p) => {
          const [cls, text] = STATUS[p.status] ?? ["", p.status];
          const crossed = p.status === "refused" || p.status === "failed";
          const acts = [
            canMoveFor(p)
              ? `<button class="btn xs" data-move-to="${esc(p.lineKey)}" data-cents="${shortfall(p)}" type="button">Move money to this line</button><small>${money(shortfall(p))} short</small>`
              : "",
            p.status === "captured" ? `<button class="btn xs" data-refund="${esc(p.id)}" type="button">Refund to me</button>` : "",
          ].join("");
          const meta = [
            esc(lineLabel(p.lineKey)),
            p.fromBufferCents ? `${money(p.fromBufferCents)} from the buffer` : "",
            esc(p.merchant),
            p.agent === "mcp" ? "via MCP" : "",
          ].filter(Boolean);
          return `<li class="entry">
            <div class="w">${esc(when(p.createdAt))}</div>
            <div class="what">
              <b>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>` : esc(p.title)}</b>
              <div class="meta">${meta.join(" · ")}</div>
              <p class="why"><span>Agent’s reason</span>${esc(p.reasoning)}</p>
              ${p.review && p.review.verdict !== "skipped" ? `<p class="pc ${p.review.verdict === "approve" ? "ok" : "no"}"><span>Purpose check</span>${esc(p.review.reason)}</p>` : ""}
              ${p.refusal ? `<p class="refusal"><span>Refused</span>${esc(p.refusal)}</p>` : ""}
            </div>
            <div class="side-col">
              <div class="money${crossed ? " x" : ""}">${money(p.amountCents)}</div>
              ${state.inrRate ? `<div class="inr">${inr(p.amountCents)}</div>` : ""}
              <span class="chip ${cls}"><i></i>${text}</span>
              ${acts ? `<div class="acts">${acts}</div>` : ""}
            </div>
          </li>`;
        })
        .join("")}</ol>`
    : `<p class="empty" style="padding:4px 0 16px">${items.length ? "Nothing in this view." : "No purchases yet. When your agent buys something, it shows up here with its reason."}</p>`;

  const { totals } = state;
  const refused = items.filter((p) => p.status === "refused");
  $("totals").innerHTML = [
    `<span>Approved <b class="money">${money(totals.approvedCents)}</b></span>`,
    `<span>Spent <b class="money">${money(totals.spentCents)}</b></span>`,
    state.period?.status === "open" ? `<span>Still held <b class="money">${money(totals.heldCents)}</b></span>` : "",
    refused.length ? `<span>Refused <b class="money">${money(refused.reduce((s, p) => s + p.amountCents, 0))}</b></span>` : "",
    totals.refundedCents ? `<span>Refunded <b class="money">${money(totals.refundedCents)}</b></span>` : "",
  ].join("");

  seg.querySelectorAll("[data-filter]").forEach((btn) =>
    btn.addEventListener("click", () => {
      ledgerFilter = btn.dataset.filter;
      renderLedger();
    }),
  );
  $("purchases").querySelectorAll("[data-move-to]").forEach((btn) =>
    btn.addEventListener("click", () => prefillMove(btn.dataset.moveTo, Number(btn.dataset.cents))),
  );
  $("purchases").querySelectorAll("[data-refund]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Refund this purchase to your PayPal account?")) return;
      btn.disabled = true;
      try {
        await api(`/api/purchases/${btn.dataset.refund}/refund`, {});
        flash("Refunded to you.");
      } catch (err) {
        flash(err.message, true);
      }
      refresh();
    }),
  );
}

// ------------------------------------------------------------ chat

function toolLine(t) {
  const i = t.input ?? {};
  const r = t.result ?? {};
  if (t.isError) return `${t.name} · ${typeof r === "string" ? r : JSON.stringify(r)}`;
  switch (t.name) {
    case "spend":
      return `spend $${Number(i.amount).toFixed(2)} · ${i.title} · line ${i.line} → paid, ${r.line_left ?? "?"} left on line`;
    case "request_budget":
      return `request_budget ${r.total ?? ""} · ${i.starts_on} to ${i.ends_on} → waiting for you`;
    case "request_topup":
      return `request_topup ${r.amount ?? ""} · ${i.line} → waiting for you`;
    case "search_products":
      return `search "${i.query}" → ${r.products?.length ?? 0} results`;
    case "get_history":
      return `get_history → ${r.periods?.length ?? 0} earlier periods`;
    case "get_balance":
      return `get_balance → ${r.left ?? r.budget ?? ""}`;
    default:
      return t.name;
  }
}

function renderChat() {
  const { chat, agentBusy, agentError, modes } = state;
  const sig = JSON.stringify([chat.length, chat.at(-1), agentBusy, agentError, modes.agent]);
  if (sig === rendered.chat) return;
  rendered.chat = sig;
  const log = $("log");
  const parts = [];
  if (modes.agent !== "on") {
    parts.push(
      `<p class="warn">The built-in agent is off. Add ANTHROPIC_API_KEY to .env and restart to chat here. Approvals, the ledger and agents connected over MCP work without it.</p>`,
    );
  } else if (!chat.length) {
    parts.push(`<p class="empty">Ask your agent to plan a budget. It looks at past weeks and current prices, then sends you a request to approve.</p>`);
  }
  for (const item of chat) {
    if (item.kind === "text") parts.push(`<div class="msg ${item.role === "user" ? "user" : "assistant"}">${esc(item.text)}</div>`);
    else {
      const moves = ["spend", "request_budget", "request_topup"].includes(item.name);
      parts.push(`<div class="tool ${item.isError ? "err" : moves ? "money" : ""}">${esc(toolLine(item))}</div>`);
    }
  }
  if (agentBusy) parts.push(`<div class="working">Working</div>`);
  if (agentError) parts.push(`<p class="warn">Your agent stopped: ${esc(agentError)}</p>`);
  log.innerHTML = parts.join("");
  log.scrollTop = log.scrollHeight;
  const off = agentBusy || modes.agent !== "on";
  $("send").disabled = off;
  $("suggest").querySelectorAll("button").forEach((b) => (b.disabled = off));
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  $("chat-input").value = "";
  autosize();
  try {
    await api("/api/chat", { message: text });
  } catch (err) {
    flash(err.message, true);
  }
  refresh();
}

function autosize() {
  const el = $("chat-input");
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + 3, 140)}px`;
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("chat-input").value);
});
$("chat-input").addEventListener("input", autosize);
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(e.target.value);
  }
});
$("suggest").addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") send(e.target.textContent);
});
$("reset").addEventListener("click", async () => {
  if (!confirm("Start a new chat? The wallet and ledger stay as they are.")) return;
  try {
    await api("/api/chat/reset", {});
  } catch (err) {
    flash(err.message, true);
  }
  refresh();
});

// ------------------------------------------------------------ start

// Messages from the PayPal round trip.
const params = new URLSearchParams(location.search);
if (params.get("approved")) flash("Approved. The hold is in place and your agent can spend within it.");
if (params.get("cancelled")) flash("You came back from PayPal without approving. The request is still here if you want to try again.");
if (params.get("error")) flash(`Approval didn't go through: ${params.get("error")}`, true);
const backTo = params.get("cancelled") ? `#${params.get("cancelled")}` : params.get("approved") ? "#week" : location.hash;
if (params.size) history.replaceState(null, "", location.pathname + backTo);

// Ask PayPal about requests left in checkout once, when the app opens (the 5-second poll doesn't).
// This catches a refused card or an abandoned PayPal page, and an approval whose redirect got lost.
async function checkPaypal() {
  try {
    const { results } = await api("/api/paypal/check", {});
    if (results.some((r) => r.outcome === "approved")) flash("PayPal approved it. The hold is in place and your agent can spend within it.");
    if (results.some((r) => r.outcome !== "skipped" && r.outcome !== "unknown")) refresh();
  } catch {
    // Not worth a message: the card still works, and the next load checks again.
  }
}

showView();
refresh();
if (!params.get("cancelled")) checkPaypal();
