import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { PayPalError } from "../paypal/gateway.ts";
import { runWalletTool } from "../wallet/tools.ts";
import { errorText, WalletError, type Wallet } from "../wallet/wallet.ts";
import { createWalletMcpServer, errorResult, okResult, type ToolCall } from "./server.ts";

/**
 * The remote MCP endpoint (Streamable HTTP, stateless). The API server mounts it at /mcp behind
 * the agent token, and passes the agent that token belongs to. Each request gets a fresh MCP server that calls the wallet in process.
 */
export async function handleMcpRequest(wallet: Wallet, req: Request, agentId: string): Promise<Response> {
  const server = createWalletMcpServer(runInProcess(wallet, agentId));
  // No session id means stateless; JSON responses because nothing here streams.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}

/** Same results and error messages as POST /agent/v1/tools/:name, without the HTTP hop. */
export function runInProcess(wallet: Wallet, agentId: string): ToolCall {
  return async (name, input) => {
    try {
      return okResult(JSON.stringify(await runWalletTool(wallet, name, input, agentId)));
    } catch (err) {
      if (err instanceof WalletError) return errorResult(err.message);
      if (err instanceof PayPalError) return errorResult(`PayPal: ${err.message}`);
      if (err instanceof z.ZodError) return errorResult(z.prettifyError(err));
      console.error(err);
      return errorResult(errorText(err));
    }
  };
}
