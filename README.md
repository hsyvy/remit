# Remit

**Your agent spends within its remit.**

Remit is a spending wallet for AI agents, built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

1. The agent writes its own budget request, with a reason for each line.
2. You approve the request on PayPal. That puts a hold on your funds.
3. The agent can then spend only from that hold, one partial capture per purchase.
4. Anything the agent doesn't spend is released back to you. Only you can approve more money.

The product brief is in [`docs/remit-brief.html`](docs/remit-brief.html).

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
| `ANTHROPIC_API_KEY` | The Claude agent chats, plans and shops; a second Claude call reviews each purchase | Chat is off. The wallet, approvals and MCP still work |
| `CHANNEL3_API_KEY` | Live products and prices from Channel3 | A small built-in demo catalog |
| `REMIT_AGENT_TOKEN` | The agent API (and so the MCP server) is on | Agent API off |
| `REMIT_INR_RATE` (default 88) | Next to each dollar amount, the app and agent also show approximately what it is in rupees. PayPal doesn't accept INR (`CURRENCY_NOT_SUPPORTED`), so holds and captures stay in USD | Set it to 0 to show dollars only |
| `REMIT_OWNER_PASSWORD` | The web app asks for a password (user `owner`) | Open. Allowed only when `APP_URL` is localhost: with a public `APP_URL` the server refuses to start |

## Deploy

Remit runs on [Render](https://render.com) as one Docker web service with a 1 GB disk for the SQLite database. The repo has the [`Dockerfile`](Dockerfile) and a Render Blueprint, [`render.yaml`](render.yaml). It needs the Starter instance (about $7 a month plus $0.25 for the disk, billed by the second): Render's free instances can't have a disk and sleep after 15 idle minutes, which would also stop the close-out timer.

It stays on PayPal's **sandbox**: no real money moves. With PayPal keys set, owners approve holds with a sandbox buyer account. Without them, the "Simulated checkout" page stands in.

1. Sign in to [dashboard.render.com](https://dashboard.render.com) with GitHub and add a payment method (Starter is a paid instance).
2. Click **New > Blueprint** and connect the `remit` repository. Render reads `render.yaml` from the branch you choose (`main` once this is merged).
3. Render asks for the values marked `sync: false`. Fill in:
   - `REMIT_OWNER_PASSWORD`: required. The server won't start on a public address without it. Share it with whoever should use the app (user `owner`).
   - `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`: your sandbox app's keys. Leave both empty for simulated checkout.
   - `ANTHROPIC_API_KEY`: for the chat agent and the purpose check. Empty turns chat off.
   - `CHANNEL3_API_KEY`: optional; empty uses the demo catalog.

   `REMIT_DB` is already set to the disk (`/var/data/remit.db`), and `REMIT_AGENT_TOKEN` is generated for you.
4. Click **Apply**. The first build takes a few minutes. When the service shows **Live**, open its address, `https://<name>.onrender.com`, and sign in as `owner`.
5. `APP_URL` is the address PayPal sends you back to after approving. On Render it defaults to the service's own address (`RENDER_EXTERNAL_URL`), so you don't need to set it. If you add a custom domain, set `APP_URL` to `https://your.domain` under **Environment**. The service log's first line, `Remit on https://...`, shows the address in use.
6. Optional, for the example history: open the service's **Shell** tab and run `npm run seed`. It adds four closed example weeks to the database on the disk, once.

Check it: `https://<name>.onrender.com/healthz` returns `{"ok":true}` without a password. Render uses the same route as its health check.

To point the MCP server at the hosted wallet, set `REMIT_URL` to the public address and `REMIT_AGENT_TOKEN` to the value under the service's **Environment** tab.

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
- **Purpose check.** Before paying, an independent Claude call sees the plan line and the purchase, but not the page the agent read, and can refuse a purchase that doesn't fit the line. If the purpose check is unreachable, the wallet refuses.
- **Every line has a reason.** A budget line or top-up with an empty or trivially short reason is rejected, and the agent is told to cite evidence such as when something was last bought.
- **Refusals are recorded.** A refused purchase shows in the ledger with the reason. The agent is told to ask for a top-up rather than work around it.
- **Top-ups are new approvals.** Each one is a new PayPal order and a new hold. Purchases capture from the oldest hold first.
- **Close-out.** At the end date (or when you click Close), holds with nothing captured are voided right away. PayPal won't void a hold after a partial capture (`PREVIOUSLY_CAPTURED`), so that leftover is released when the authorization expires, and the ledger says so. `npm run sandbox-check` tests this against the real sandbox.
- **Honor period.** PayPal guarantees funds for 3 days. After that the wallet reauthorizes the remaining amount once before capturing.
- **Refunds** go back to you, not to the agent's line.

Store checkout is simulated: a purchase takes the money from your PayPal hold, but no order is placed with the store. Captures land in Remit's sandbox business account.

## Use the wallet from another agent (MCP)

The MCP server exposes `get_history`, `get_balance`, `request_budget`, `request_topup` and `spend`. The tool descriptions carry the planning rules: read the history first, cite evidence in every line's reason, add about a 10% buffer, default to a 7-day period, and ask with `request_topup` after a refusal. It holds no PayPal keys; it calls the running wallet with `REMIT_AGENT_TOKEN`.

For Claude Desktop, add to `claude_desktop_config.json` (use your own absolute path and token):

```json
{
  "mcpServers": {
    "remit": {
      "command": "/absolute/path/to/remit/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/remit/src/mcp/main.ts"],
      "env": { "REMIT_URL": "http://localhost:3000", "REMIT_AGENT_TOKEN": "same-token-as-.env" }
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
| `src/server/` | Web app API, PayPal return handling, agent API |
| `src/mcp/` | The MCP server |
| `web/` | The owner's web app (no build step) |
| `test/` | Wallet tests against the simulated PayPal: `npm test` |

## License

[MIT](LICENSE)
