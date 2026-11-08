# Remit

**Your agent spends within its remit.**

Remit is a spending wallet for AI agents, built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

1. The agent writes its own budget request, with a reason for each line.
2. You approve the request on PayPal. That puts a hold on your funds.
3. The agent can then spend only from that hold, one partial capture per purchase.
4. Anything the agent doesn't spend is released back to you. Only you can approve more money.

The product brief is in [`docs/remit-brief.html`](docs/remit-brief.html). The hackathon submission text, demo video script and judging-criteria map are in [`docs/submission.md`](docs/submission.md).

## Run it

Needs Node 22.13 or newer.

```bash
npm install
cp .env.example .env
npm run seed     # optional: four example weeks of history for the agent to plan from
npm start        # http://localhost:3000
```

Every key in `.env` is optional. Without a key, that part runs in a stand-in mode, shown at the top of the app:

| Key | With it | Without it |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Real PayPal sandbox: you approve on PayPal's page | A local page, clearly labelled "Simulated checkout", stands in for PayPal and enforces the same limits |
| `PAYPAL_WEBHOOK_ID` | With sandbox keys: PayPal tells Remit about approvals, declines and voided holds directly (see [PayPal webhooks](#paypal-webhooks)) | With sandbox keys, the webhook route is off and Remit asks PayPal instead. The simulator always sends its own webhooks |
| `ANTHROPIC_API_KEY` | The Claude agent chats, plans and shops; a second Claude call reviews each purchase | Chat is off. The wallet, approvals and MCP still work |
| `CHANNEL3_API_KEY` | Live products and prices from Channel3 | A small built-in demo catalog |
| `REMIT_AGENT_TOKEN` | A shared token for the agent API, the remote MCP endpoint at `/mcp` and the stdio MCP server, as the built-in "Shared token" agent | Only tokens made on the Agents page work |
| `REMIT_INR_RATE` (default 88) | Next to each dollar amount, the app and agent also show approximately what it is in rupees. PayPal doesn't accept INR (`CURRENCY_NOT_SUPPORTED`), so holds and captures stay in USD | Set it to 0 to show dollars only |
| `REMIT_OWNER_PASSWORD` | The web app asks for a password (user `owner`) | Open. Allowed only when `APP_URL` is localhost: with a public `APP_URL` the server refuses to start |

### Notifications

Remit can tell your phone when a budget or top-up request is waiting for you, when a purchase is refused, and when a period closes (the weekly recap). Set one of these, or both:

| Key | What |
|---|---|
| `NTFY_TOPIC` | Push through [ntfy](https://ntfy.sh): install the ntfy app, subscribe to a hard-to-guess topic, and set the same name here. `NTFY_URL` (default `https://ntfy.sh`) for your own server, `NTFY_TOKEN` for a protected topic |
| `NOTIFY_WEBHOOK_URL` | Remit POSTs each notice as JSON (`kind`, `title`, `body`, `url`, `actions`, `data`) to this URL |
| `REMIT_LINK_SECRET` | Signs the links in notices. Without it, a random secret is made at each start and older links stop working |

With neither set, notices are only written to the log.

A request notice has **Approve** and **Decline** links. Each is signed for one request and one action, and works for 24 hours without the owner password. Opening a link changes nothing: Approve shows the request's lines and reasons with an "Approve on PayPal" button, which goes through the same PayPal checkout as the app; Decline asks you to confirm. A changed or expired link does nothing.

The recap lists approved and spent per line, refusals, and what was released. When the built-in agent is on, it has a **Plan next week** link that asks the agent to draft the next budget, which then arrives as a new request notice.

To try it, run `npm start` with `NTFY_TOPIC=remit-<something random>` and open `https://ntfy.sh/remit-<something random>` in a browser (or the ntfy app). Links in a notice point at `APP_URL`, so on a phone they work only once Remit has a public address.

## Deploy

Remit runs on [Render](https://render.com) as one Docker web service with a 1 GB disk for the SQLite database. The repo has the [`Dockerfile`](Dockerfile) and a Render Blueprint, [`render.yaml`](render.yaml). It needs the Starter instance (about $7 a month plus $0.25 for the disk, billed by the second): Render's free instances can't have a disk and sleep after 15 idle minutes, which would also stop the close-out timer.

It stays on PayPal's **sandbox**: no real money moves. With PayPal keys set, owners approve holds with a sandbox buyer account. Without them, the "Simulated checkout" page stands in.

1. Sign in to [dashboard.render.com](https://dashboard.render.com) with GitHub and add a payment method (Starter is a paid instance).
2. Click **New > Blueprint** and connect the `remit` repository. Render reads `render.yaml` from the branch you choose (`main` once this is merged).
3. Render asks for the values marked `sync: false`. Fill in:
   - `REMIT_OWNER_PASSWORD`: required. The server won't start on a public address without it. Share it with whoever should use the app (user `owner`).
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: your sandbox app's keys. Leave both empty for simulated checkout.
   - `PAYPAL_WEBHOOK_ID`: optional, see [PayPal webhooks](#paypal-webhooks). You can add it after the first deploy, once you know the address.
   - `ANTHROPIC_API_KEY`: for the chat agent and the purpose check. Empty turns chat off.
   - `CHANNEL3_API_KEY`: optional; empty uses the demo catalog.
   - `NTFY_TOPIC` or `NOTIFY_WEBHOOK_URL`: optional, for phone notifications (see Notifications above).

   `REMIT_DB` is already set to the disk (`/var/data/remit.db`), and `REMIT_AGENT_TOKEN` and `REMIT_LINK_SECRET` are generated for you.
4. Click **Apply**. The first build takes a few minutes. When the service shows **Live**, open its address, `https://<name>.onrender.com`, and sign in as `owner`.
5. `APP_URL` is the address PayPal sends you back to after approving. On Render it defaults to the service's own address (`RENDER_EXTERNAL_URL`), so you don't need to set it. If you add a custom domain, set `APP_URL` to `https://your.domain` under **Environment**. The service log's first line, `Remit on https://...`, shows the address in use.
6. Optional, for the example history: open the service's **Shell** tab and run `npm run seed`. It adds four closed example weeks to the database on the disk, once.

Check it: `https://<name>.onrender.com/healthz` returns `{"ok":true}` without a password. Render uses the same route as its health check.

Hosted agents connect to `https://<name>.onrender.com/mcp` with `REMIT_AGENT_TOKEN` (the value under the service's **Environment** tab) as a bearer token; see [MCP](#use-the-wallet-from-another-agent-mcp) below. To point the stdio MCP server at the hosted wallet instead, set `REMIT_URL` to the public address and `REMIT_AGENT_TOKEN` to the same value.

### PayPal webhooks

With webhooks, PayPal tells Remit when you approve an order, when it declines one, and when it voids a hold (including when a hold expires). Without them, Remit finds out by asking PayPal when you open the app or come back from PayPal. That asking stays on as a fallback either way.

1. In the [PayPal developer dashboard](https://developer.paypal.com/dashboard/), open **Apps & Credentials**, pick your sandbox app, and under **Sandbox Webhooks** click **Add Webhook**.
2. Set the URL to `${APP_URL}/paypal/webhook`, e.g. `https://<name>.onrender.com/paypal/webhook`. PayPal needs a public HTTPS address, so this doesn't work on localhost.
3. Subscribe to at least `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.PAYMENT-APPROVAL.REVERSED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` and `PAYMENT.CAPTURE.DECLINED`. **All events** is fine too: Remit records the rest and ignores them.
4. Save, copy the **Webhook ID** PayPal shows, and set it as `PAYPAL_WEBHOOK_ID`. Restart.

The service log then says `PayPal webhooks: on at https://.../paypal/webhook`. The route doesn't need the owner password. Instead, Remit asks PayPal to verify each event's signature (`/v1/notifications/verify-webhook-signature`) and answers 400 to anything that doesn't pass. Each event's ID is stored in the `paypal_events` table with what the wallet did, so a redelivered event is ignored. With sandbox keys but no `PAYPAL_WEBHOOK_ID`, `/paypal/webhook` answers 404.

Without PayPal keys, the simulated checkout sends the same events to the same route in process, signed with its own key, so the keyless demo and the tests take the same path.

To run the same container yourself:

```bash
docker build -t remit .
docker run -p 3000:3000 -v remit-data:/var/data --env-file .env remit
```

## What the wallet enforces

All of this is server code in [`src/wallet/wallet.ts`](src/wallet/wallet.ts). A prompt can't change it.

- **Only you approve money.** A budget or top-up opens only after PayPal authorizes the order, and PayPal only does that once you've approved it. Visiting the return URL without approving does nothing.
- **Lines are envelopes.** Each purchase names a plan line. It can use that line and then the shared buffer, never another line.
- **No overspending.** The wallet checks the line and the total before capturing, and PayPal refuses to capture more than the hold (`MAX_CAPTURE_AMOUNT_EXCEEDED`). Spends are serialized so two at once can't both pass.
- **Purpose check.** Before paying, an independent Claude call sees the plan line and the purchase, but not the page the agent read, and can refuse a purchase that doesn't fit the line. If the purpose check is unreachable, refuses to answer or gives no clear verdict, the wallet refuses.
  - **Pay anyway.** You can overrule a purpose check refusal from its ledger row (`POST /api/purchases/:id/override`, owner only, never an agent tool). The wallet checks the line and the total again, captures the normal way, keeps the original verdict and marks the row "Paid anyway". Each purchase can be overridden once.
  - **Eval.** `npm run purpose-eval` runs the real purpose check over 28 cases in [`test/fixtures/purpose-cases.json`](test/fixtures/purpose-cases.json): ordinary purchases, prompt injection in titles and reasoning, mislabeled items and plausible but off-purpose ones. It prints each result, the accuracy and the false approves separately, and fails if any purchase that should be refused got through. Needs `ANTHROPIC_API_KEY`.
- **Every line has a reason.** A budget line or top-up with an empty or trivially short reason is rejected, and the agent is told to cite evidence such as when something was last bought.
- **Refusals are recorded.** A refused purchase shows in the ledger with the reason. The agent is told to ask for a top-up rather than work around it.
- **Top-ups are new approvals.** Each one is a new PayPal order and a new hold. The wallet records which hold funds each line, and a purchase captures from the holds that fund its line (and the buffer's, for any part taken from the buffer). It falls back to other holds only if those don't have enough left.
- **Close-out.** At the end date (or when you click Close), holds with nothing captured are voided right away. PayPal won't void a hold after a partial capture (`PREVIOUSLY_CAPTURED`), so that leftover is released when the authorization expires, and the ledger says so. `npm run sandbox-check` tests this against the real sandbox.
- **Honor period.** PayPal guarantees funds for 3 days. After that the wallet reauthorizes the remaining amount once before capturing.
- **Refunds** go back to you, not to the agent's line.

Store checkout is simulated: a purchase takes the money from your PayPal hold, but no order is placed with the store. Captures land in Remit's sandbox business account.

## Use the wallet from another agent (MCP)

Remit exposes `get_history`, `get_balance`, `request_budget`, `request_topup` and `spend` over MCP. The tool descriptions carry the planning rules: read the history first, cite evidence in every line's reason, add about a 10% buffer, default to a 7-day period, and ask with `request_topup` after a refusal. Both ways in need an agent token, and both end in the same wallet code with the same limits.

Give each agent its own token: open **Agents** in the web app, name the agent and click **Create token**. The token is shown once; Remit stores only its hash. From the same page you can pause an agent (it can still read its balance and history, but can't spend or ask for money) or revoke its token. Each agent spends only from the lines it asked for, plus the shared buffer. The shared `REMIT_AGENT_TOKEN` from `.env` still works, as the built-in "Shared token" agent.

### Remote (hosted agents)

The wallet service serves MCP over Streamable HTTP at `${APP_URL}/mcp`, e.g. `http://localhost:3000/mcp` or `https://<name>.onrender.com/mcp`. Send the agent's token as a bearer token; purchases are recorded under that agent:

```
Authorization: Bearer <agent token>
```

Without the token it answers 401. It is stateless (no session id, plain JSON responses), so it works behind any proxy. Point any MCP client that supports Streamable HTTP and custom headers at that URL, for example Claude Code:

```bash
claude mcp add --transport http remit http://localhost:3000/mcp --header "Authorization: Bearer $REMIT_AGENT_TOKEN"
```

To try it by hand against a local wallet:

```bash
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer $REMIT_AGENT_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_balance","arguments":{}}}'
```

### Local (stdio)

For clients that start MCP servers as a local process, `src/mcp/main.ts` speaks MCP over stdio. It holds no PayPal keys; it forwards each call to the running wallet's agent API with an agent token. For Claude Desktop, add to `claude_desktop_config.json` (use your own absolute path, and the agent's token or the shared one):

```json
{
  "mcpServers": {
    "remit": {
      "command": "/absolute/path/to/remit/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/remit/src/mcp/main.ts"],
      "env": { "REMIT_URL": "http://localhost:3000", "REMIT_AGENT_TOKEN": "remit_agt_... or the token in .env" }
    }
  }
}
```

## Check the PayPal sandbox

The brief's day-1 test: authorize, two partial captures, an over-limit capture, void after captures, final capture, and void of an untouched hold. You approve each order with your sandbox buyer account.

```bash
npm run sandbox-check
```

## Layout

| Path | What |
|---|---|
| `src/wallet/` | Money rules, the five agent tools, the purpose check |
| `src/paypal/` | Orders and Payments REST client, and the local simulator |
| `src/demo/` | Demo only: the built-in Claude shopping agent, and Channel3 search with the demo catalog |
| `src/server/` | Web app API, PayPal return handling, agent API, remote MCP at `/mcp` |
| `src/notify/` | Notices to the owner (ntfy, webhook), the recap, and the signed one-tap link pages |
| `src/mcp/` | The MCP tool registration shared by both transports, the remote handler, and the stdio server |
| `web/` | The owner's web app (no build step) |
| `test/` | Wallet, server route, MCP and PayPal REST client tests, all offline: `npm test` |

## License

[MIT](LICENSE)
