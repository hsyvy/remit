import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWalletMcpServer, forwardToWallet } from "./server.ts";

/**
 * The wallet over MCP, so any agent (Claude Desktop, Cursor, ...) can spend under the owner's limit.
 * It holds no PayPal keys and no money rules: every call goes to the running wallet service.
 * Hosted agents can skip this and connect to the service's /mcp endpoint instead.
 *
 *   REMIT_URL=http://localhost:3000 REMIT_AGENT_TOKEN=... npm run mcp
 */

const baseUrl = process.env.REMIT_URL ?? process.env.APP_URL ?? "http://localhost:3000";
const token = process.env.REMIT_AGENT_TOKEN;
if (!token) {
  console.error("Set REMIT_AGENT_TOKEN to the same value the wallet service uses.");
  process.exit(1);
}

const server = createWalletMcpServer(forwardToWallet(baseUrl, token));
await server.connect(new StdioServerTransport());
