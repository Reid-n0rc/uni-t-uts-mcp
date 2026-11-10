import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { DEFAULT_PORT, isValidHost, portFromEnv } from "../target.js";
import { errorResult, textResult } from "./util.js";

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    "connect",
    "Connect to a UNI-T UTS series spectrum analyzer over TCP (raw SCPI). Returns the instrument identification on success.",
    {
      host: z
        .string()
        .refine(isValidHost, "host must be a hostname or IP address")
        .optional()
        .describe("Hostname or IP address of the analyzer (defaults to the UTS_IP env var)"),
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe(`TCP port (defaults to the UTS_PORT env var, then ${DEFAULT_PORT})`),
    },
    { readOnlyHint: false, openWorldHint: true },
    async ({ host, port }) => {
      try {
        const targetHost = host || process.env.UTS_IP;
        if (!targetHost) {
          return errorResult(
            "No host specified. Provide a 'host' parameter or set the UTS_IP environment variable."
          );
        }
        if (!isValidHost(targetHost)) {
          return errorResult("UTS_IP is not a valid hostname or IP address");
        }
        const targetPort = port ?? portFromEnv(process.env.UTS_PORT);
        const idn = await connection.connect(targetHost, targetPort);
        return textResult(`Connected to ${targetHost}:${targetPort}\nDevice: ${idn}`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "disconnect",
    "Disconnect from the spectrum analyzer.",
    {},
    { readOnlyHint: false },
    async () => {
      if (!connection.isConnected()) return textResult("Not connected.");
      connection.disconnect();
      return textResult("Disconnected.");
    }
  );

  server.tool(
    "identify",
    "Query the analyzer identification (*IDN?): manufacturer, model, serial number and firmware version.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(await connection.query("*IDN?"));
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
