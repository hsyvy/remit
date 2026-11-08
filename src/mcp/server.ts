import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { walletToolDefs, type WalletToolName } from "../wallet/tools.ts";

/** Runs one wallet tool and returns the MCP result. Stdio forwards over HTTP; the remote endpoint runs in process. */
export type ToolCall = (name: WalletToolName, input: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * The wallet as an MCP server. Both the stdio server and the remote /mcp endpoint build it here,
 * so tool names, descriptions and schemas come from one place: walletToolDefs.
 */
export function createWalletMcpServer(call: ToolCall) {
  const server = new McpServer({ name: "remit-wallet", version: "0.1.0" });
  for (const [name, def] of Object.entries(walletToolDefs)) {
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.input.shape },
      (input: Record<string, unknown>) => call(name as WalletToolName, input),
    );
  }
  return server;
}

export const okResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
export const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** For the stdio server: send each call to the wallet service's agent API. */
export function forwardToWallet(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ToolCall {
  const base = baseUrl.replace(/\/$/, "");
  return async (name, input) => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/agent/v1/tools/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch (err) {
      return errorResult(`Wallet unreachable at ${base}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      return errorResult(message);
    }
    return okResult(text);
  };
}
