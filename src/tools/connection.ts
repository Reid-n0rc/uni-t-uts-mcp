import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { DEFAULT_PORT, isValidHost, portFromEnv } from "../target.js";
import { TRANSPORT_CHOICES, resolveTransport, vxi11DeviceFromEnv } from "../transports/select.js";
import { errorResult, textResult, defineTool } from "./util.js";

export function registerConnectionTools(server: McpServer): void {
  defineTool(
    server,
    "connect",
    "Connect to a UNI-T UTS series spectrum analyzer over auto (default: VXI-11 when the instrument offers it, else raw SCPI/TCP), VXI-11 or raw SCPI/TCP. Returns the instrument identification and the transport in use.",
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
        .describe(`TCP port of the raw transport (defaults to the UTS_PORT env var, then ${DEFAULT_PORT}); VXI-11 finds its own port through the portmapper on port 111`),
      transport: z
        .enum(TRANSPORT_CHOICES as [string, ...string[]])
        .optional()
        .describe("raw, vxi11 or auto (defaults to the UTS_TRANSPORT env var, then auto; raw when only a port is given). The VXI-11 device name comes from UTS_VXI11_DEVICE (default inst0)"),
    },
    { readOnlyHint: false, openWorldHint: true },
    async ({ host, port, transport }) => {
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
        const portGiven = port !== undefined || (process.env.UTS_PORT !== undefined && process.env.UTS_PORT !== "");
        const choice = resolveTransport({ param: transport, env: process.env.UTS_TRANSPORT, portGiven });
        const device = vxi11DeviceFromEnv(process.env.UTS_VXI11_DEVICE);
        if (port !== undefined && choice === "vxi11") {
          return errorResult(
            "The 'port' parameter applies to the raw transport only; VXI-11 finds its port through the portmapper (port 111). " +
              "Omit 'port', or use transport raw or auto."
          );
        }
        const idn = await connection.connect(targetHost, targetPort, {
          transport: choice,
          vxi11Device: device,
          log: (message) => console.error(message),
        });
        const where = connection.transportName === "vxi11" ? targetHost : `${targetHost}:${targetPort}`;
        return textResult(`Connected to ${where}\nTransport: ${connection.transportLabel}\nDevice: ${idn}`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "disconnect",
    "Disconnect from the spectrum analyzer.",
    {},
    { readOnlyHint: false },
    async () => {
      try {
        if (!connection.isConnected()) return textResult("Not connected.");
        connection.disconnect();
        return textResult("Disconnected.");
      } catch (err) {
        return errorResult(err);
      }
    },
    // Must not wait behind a running operation: it fails everything queued and ends the connection.
    { exclusive: false }
  );

  defineTool(
    server,
    "identify",
    "Query the analyzer identification (*IDN?): manufacturer, model, serial number and firmware version.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const reply = await connection.query("*IDN?");
        // manufacturer,model,serial,firmware
        if (reply.trim().split(",").length < 4) {
          return errorResult(
            `Invalid reply to *IDN?: ${JSON.stringify(reply)} (expected manufacturer,model,serial,firmware). ` +
              "Check that the host and port are a UNI-T analyzer's SCPI port."
          );
        }
        return textResult(`${reply}\nTransport: ${connection.transportLabel}`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
