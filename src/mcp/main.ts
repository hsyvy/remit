import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { walletToolDefs, type WalletToolName } from "../wallet/tools.ts";

/**
 * The wallet over MCP, so any agent (Claude Desktop, Cursor, ...) can spend under the owner's limit.
 * It holds no PayPal keys and no money rules: every call goes to the running wallet service.
 *
 *   REMIT_URL=http://localhost:3000 REMIT_AGENT_TOKEN=... npm run mcp
 */

const baseUrl = (process.env.REMIT_URL ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = process.env.REMIT_AGENT_TOKEN;
if (!token) {
  console.error("Set REMIT_AGENT_TOKEN to the same value the wallet service uses.");
  process.exit(1);
}

const server = new McpServer({ name: "remit-wallet", version: "0.1.0" });

for (const [name, def] of Object.entries(walletToolDefs)) {
  server.registerTool(
    name,
    { description: def.description, inputSchema: def.input.shape },
    async (input: Record<string, unknown>) => {
      const res = await fetch(`${baseUrl}/agent/v1/tools/${name as WalletToolName}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }).catch((err: Error) => ({ ok: false, text: async () => JSON.stringify({ message: `Wallet unreachable at ${baseUrl}: ${err.message}` }) }));
      const text = await res.text();
      if (!res.ok) {
        let message = text;
        try {
          message = JSON.parse(text).message ?? text;
        } catch {}
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
      return { content: [{ type: "text" as const, text }] };
    },
  );
}

await server.connect(new StdioServerTransport());
