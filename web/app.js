// Remit owner app. Polls /api/state and renders it; no build step.

const $ = (id) => document.getElementById(id);
const money = (cents) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
// Approximate rupee figure next to a dollar amount. PayPal itself works in USD.
const inr = (cents) => (state?.inrRate ? `≈ ₹${Math.round((cents / 100) * state.inrRate).toLocaleString("en-IN")}` : "");
const both = (cents) => `${money(cents)}${state?.inrRate ? ` <span class="inr">${inr(cents)}</span>` : ""}`;
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const pct = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);
const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

let state = null;
let pollTimer = null;
const rendered = { requests: "", chat: "" };

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

function flash(text, isError = false) {
  $("flash").innerHTML = text ? `<p class="${isError ? "err" : ""}">${esc(text)}</p>` : "";
}

function render() {
  renderModes();
  renderMeter();
  renderRequests();
  renderLines();
  renderPurchases();
  renderEvents();
  renderChat();
}

function renderModes() {
  const m = state.modes;
  const chip = (text, live) => `<span class="chip ${live ? "live" : "stand-in"}">${esc(text)}</span>`;
  $("modes").innerHTML = [
    chip(m.paypal === "sandbox" ? "PayPal sandbox" : "PayPal simulated", m.paypal === "sandbox"),
    chip(m.search === "channel3" ? "Channel3 search" : "Demo catalog", m.search === "channel3"),
    chip(m.agent === "on" ? `Claude · ${m.model}` : "Claude off", m.agent === "on"),
    chip(m.reviewer === "on" ? "Purpose check on" : "Purpose check off", m.reviewer === "on"),
  ].join("");
}

function renderMeter() {
  const { period, totals, purchases, holds } = state;
  const el = $("meter");
  if (!period || period.status === "declined") {
    el.innerHTML = `
      <div class="meter-top"><span class="label">No budget</span></div>
      <p class="big num">$0.00</p>
      <p class="empty">Your agent can't spend anything yet. Ask it to plan a budget; you'll approve it on PayPal.</p>`;
    return;
  }
  if (period.status === "pending") {
    el.innerHTML = `
      <div class="meter-top"><span class="label">${esc(shortDate(period.startsOn))} to ${esc(shortDate(period.endsOn))}</span><span class="label">waiting for you</span></div>
      <p class="big num">$0.00 <span class="muted small">until you approve</span></p>
      <p class="empty">${esc(period.summary)}</p>`;
    return;
  }
  const closed = period.status === "closed";
  const paid = purchases.filter((p) => p.status === "captured" || p.status === "refunded").length;
  const released = holds.filter((h) => h.status === "voided").reduce((s, h) => s + h.amountCents - h.capturedCents, 0);
  const heldOrReleased = closed ? released : totals.heldCents;
  el.innerHTML = `
    <div class="meter-top">
      <span class="label">${esc(closed ? "Closed period" : "This period")} · ${esc(shortDate(period.startsOn))} to ${esc(shortDate(period.endsOn))}</span>
      ${closed ? "" : `<button class="btn small" id="close-period" type="button">Close period now</button>`}
    </div>
    <p class="big num">${both(closed ? 0 : totals.heldCents)} <span class="muted small">${closed ? "left, period closed" : "left to spend"}</span></p>
    <div class="bar" role="img" aria-label="${money(totals.spentCents)} spent of ${money(totals.approvedCents)} approved">
      <span class="spent" style="width:${pct(totals.spentCents, totals.approvedCents)}%"></span>
      <span class="${closed ? "free" : "held"}" style="width:${pct(heldOrReleased, totals.approvedCents)}%"></span>
    </div>
    <div class="legend">
      <div><span class="k">Approved by you</span><span class="v">${both(totals.approvedCents)}</span></div>
      <div><span class="k"><span class="dot" style="background:var(--accent)"></span>Spent · ${paid} purchase${paid === 1 ? "" : "s"}</span><span class="v">${both(totals.spentCents)}</span></div>
      <div><span class="k"><span class="dot" style="background:var(--${closed ? "free" : "hold"})"></span>${closed ? "Released to you" : "Held, not spent"}</span><span class="v">${both(heldOrReleased)}</span></div>
      <div><span class="k">${closed ? "Closed" : "Returns to you"}</span><span class="v">${esc(shortDate(period.endsOn))}</span></div>
    </div>
    ${totals.refundedCents ? `<p class="small muted">${money(totals.refundedCents)} refunded to you.</p>` : ""}
    ${holds.filter((h) => h.releaseNote).map((h) => `<p class="small muted">${esc(h.releaseNote)}</p>`).join("")}`;
  $("close-period")?.addEventListener("click", async (e) => {
    if (!confirm("Close the period now? Unspent money is released and the agent can't spend until you approve a new budget.")) return;
    e.target.disabled = true;
    try {
      await api("/api/period/close", {});
      flash("Period closed.");
    } catch (err) {
      flash(err.message, true);
    }
    refresh();
  });
}

function renderRequests() {
  const sig = JSON.stringify(state.requests.map((r) => [r.id, r.status, r.totalCents]));
  if (sig === rendered.requests) return;
  rendered.requests = sig;
  $("requests").innerHTML = state.requests.map(requestCard).join("");
  for (const r of state.requests) wireRequest(r);
  if (location.hash && state.requests.some((r) => `#${r.id}` === location.hash)) {
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }
}

function requestCard(r) {
  const title = r.kind === "budget" ? "Budget request" : "Top-up request";
  const lines = r.lines
    .map((l) => {
      const cents = l.approvedCents ?? l.amountCents;
      const kept = cents > 0;
      return `
      <div class="line ${kept ? "" : "removed"}" data-line="${esc(l.id)}">
        <input type="checkbox" ${kept ? "checked" : ""} aria-label="Keep ${esc(l.label)}">
        <span class="name">${esc(l.label)}</span>
        <label class="amount-in">$<input type="number" min="0" step="0.01" value="${((kept ? cents : l.amountCents) / 100).toFixed(2)}" aria-label="Amount for ${esc(l.label)}"><span class="inr" data-inr>${inr(kept ? cents : l.amountCents)}</span></label>
        <span class="why">${esc(l.reason)}</span>
      </div>`;
    })
    .join("");
  return `
    <section class="card receipt" id="${esc(r.id)}">
      <div class="card-head"><h2>${title}</h2><span class="label">from your agent · ${esc(time(r.createdAt))}</span></div>
      ${r.kind === "topup" ? `<p>${esc(r.reason)}</p>` : `<p class="muted">${esc(r.reason)}</p>`}
      ${lines}
      <hr>
      <div class="total"><span>Total hold</span><span class="num"><span data-total>${money(r.totalCents)}</span> <span class="inr" data-total-inr>${inr(r.totalCents)}</span></span></div>
      <p class="small muted">Approving places a hold on your PayPal funds. The agent can spend only from it, line by line. Whatever it doesn't spend is released.</p>
      <div class="btns">
        <button class="btn primary" data-act="approve" type="button">Approve on PayPal</button>
        <button class="btn" data-act="decline" type="button">Decline</button>
      </div>
    </section>`;
}

function wireRequest(r) {
  const card = document.getElementById(r.id);
  const readEdits = () =>
    [...card.querySelectorAll("[data-line]")].map((row) => {
      const keep = row.querySelector("input[type=checkbox]").checked;
      const amount = Math.round(Number(row.querySelector("input[type=number]").value) * 100);
      return { lineId: row.dataset.line, amountCents: keep && Number.isFinite(amount) ? Math.max(0, amount) : 0 };
    });
  const update = () => {
    const edits = readEdits();
    card.querySelectorAll("[data-line]").forEach((row, i) => {
      row.classList.toggle("removed", edits[i].amountCents === 0);
      const typed = Math.round(Number(row.querySelector("input[type=number]").value) * 100);
      row.querySelector("[data-inr]").textContent = inr(Number.isFinite(typed) ? Math.max(0, typed) : 0);
    });
    const total = edits.reduce((s, e) => s + e.amountCents, 0);
    card.querySelector("[data-total]").textContent = money(total);
    card.querySelector("[data-total-inr]").textContent = inr(total);
  };
  card.addEventListener("input", update);
  card.querySelector('[data-act="approve"]').addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const { approveUrl } = await api(`/api/requests/${r.id}/checkout`, { edits: readEdits() });
      location.href = approveUrl;
    } catch (err) {
      flash(err.message, true);
      e.target.disabled = false;
    }
  });
  card.querySelector('[data-act="decline"]').addEventListener("click", async () => {
    try {
      await api(`/api/requests/${r.id}/decline`, {});
      flash("Declined. The agent can't spend that money.");
    } catch (err) {
      flash(err.message, true);
    }
    rendered.requests = "";
    refresh();
  });
}

function renderLines() {
  const lines = state.lines;
  $("lines-card").hidden = !lines.length;
  $("lines").innerHTML = lines
    .map(
      (l) => `
      <div class="line-row">
        <div class="row"><span>${esc(l.label)} <span class="label">${esc(l.key)}</span></span>
          <span class="num small">${money(l.leftCents)} left of ${both(l.limitCents)}</span></div>
        <div class="bar thin"><span class="spent" style="width:${pct(l.usedCents, l.limitCents)}%"></span><span class="held" style="width:${pct(l.leftCents, l.limitCents)}%"></span></div>
        <span class="why">${esc(l.reason)}</span>
      </div>`,
    )
    .join("");
}

function renderPurchases() {
  const items = state.purchases;
  if (!items.length) {
    $("purchases").innerHTML = `<p class="empty">No purchases yet.</p>`;
    return;
  }
  const lineLabel = (key) => state.lines.find((l) => l.key === key)?.label ?? key;
  const statusText = { captured: "paid", refused: "refused", refunded: "refunded", failed: "failed", pending: "paying" };
  $("purchases").innerHTML = items
    .map(
      (p) => `
      <div class="purchase ${esc(p.status)}">
        <span class="title">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>` : esc(p.title)}</span>
        <span class="num amt">${both(p.amountCents)}</span>
        <span class="meta"><span class="status ${esc(p.status)}">${esc(statusText[p.status] ?? p.status)}</span>
          ${esc(p.merchant)} · ${esc(lineLabel(p.lineKey))}${p.fromBufferCents ? ` · ${money(p.fromBufferCents)} from buffer` : ""} · ${esc(time(p.createdAt))}${p.agent === "mcp" ? " · via MCP" : ""}</span>
        <span class="note">Why: ${esc(p.reasoning)}</span>
        ${p.review && p.review.verdict !== "skipped" ? `<span class="note">Purpose check: ${esc(p.review.reason)}</span>` : ""}
        ${p.refusal ? `<span class="note refusal">${esc(p.refusal)}</span>` : ""}
        ${p.status === "captured" ? `<span class="note"><button class="btn small" data-refund="${esc(p.id)}" type="button">Refund to me</button></span>` : ""}
      </div>`,
    )
    .join("");
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

function renderEvents() {
  $("events").innerHTML = state.events.length
    ? state.events.map((e) => `<li><time>${esc(time(e.at))}</time>${esc(e.message)}</li>`).join("")
    : `<li class="empty">Nothing yet.</li>`;
}

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
  const sig = JSON.stringify([chat.length, chat.at(-1), agentBusy, agentError]);
  if (sig === rendered.chat) return;
  rendered.chat = sig;
  const log = $("log");
  const parts = [];
  if (modes.agent !== "on") {
    parts.push(`<p class="warn">Claude isn't configured. Add ANTHROPIC_API_KEY to .env and restart to chat with the agent. The wallet, approvals and the MCP server work without it.</p>`);
  } else if (!chat.length) {
    parts.push(`<p class="empty">Ask your agent to plan a budget. It will look at past weeks and current prices, then send you a request to approve.</p>`);
  }
  for (const item of chat) {
    if (item.kind === "text") parts.push(`<div class="msg ${item.role === "user" ? "user" : "assistant"}">${esc(item.text)}</div>`);
    else {
      const money = ["spend", "request_budget", "request_topup"].includes(item.name);
      parts.push(`<div class="tool ${item.isError ? "err" : money ? "ok money" : ""}">${esc(toolLine(item))}</div>`);
    }
  }
  if (agentBusy) parts.push(`<div class="working">Working</div>`);
  if (agentError) parts.push(`<p class="warn">The agent stopped: ${esc(agentError)}</p>`);
  log.innerHTML = parts.join("");
  log.scrollTop = log.scrollHeight;
  $("send").disabled = agentBusy || modes.agent !== "on";
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  $("chat-input").value = "";
  try {
    await api("/api/chat", { message: text });
  } catch (err) {
    flash(err.message, true);
  }
  refresh();
}

$("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("chat-input").value);
});
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

// Messages from the PayPal round trip.
const params = new URLSearchParams(location.search);
if (params.get("approved")) flash("Approved. The hold is in place and your agent can spend within it.");
if (params.get("cancelled")) flash("You left PayPal without approving. The request is still here if you change your mind.");
if (params.get("error")) flash(`Approval didn't go through: ${params.get("error")}`, true);
if (params.size) history.replaceState(null, "", location.pathname + location.hash);

refresh();
