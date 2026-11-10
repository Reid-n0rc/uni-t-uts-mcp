import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerScpiTools } from "./tools/scpi.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Build the MCP server with every tool group registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "uni-t-uts-mcp", version });
  registerConnectionTools(server);
  registerScpiTools(server);
  return server;
}
