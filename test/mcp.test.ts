import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createWalletMcpServer, forwardToWallet } from "../src/mcp/server.ts";
import { walletToolDefs } from "../src/wallet/tools.ts";
import { AGENT_TOKEN, APP, makeApp, openBudget, OWNER_PASSWORD, today } from "./fixtures.ts";

type App = ReturnType<typeof makeApp>["app"];

/** An MCP client talking Streamable HTTP to the Hono app, without opening a port. */
async function connect(app: App, token = AGENT_TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(`${APP}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(String(url), init),
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (result: unknown) => (result as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("");

const spendInput = { line: "groceries", amount: 12.5, title: "Rice, 5 kg", merchant: "shop.example", reasoning: "On the list" };

describe("remote MCP endpoint", () => {
  it("lists the wallet tools with their descriptions", async () => {
    const { app } = makeApp({ agentToken: AGENT_TOKEN });
    const client = await connect(app);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(walletToolDefs).sort());
    const spend = tools.find((t) => t.name === "spend")!;
    assert.equal(spend.description, walletToolDefs.spend.description);
    assert.deepEqual([...(spend.inputSchema.required ?? [])].sort(), ["amount", "line", "merchant", "reasoning", "title"]);
    await client.close();
  });

  it("reads the balance and spends from the wallet in process", async () => {
    const { app, wallet, paypal } = makeApp({ agentToken: AGENT_TOKEN, ownerPassword: OWNER_PASSWORD });
    const client = await connect(app);

    assert.equal(JSON.parse(textOf(await client.callTool({ name: "get_balance", arguments: {} }))).budget, "none");

    await openBudget(wallet, paypal);
    const balance = JSON.parse(textOf(await client.callTool({ name: "get_balance", arguments: {} })));
    assert.equal(balance.status, "open");
    assert.equal(balance.left, "$50.00");

    const paid = await client.callTool({ name: "spend", arguments: spendInput });
    assert.ok(!paid.isError, textOf(paid));
    assert.equal(JSON.parse(textOf(paid)).status, "paid");
    assert.equal(wallet.balance().leftCents, 3750);
    assert.equal(wallet.state().purchases[0]?.agent, "default");
    await client.close();
  });

  it("returns wallet refusals and bad input as tool errors", async () => {
    const { app, wallet, paypal } = makeApp({ agentToken: AGENT_TOKEN });
    const client = await connect(app);

    const noBudget = await client.callTool({ name: "spend", arguments: spendInput });
    assert.equal(noBudget.isError, true);
    assert.match(textOf(noBudget), /no approved budget/);

    await openBudget(wallet, paypal);
    const over = await client.callTool({ name: "spend", arguments: { ...spendInput, amount: 80 } });
    assert.equal(over.isError, true);
    assert.equal(wallet.balance().leftCents, 5000);

    const bad = await client.callTool({ name: "spend", arguments: { line: "groceries" } });
    assert.equal(bad.isError, true);
    await client.close();
  });

  it("needs the agent token", async () => {
    const { app } = makeApp({ agentToken: AGENT_TOKEN, ownerPassword: OWNER_PASSWORD });
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    };
    assert.equal((await app.request("/mcp", init)).status, 401);
    assert.equal((await app.request("/mcp", { ...init, headers: { ...init.headers, Authorization: "Bearer wrong" } })).status, 401);
    // The owner password is not an agent token (Hono answers a non-Bearer header with 400).
    const owner = `Basic ${Buffer.from(`owner:${OWNER_PASSWORD}`).toString("base64")}`;
    const asOwner = await app.request("/mcp", { ...init, headers: { ...init.headers, Authorization: owner } });
    assert.ok([400, 401].includes(asOwner.status), String(asOwner.status));
    await assert.rejects(connect(app, "wrong"));
  });

  it("records each purchase under the agent whose token made it", async () => {
    const { app, wallet, paypal } = makeApp();
    const a = wallet.agents.create("Grocery bot");
    const b = wallet.agents.create("Other bot");
    const { requestId } = wallet.requestBudget({
      summary: "Household week",
      startsOn: today(),
      endsOn: today(6),
      lines: [{ key: "groceries", label: "Groceries", amountCents: 5000, reason: "Last 4 weeks averaged $43.70 per order." }],
      agentId: a.agent.id,
    });
    const { orderId } = await wallet.checkout(requestId);
    paypal.approve(orderId);
    await wallet.completeApproval(requestId, orderId);

    const asB = await connect(app, b.token);
    const refused = await asB.callTool({ name: "spend", arguments: spendInput });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /another agent's line/);
    await asB.close();

    const asA = await connect(app, a.token);
    const paid = await asA.callTool({ name: "spend", arguments: spendInput });
    assert.ok(!paid.isError, textOf(paid));
    assert.equal(wallet.state().purchases[0]?.agent, a.agent.id);
    await asA.close();

    // No shared token set: only Agents-page tokens get in.
    assert.equal((await app.request("/mcp", { method: "POST", body: "{}" })).status, 401);
  });
});

describe("stdio MCP server", () => {
  /** A fake fetch that records each call and answers with the given status and body. */
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    return { calls, fetch: fetch as typeof globalThis.fetch };
  }

  async function connectStdio(fetch: typeof globalThis.fetch) {
    const server = createWalletMcpServer(forwardToWallet("http://wallet.test/", "tok", fetch));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    return client;
  }

  it("forwards each call to the agent API with the token", async () => {
    const fake = fakeFetch(200, { status: "paid", amount: "$12.50" });
    const client = await connectStdio(fake.fetch);
    const result = await client.callTool({ name: "spend", arguments: spendInput });

    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.equal(call.url, "http://wallet.test/agent/v1/tools/spend");
    assert.equal(call.init.method, "POST");
    assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(String(call.init.body)), spendInput);
    assert.ok(!result.isError);
    assert.deepEqual(JSON.parse(textOf(result)), { status: "paid", amount: "$12.50" });
    await client.close();
  });

  it("checks input before forwarding", async () => {
    const fake = fakeFetch(200, {});
    const client = await connectStdio(fake.fetch);
    const result = await client.callTool({ name: "spend", arguments: { line: "groceries" } });
    assert.equal(result.isError, true);
    assert.equal(fake.calls.length, 0);
    await client.close();
  });

  it("turns a wallet error into an error result with its message", async () => {
    const fake = fakeFetch(409, { error: "OVER_LINE", message: "Groceries has $5.00 left." });
    const result = await forwardToWallet("http://wallet.test", "tok", fake.fetch)("spend", spendInput);
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Groceries has $5.00 left.");
  });

  it("says when the wallet is unreachable", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof globalThis.fetch;
    const result = await forwardToWallet("http://wallet.test", "tok", down)("get_balance", {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Wallet unreachable at http://wallet.test: connect ECONNREFUSED");
  });
});
