#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { autoConnectFromEnv } from "./autoconnect.js";
import { connection } from "./connection.js";

// Prevent uncaught errors from killing the MCP server process.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("uni-t-uts-mcp server running on stdio");

  // Fire-and-forget so a slow or absent analyzer never blocks MCP startup.
  autoConnectFromEnv(process.env, connection, console.error).catch((err) => {
    console.error("Auto-connect failed unexpectedly:", err);
  });
}

main().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
