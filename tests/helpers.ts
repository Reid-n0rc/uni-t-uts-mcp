import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export type Registrar = (server: McpServer) => void;
export type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

/**
 * Create an MCP server with the given tool registrars, linked in-memory to a
 * client. No stdio or network is involved.
 */
export async function createTestServer(...registrars: Registrar[]) {
  const server = new McpServer({ name: "uni-t-uts-mcp-test", version: "0.0.0" });
  for (const register of registrars) register(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    server,
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  return client.callTool({ name, arguments: args });
}

/** Text of the first text content block; throws if there is none. */
export function getText(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const block = content.find((c) => c.type === "text" && typeof c.text === "string");
  if (!block) throw new Error("Tool result has no text content");
  return block.text as string;
}
