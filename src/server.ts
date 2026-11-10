import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectionTools } from "./tools/connection.js";
import { registerScpiTools } from "./tools/scpi.js";
import { registerFrequencyTools } from "./tools/frequency.js";
import { registerAmplitudeTools } from "./tools/amplitude.js";
import { registerBandwidthSweepTools } from "./tools/bandwidthSweep.js";
import { registerAcquisitionTools } from "./tools/acquisition.js";
import { registerTraceTools } from "./tools/trace.js";
import { registerScreenshotTools } from "./tools/screenshot.js";
import { registerTraceDataTools } from "./tools/traceData.js";
import { guardToolRegistration } from "./tools/util.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Build the MCP server with every tool group registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "uni-t-uts-mcp", version });
  guardToolRegistration(server);
  registerConnectionTools(server);
  registerScpiTools(server);
  registerFrequencyTools(server);
  registerAmplitudeTools(server);
  registerBandwidthSweepTools(server);
  registerAcquisitionTools(server);
  registerTraceTools(server);
  registerScreenshotTools(server);
  registerTraceDataTools(server);
  return server;
}
