#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { autoConnectAll } from "./autoconnect.js";
import { instruments } from "./registry.js";
import "./connection.js";
import { installShutdownHandlers } from "./shutdown.js";

// Prevent uncaught errors from killing the MCP server process.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

async function main(): Promise<void> {
  installShutdownHandlers(process, instruments, (code) => process.exit(code));
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error("uni-t-uts-mcp server running on stdio");

  // Fire-and-forget so a slow or absent analyzer never blocks MCP startup.
  autoConnectAll(process.env, instruments, console.error).catch((err) => {
    console.error("Auto-connect failed unexpectedly:", err);
  });
}

main().catch((error) => {
  console.error("Startup error:", error);
  process.exit(1);
});
