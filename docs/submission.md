# Remit: Devpost submission

This file holds the text to paste into the PayPal AI Hackathon submission form, the demo video script, and a map from the judging criteria to the parts of Remit that address them.

## The rules that shape this submission

I checked these pages on Nov 7, 2026:

- Overview, requirements, prizes and judging criteria: <https://paypalaihackathon.devpost.com/>
- Official rules: <https://paypalaihackathon.devpost.com/rules>
- Resources: <https://paypalaihackathon.devpost.com/resources>
- Devpost's standard submission form steps: <https://help.devpost.com/article/126-know-your-submission-steps>

| What | The rule | Source |
|---|---|---|
| Deadline | Submission Period ends **Thursday Nov 12, 2026, 12:00 pm Pacific Time**. Devpost shows this as Nov 13, 1:30 am IST. You can save drafts until then, but you can't change the submission after it. | Rules §1, §5 |
| Judging | Dec 1 to Dec 15, 2026. Winners are announced on or around Dec 21. | Rules §1 |
| Core requirement | "Your project must meaningfully use both PayPal and AI." It must use the PayPal developer platform through the free sandbox. | Overview, Rules §4 |
| Text description | Explain the project's features and functionality. | Rules §4 |
| Tools | Identify which tools (model or AI service) were used and explain how they were used. | Overview |
| Functional demo | Judges must be able to run it, either from clear setup and run instructions in the repo or from a hosted URL. A mockup or non-functional demo doesn't count. | Rules §4 |
| Repository | Public on GitHub, GitLab or Bitbucket, with all source, assets and run instructions. An open source license must be visible at the top of the repo page (the About section). | Rules §4 |
| Testing access | Provide any test credentials, API keys or sandbox logins judges need, or explain in the README how to get them. Keep the project free to test until judging ends. | Rules §4 |
| Demo video | **Under 3 minutes** (judges don't have to watch past 3:00). It must show the project working on the device it was built for, be **public on YouTube** with the link in the form, and contain no third-party trademarks or copyrighted music without permission. | Rules §4 |
| Language | English. | Rules §4 |
| New project | The project must be new, or significantly updated, during the Submission Period (from Oct 1, 2026). Remit's first commit is Nov 6, 2026. | Rules §4 |
| Prizes | One Grand Prize or one Honorable Mention, plus at most one Sponsor Prize. The prizes relevant to Remit are 1st/2nd/3rd, Best Use of Agentic Commerce, Best Use of PayPal + AI, Best Demo Delivery, and the Channel3 sponsor prize (Best Use of Channel3, open to submissions that use any Channel3 tool). | Overview, Rules §8 |

Devpost's form has five steps. Step 1 is the team. Step 2 is the project name, tagline and a thumbnail (JPG, PNG or GIF, 5 MB max, 3:2 ratio). Step 3 is the project story, built-with tags (25 max), "Try it out" links, the image gallery and the video link. Step 4 asks questions specific to this hackathon, and Step 5 is agreeing to the terms. I couldn't open this hackathon's own form, because it needs a logged-in Devpost account that has joined the hackathon. The Step 4 questions below are therefore Devpost's usual ones plus what the rules ask for. Check them against the real form.

### Fix before submitting

- [ ] **Make `hsyvy/remit` public.** As of Nov 7 it is private (`gh repo view` reports `PRIVATE`). The rules require a public repo, and the MIT license must show in the About section.
- [ ] Join the hackathon on Devpost ("Join Hackathon") if you haven't, and start the draft early.
- [ ] Upload the video to YouTube as **Public** (not Unlisted) and paste the link.

---

## Step 2: Project overview

**Project name:** Remit

**Tagline** (121 characters):

> A PayPal wallet for AI agents: the agent asks for a budget with reasons, you approve a hold, and every purchase must fit.

A longer alternative if the field allows it (from the pitch, 184 characters):

> Remit gives AI agents a PayPal budget they have to justify: the agent proposes each line with a reason, you approve a hold, and every purchase is checked against what the money is for.

**Thumbnail:** a 3:2 crop of the app with the balance meter and a ledger row that shows a purpose-check reason. Use the light theme so it reads well at gallery size.

---

## Step 3: Project story

Paste everything from "Inspiration" to the end of "What's next for Remit" into the project story field. It is written in Markdown.

### Inspiration

AI agents can already pay. The usual way is to give them a card with a spending limit. A limit answers *how much*, but not *for what*. A $100 limit lets an agent spend $100 on anything, including something a product listing talked it into. When a charge looks wrong, all you have is a transaction line, not a reason.

People already handle this with each other through budgets: "here's money for groceries and the dog's food this week." We wanted an agent to work the same way. It should ask for money for named reasons, get approval, and be held to those reasons when it pays.

PayPal's authorization holds turned out to fit this almost exactly. Approving a budget reserves the money on your own PayPal account. Each purchase captures part of the hold, and whatever is left is released.

### What it does

Remit is a spending wallet for AI agents. The positioning in one line: *cards limit how much an agent can spend; Remit also limits what the money is for.*

1. **The agent proposes a budget.** Each line has an amount and a reason with evidence: what past weeks cost, when something was last bought, the prices it found. There is an optional shared buffer of about 10%.
2. **You approve it on PayPal.** You can trim or remove lines first. Approving creates a PayPal order with intent `AUTHORIZE`, and once you approve on PayPal's page, Remit authorizes it. That places a hold on your own PayPal account. There's no new card, and the agent never sees payment details.
3. **The agent spends line by line.** Each purchase is a partial capture from the hold. It can use its own line and then the shared buffer, never another line. Before any money moves, an independent **purpose check** compares the purchase with the line's approved reason. The purpose check is a separate Claude call that never sees the pages the agent read.
4. **At the limit, it asks.** The wallet refuses with a reason, the refusal is recorded, and the agent asks for more money with its own reason. Extra money is a new PayPal approval and a new hold. If another line has money left, you can move it to the short line instead, with no new approval.
5. **The leftover comes back.** At the end date, or when you click Close, holds with nothing captured are voided. A partly captured hold is released when PayPal's authorization expires.
6. **Any agent can use it.** An MCP server exposes `get_history`, `get_balance`, `request_budget`, `request_topup` and `spend`, so Claude Desktop or any other MCP client spends under the same rules as the built-in agent.

**A real run on the PayPal sandbox (Nov 6, 2026):**

- The agent asked for **$132.49** for the week: groceries $88.00 ("two orders a week, $87 to $88 for the last four weeks"), dog food $32.49 ("last 12 kg bag Oct 16, three weeks ago") and a $12.00 buffer. It was approved on PayPal (authorization `4UP41481T7762431N`).
- **Dog food, $32.49: paid.** The purpose check said it was the same bag and price as the Oct 16 order. PayPal showed the hold as `PARTIALLY_CAPTURED`.
- **A birthday gift for Sam: no line.** The agent didn't take the money from groceries or the buffer. It listed five options and asked which one, and how much.
- **Top-up, $104.50: approved on PayPal** as a second, separate hold. The reason given: "They're $95.00, plus about 10% for shipping or a price change."
- **Headphones, $95.00: paid.** The purpose check said it was the item the owner approved, at the approved price. $109.50 was left for the week.

**What's simulated, and other limits:**

- The store checkout is simulated. The money really moves on PayPal's sandbox (captures land in Remit's sandbox business account), but no shop receives an order.
- Amounts are in USD only, because PayPal rejects INR (`CURRENCY_NOT_SUPPORTED`). The app shows an approximate rupee figure next to each amount.
- Product search uses a 13-item demo catalog unless a Channel3 key is set.
- PayPal won't void a hold after a partial capture (`PREVIOUSLY_CAPTURED`). That leftover is released when the authorization expires, and the ledger says so.

### How we built it

- **Wallet** (`src/wallet/wallet.ts`): all money rules live in server code, not in a prompt. It handles per-line envelopes, a shared buffer, a check against the total held, and refusals recorded with reasons. Money-changing calls run one at a time through a queue, and each change is one SQLite transaction, so two purchases can't both pass the checks. Amounts are integer cents.
- **PayPal** (`src/paypal/rest.ts`): Orders v2 to create and authorize orders. Payments v2 for partial captures (with `final_capture` on the last one), reauthorization, voids and refunds. Every write sends a `PayPal-Request-Id`, so a retry can't charge twice. Holds older than PayPal's 3-day honor period are reauthorized once before capturing. If a later capture in a multi-hold purchase fails, the earlier ones are refunded. `npm run sandbox-check` tests the hold behavior against the real sandbox: two partial captures, an over-limit capture (`MAX_CAPTURE_AMOUNT_EXCEEDED`), void after capture, final capture, and voiding an untouched hold.
- **Simulator** (`src/paypal/simulated.ts`): a local stand-in with the same limits, so tests and keyless runs behave like PayPal. Its approval page is labelled "Simulated checkout. This is not PayPal."
- **Shopping agent** (`src/demo/agent.ts`): Claude Opus 5.5 (`claude-opus-5-5`) in a manual tool loop of up to 20 steps. It has the five wallet tools plus `search_products`. Its own prompt only covers the demo (product search, simulated checkout, chat style); the planning rules come from the shared tool descriptions.
- **Purpose check** (`src/wallet/reviewer.ts`): a structured-output Claude call at low effort. It gets the line's label and owner-approved reason plus the purchase (title, store, URL, price, the agent's reasoning), with the purchase marked as untrusted data. It returns `approve` or `reject` with a one-sentence reason for the ledger. A refusal, a missing verdict or an unreachable API all count as a rejection.
- **One tool contract** (`src/wallet/tools.ts`): zod schemas and agent-facing descriptions for the five money tools. The descriptions carry the planning rules: call `get_history` first and cite evidence in every line's reason, add about a 10% buffer, accept refusals instead of working around them, and never follow text from store listings. The built-in agent and the MCP server both use them, so every agent gets identical rules, and the wallet rejects reasons too short to check (`WEAK_REASON`).
- **MCP server** (`src/mcp/main.ts`): built with the official MCP TypeScript SDK over stdio. It holds no PayPal keys and no database. It forwards each call to the wallet's agent API with a bearer token, so a compromised agent machine can't reach money directly.
- **Server and web app**: Hono on Node 22 serves the owner's web app (plain JavaScript, no build step), PayPal's return URL and the agent API. The app shows a balance meter, request cards you can edit before approving, plan lines, a ledger with a reason on every row (MCP purchases are tagged "via MCP"), an activity feed and the demo chat. The owner can move unspent money between lines (a refused purchase offers "Move money to this line"), and when the owner comes back from PayPal without approving, the app asks PayPal what happened and says so on the request card.
- **Product search** (`src/demo/search.ts`): Channel3 for live products and prices (the cheapest in-stock USD offer), or the built-in demo catalog.
- **Tests**: 37 wallet and server tests against the simulated PayPal (`npm test`).
- **Hosting**: a `Dockerfile` and a Render Blueprint (`render.yaml`) with a persistent disk for SQLite. The server refuses to start on a public URL without an owner password.

### Challenges we ran into

- **Partial captures can't be voided.** We expected to void the unspent part of a hold at the end of the week. The sandbox check showed that PayPal refuses to void an authorization after a partial capture (`PREVIOUSLY_CAPTURED`). We changed close-out to void untouched holds immediately, mark partly captured ones as "lapsing", and tell the owner the leftover is released when the hold expires.
- **No INR.** PayPal returned `CURRENCY_NOT_SUPPORTED` for rupees. Holds and captures stay in USD, and the app and agent show an approximate rupee figure.
- **Approval has to mean approval.** Visiting the return URL must not open a budget. Only a successful PayPal authorization of the order creates spendable money.
- **Making the purpose check independent.** If the checker sees the same store page the agent read, a page that misleads the agent can mislead the checker too. So the purpose check only gets the line's reason and the purchase details, treats the purchase text as data, and fails closed.
- **Concurrent spends.** Two purchases could each see enough money left. Serializing money changes and using one transaction per change fixed it, and the PayPal capture limit backs it up.
- **A useful refusal.** A bare decline leaves an agent guessing. Each refusal names the rule, the amount left and the next step ("ask the owner with request_topup"), which is what got the agent to ask for a top-up instead of trying another line.

### Accomplishments that we're proud of

- The full flow runs on the real PayPal sandbox: budget, approval, partial capture, a refusal, a top-up as a second hold, and a second capture.
- When the gift had no line, the agent asked instead of borrowing from groceries. The top-up reason it wrote ("$95.00, plus about 10% for shipping or a price change") is the kind of reason a person can check.
- Every dollar in the ledger has a reason, including the refused purchases.
- The money rules live in one place, so the built-in agent and any MCP agent are held to exactly the same rules.
- It runs with no keys at all: a clearly labelled simulator stands in for PayPal, so judges can try the wallet in a minute.

### What we learned

- Authorization holds are a natural budget primitive. Approving reserves the money, captures spend it, and expiry releases it. Their edge cases (the 3-day honor period, no void after partial capture, the capture ceiling) shape the product, so test them on day one.
- Agents follow guardrails better when a refusal explains itself and offers a legitimate next step.
- Limiting purpose takes a second, independent judgment. Amount limits alone can't tell dog food from headphones charged to the dog-food line.
- Putting money rules in server code, not prompts, is what makes it safe to let an outside agent connect.

### What's next for Remit

- A separate allowance for each connected agent, with its own pause button
- Approving from your phone instead of the web app
- Accepting AP2 mandates, so Remit enforces what they record
- Paying real merchants that accept PayPal

---

## Built-with tags

`typescript`, `node.js`, `hono`, `sqlite`, `paypal`, `paypal-orders-api`, `paypal-payments-api`, `paypal-sandbox`, `claude`, `anthropic`, `claude-opus`, `model-context-protocol`, `mcp`, `zod`, `channel3`, `javascript`, `html`, `css`

That's 18 tags, under the 25 limit. Devpost suggests existing tags as you type, so pick the closest match where one exists.

## Try it out links

- Code: <https://github.com/hsyvy/remit>
- Pitch: `docs/pitch.html` (link the file on GitHub once the repo is public)
- A hosted demo URL: the repo deploys to Render (see the README's Deploy section), so add the link once it's up

---

## Step 4: Additional details (check against the real form)

**Submitter type:** Individual

**Country of residence:** India. India isn't on the rules' excluded list (Rules §3).

**Code repository URL:** <https://github.com/hsyvy/remit> (must be public first)

**Open source license:** MIT (`LICENSE` at the repo root)

**Which AI tools were used, and how** (the overview asks for this):

> - **Claude Opus 5.5 (Anthropic API, `claude-opus-5-5`)** is the built-in shopping agent. It plans a budget from past weeks and current prices, writes a reason for each line, shops and pays through the wallet's tools, and asks for a top-up when refused.
> - **A second Claude call** is the purpose check. Before each payment, it compares the purchase with the approved line's reason using structured output (approve or reject plus a reason) and never sees the store pages the agent read.
> - **Model Context Protocol (official TypeScript SDK)** exposes the wallet to any agent. The demo uses Claude Desktop.
> - **Channel3** (sponsor tool) provides live product search when `CHANNEL3_API_KEY` is set.
> - **PayPal Orders v2 and Payments v2 (sandbox)** handle authorization holds, partial captures, reauthorization, voids and refunds.
> - Claude Code helped write the code.

**How was the project built or improved during the hackathon?**

> Remit was started during the Submission Period. The first commit is on Nov 6, 2026, and all the code, the sandbox run and the docs are from the hackathon.

**Testing instructions:**

> Needs Node 22.13+. Run `npm install`, `cp .env.example .env`, `npm run seed`, then `npm start` and open http://localhost:3000. Every key is optional. With no keys, a page labelled "Simulated checkout" stands in for PayPal and enforces the same limits, so you can approve a budget and see refusals at once. To use the real PayPal sandbox, add your own sandbox app's `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` and approve with a sandbox Personal account. `ANTHROPIC_API_KEY` turns on the agent and the purpose check. `REMIT_AGENT_TOKEN` turns on the MCP server; the Claude Desktop config is in the README. `npm test` runs the wallet tests and `npm run sandbox-check` tests hold behavior against the sandbox.

Don't put a real API key in the form. If you want judges to skip setup, a hosted URL with its own sandbox keys is the way to do it. Set `REMIT_OWNER_PASSWORD` there and give the password in these instructions, as the rules ask for private sites.

**Feedback about PayPal's developer tools** (if asked):

> Authorization holds plus partial captures fit an agent budget well. The two surprises were that an authorization can't be voided after a partial capture (`PREVIOUSLY_CAPTURED`), so the leftover only comes back at expiry, and that INR isn't supported for orders. An API to release the uncaptured remainder of a partly captured hold would make agent budgets cleaner.

---

## Demo video script (2:00)

It runs 2:00, comfortably under the 3:00 cap. It's one take per scene, with the waits cut out. Everything on screen is the real app on the PayPal sandbox. Amounts can differ from the Nov 6 run, so read the numbers on screen, not the ones below.

| Time | On screen | Voiceover |
|---|---|---|
| 0:00–0:08 | The Remit app on "This week". The "Running on" chips in the sidebar read "PayPal sandbox", "Agent · claude-opus-5-5" and "Purpose check on". | "AI agents can already pay. Cards limit how much they can spend. Remit also limits what the money is for." |
| 0:08–0:26 | In the Agent chat, click the suggestion **"Plan my budget for this week"**. Cut the wait. The request appears on This week; click **Review request** to open it: groceries $88.00, dog food $32.49, buffer $12.00, each with its reason. Zoom on the dog food reason. | "My agent proposes the budget itself. Each line has a reason I can check: groceries ran $87 to $88 for the last four weeks, and the last bag of dog food was three weeks ago." |
| 0:26–0:42 | Click **Review request**, then **Approve on PayPal**. PayPal's sandbox approval page opens; log in as the sandbox buyer and approve (cut the typing). Back in Remit, the balance meter shows $132.49 held. | "I approve it on PayPal. That puts a hold on my own PayPal account. No new card, and the agent never sees my payment details." |
| 0:42–0:56 | In chat, type **"Order the dog food."** The ledger gets a row: dog food $32.49, **paid**, "Purpose check: …". Zoom on the purpose-check line. | "Each purchase is a partial capture from that hold. Before any money moves, a separate Claude call, which never sees the store pages the agent read, checks that the purchase fits the line." |
| 0:56–1:12 | Switch to **Claude Desktop** with the Remit tools available. Paste the refusal prompt (below). Claude Desktop calls `get_balance`, then `spend` on groceries. The tool result shows the refusal: "Purpose check refused this purchase: …". | "Now Claude Desktop uses the same wallet over MCP. I asked it to put a $95 gift on groceries. The amounts fit, but the purpose check refuses: headphones aren't groceries." |
| 1:12–1:30 | Claude Desktop calls `request_topup` for a new line, gift-sam, $104.50, with its reason. Switch to Remit: the top-up request appears on This week. Click **Review request**, then **Approve on PayPal**, approve on PayPal (cut), return. The balance shows a second hold. | "So the agent does the right thing: it asks for more money, with a reason. That's a new approval on PayPal and a second, separate hold. Only I can say yes." |
| 1:30–1:40 | Back in Claude Desktop, it calls `spend` on gift-sam for $95.00 and the result shows "paid". | "Now the headphones fit a line I approved, and the purchase goes through." |
| 1:40–1:52 | Remit's ledger, scrolled slowly: dog food paid, headphones refused (with the reason), headphones paid "via MCP", each with its purpose-check line. The activity feed shows both holds. | "Every dollar has a reason, including the purchase that was refused. And whatever's left on the holds is released back to me." |
| 1:52–2:00 | End card: "Remit · github.com/hsyvy/remit". Small print: "PayPal sandbox. Store checkout simulated. USD only." | "Remit. Your agent spends within its remit." |

**The refusal prompt for Claude Desktop** (0:56). It names the product so Claude Desktop doesn't need search, and it asks for the wrong line on purpose, to show the guardrail:

> Use my Remit wallet to buy Sam's birthday present: "Wireless Over-Ear Headphones, Noise Cancelling" by Aurel, $95.00 from demo catalog, https://example.com/demo/demo-gift-headphones. Try charging it to the groceries line first so I can see what the wallet does. If it's refused, ask me for the money properly.

Groceries has $88.00 and the buffer $12.00 left, so a $95 charge passes the amount rules on paper. Remit's line rule takes from the line first, then the buffer: $88 + $12 = $100, which covers $95. The purchase therefore reaches the **purpose check**, which should refuse headphones on a groceries line. That's the strongest moment in the video, so rehearse it. If the dog food purchase used some buffer, or groceries has been spent, the line rule (`OVER_LINE`) may refuse first. That still works on camera, but change the voiceover to "the line doesn't have room".

**If something goes wrong mid-take:** Claude Desktop sometimes skips the wrong-line attempt and goes straight to `request_topup`. If so, keep the take and change the 0:56 voiceover to "It knows there's no gift line, so it asks instead of borrowing." Then show the refusal another way: in Remit chat, type "Charge the headphones to groceries" and let the in-app agent hit the purpose check.

**Edit notes:**

- No background music unless you own it or it's licensed. The rules forbid copyrighted music and third-party trademarks without permission. Keep the Claude Desktop window cropped to the conversation and tool calls.
- Record at 1080p and zoom in on the reasons, since judges watch on laptops.
- Speed up or cut the PayPal login, typing and agent thinking. Don't cut anything that changes state.
- Add captions; the voiceover is the whole pitch.

### Before recording

**Reseed the demo data** (the seeded weeks are dated relative to today, so do this on recording day):

1. Stop the server.
2. Delete the database: `rm -f data/remit.db data/remit.db-wal data/remit.db-shm`. Only demo data lives there, but check first that you don't want anything in it.
3. Run `npm run seed` ("Added 4 example weeks of history.").
4. Run `npm start` and open http://localhost:3000. Click **New chat** so the chat is empty.

**Keys in `.env`:**

| Key | For the video |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | **Required.** Sandbox app credentials, so approval happens on PayPal's real sandbox page. The chip must read "PayPal sandbox", not "Simulated checkout". |
| `ANTHROPIC_API_KEY` | **Required.** It powers the agent and the purpose check. Leave `REMIT_REVIEWER` unset (on). The chip should read "Purpose check on". |
| `REMIT_AGENT_TOKEN` | **Required** for the MCP scene. Use the same value in Claude Desktop's config. |
| `CHANNEL3_API_KEY` | **Leave unset for this script.** The demo catalog keeps the products and prices predictable ($32.49 dog food, $95 headphones). To compete for Best Use of Channel3, record a second, short clip with the key set that shows live search results, or rewrite the scenes around live products. |
| `REMIT_INR_RATE` | Leave at 88 to show rupee figures, or set it to 0 for a cleaner USD-only screen. |
| `REMIT_OWNER_PASSWORD` | Leave unset for a localhost recording. |

**Sandbox buyer:** use the sandbox **Personal** (buyer) account from developer.paypal.com → Testing Tools → Sandbox Accounts, the same one used for the Nov 6 run, under the same sandbox app as your client ID. Check it has enough balance for about $240 of holds. Log in once beforehand so the approval page is quick, and never show the password on screen.

**Claude Desktop:** add the `remit` MCP server to `claude_desktop_config.json` (see the README) with absolute paths, `REMIT_URL=http://localhost:3000` and the same `REMIT_AGENT_TOKEN`. Restart Claude Desktop and check that the five Remit tools appear. Start a fresh conversation.

**Screen:** close notifications, hide bookmarks, use one browser window at a readable zoom (110 to 125%), and do one full dry run before the take.

---

## Judging criteria map

Stage One is pass/fail: does the project fit the theme and use the required APIs? Stage Two weighs these five criteria equally. They are listed in the rules' order, which is also the tie-break order (Rules §6).

| Criterion (from the rules) | Where Remit shows it |
|---|---|
| **Technological Implementation**: "How thoroughly and skillfully does the project use PayPal Developer Platform and AI tool(s)? Does the project reflect genuine effort and a working, non-trivial implementation?" | PayPal: Orders v2 authorize, Payments v2 partial capture, reauthorize, void and refund, with idempotency keys, honor-period reauthorization, multi-hold captures with refund on failure, and handling of PayPal's own error codes (`MAX_CAPTURE_AMOUNT_EXCEEDED`, `PREVIOUSLY_CAPTURED`, `ORDER_NOT_APPROVED`). AI: a Claude Opus 5.5 tool-using agent plus an independent structured-output purpose check that fails closed, and an MCP server. Evidence: the sandbox run with a real authorization ID, `npm run sandbox-check`, 18 wallet tests, and `docs/architecture.html`. |
| **Design**: "Does the project deliver a complete, coherent product experience — not just a technical proof of concept?" | The whole loop for the owner is built: a request card you can edit before approving, PayPal approval, a balance meter, plan lines, a ledger with a reason on every row (refusals included), refunds, Close, and an activity feed. Each mode chip says what's real and what's simulated. The agent's replies quote dollars with rupees. Shown in video 0:08–0:56 and 1:40–1:52. |
| **Potential Impact**: "Does the project make a credible, specific case for solving a real problem for a real audience — and does the solution actually address that problem based on what's demonstrated?" | The audience is people who want an agent to shop for them but won't hand over a card. The problem: a spending limit says nothing about what money is for, so a misled agent can spend the full limit on the wrong thing. The video demonstrates the answer: a wrong-line purchase is refused, the agent asks with a reason, and only the owner can approve more. It runs on the PayPal account people already have, and any MCP agent can use it. |
| **Innovation/Idea**: "How creative and novel is the concept and does the project differ from existing concepts?" | The agent writes the budget with a reason for each line, and the owner approves a plan, not just an amount. Money is bound to a purpose, and an independent check enforces it at payment time. Refusals become new PayPal approvals, not dead ends. The pitch's comparison table (`docs/pitch.html`, "What's new") sets this against cards with limits and mandates. |
| **Presentation**: "Does the video clearly demonstrate the project working end-to-end? Does the pitch communicate what problem is solved, who it's for, and why it matters? Is the overall presentation easy to follow?" | The 2:00 video above covers budget → approval → paid → refused → top-up → paid → ledger, plus an outside agent over MCP, all on the real sandbox. The problem is in the first 8 seconds. The one-page pitch is `docs/pitch.html`. The limits are stated, not hidden. This also targets the Best Demo Delivery prize. |

**Prizes to aim for:** the Grand Prizes; Best Use of Agentic Commerce (an agent that plans, pays, gets refused and asks for more, and whose wallet any agent can use over MCP); Best Use of PayPal + AI (holds and captures driven by Claude, with a Claude purpose check on every capture); and the Channel3 sponsor prize, if the submission shows live Channel3 search.
