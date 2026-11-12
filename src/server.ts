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
import { registerMarkerTools } from "./tools/marker.js";
import { registerMarkerFunctionTools } from "./tools/markerFunctions.js";
import { registerLimitLineTools } from "./tools/limitLines.js";
import { registerTrackingGeneratorTools } from "./tools/trackingGenerator.js";
import { registerMeasurementTools } from "./tools/measurement.js";
import { registerInstrumentModuleTools } from "./tools/instrumentModule.js";
import { registerEmiSettingsTools } from "./tools/emiSettings.js";
import { registerEmiScanTableTools } from "./tools/emiScanTable.js";
import { registerEmiMeasurementTools } from "./tools/emiMeasurement.js";
import { registerEmiLimitLineTools } from "./tools/emiLimitLines.js";
import { registerAnalogDemodTools } from "./tools/analogDemod.js";
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
  registerMarkerTools(server);
  registerMarkerFunctionTools(server);
  registerLimitLineTools(server);
  registerMeasurementTools(server);
  registerTrackingGeneratorTools(server);
  registerInstrumentModuleTools(server);
  registerEmiSettingsTools(server);
  registerEmiScanTableTools(server);
  registerEmiMeasurementTools(server);
  registerEmiLimitLineTools(server);
  registerAnalogDemodTools(server);
  return server;
}
