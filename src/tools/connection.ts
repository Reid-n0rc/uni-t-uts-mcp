import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { DEFAULT_INSTRUMENT, instruments, isValidInstrumentName } from "../registry.js";
import { DEFAULT_PORT, isValidHost, portFromEnv } from "../target.js";
import { AUTO_HOST, autoSelectedNote, resolveAutoHost } from "../autoHost.js";
import { discoverInstruments } from "../discovery.js";
import { TRANSPORT_CHOICES, resolveTransport, vxi11DeviceFromEnv, vxi11ProbeBudgetFromEnv } from "../transports/select.js";
import { errorResult, textResult, defineTool } from "./util.js";

/** Hosts in `discover_instruments` results that must not be probed again: the ones this server is connected to. */
function connectedHosts(): Set<string> {
  const hosts = new Set<string>();
  const conns = instruments.names().length > 0 ? instruments.names().map((n) => instruments.get(n)!) : [connection];
  for (const c of conns) {
    if (!c.isConnected()) continue;
    const host = /^[^\s:]+/.exec(c.getConnectionInfo())?.[0];
    if (host) hosts.add(host);
  }
  return hosts;
}

const NAME_DESCRIPTION =
  "Instrument name (1-32 letters, digits, '_' or '-'). Default: the `default` instrument, or the only one configured. See list_instruments";

const nameShape = (extra: string) => ({
  name: z.string().refine(isValidInstrumentName, "name must be 1-32 characters: letters, digits, '_' or '-'").optional().describe(NAME_DESCRIPTION + extra),
});

/** Seen on a UTS3036B V1.04.0040 over raw TCP (issue #155); VXI-11 was not separately isolated. */
const PANEL_NOTE =
  "Note: a command sent after connecting (observed for everything except *IDN? and :SYSTem:LOCK?) puts the analyzer into remote mode, and its front panel (touch screen and buttons) is locked while it is remote. Press Esc on the analyzer's front panel to return it to local mode.";
const PANEL_NOTE_DISCONNECT =
  "Note: disconnecting is not known to return the analyzer to local mode; if its front panel is still locked, press Esc on the analyzer.";

export function registerConnectionTools(server: McpServer): void {
  defineTool(
    server,
    "discover_instruments",
    "Find UNI-T / VXI-11 spectrum analyzers on the local network without knowing their IP address: broadcasts a portmapper query on each local IPv4 interface and identifies every responder with *IDN? (read-only; the serial number is not shown). Returns host, model, firmware and whether VXI-11 and raw port 5025 answer.",
    {
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(10000)
        .optional()
        .describe("How long to wait for replies in ms (default 1500)"),
    },
    { readOnlyHint: true, openWorldHint: true },
    async ({ timeout_ms }) => {
      try {
        const result = await discoverInstruments({ windowMs: timeout_ms, skipIdentify: connectedHosts() });
        const hint =
          result.instruments.some((i) => i.analyzer)
            ? "Pass a host as the 'host' parameter of connect, or use host \"auto\" when exactly one analyzer is listed."
            : "No analyzer found. Check that it is powered, on the same subnet and that LAN is enabled, or give its address to connect.";
        return textResult(JSON.stringify({ instruments: result.instruments, notes: result.notes, hint }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    // Uses its own sockets, never the shared instrument connection: no need to wait behind (or hold up) other tools.
    { exclusive: false, instrumentArg: false }
  );

  defineTool(
    server,
    "connect",
    "Connect to a UNI-T UTS series spectrum analyzer over auto (default: VXI-11 when the instrument offers it, else raw SCPI/TCP), VXI-11 or raw SCPI/TCP. Returns the instrument identification and the transport in use. Use host \"auto\" (or UTS_IP=auto) to find the analyzer on the local network when exactly one answers. Using the analyzer puts it in remote mode and locks its front panel until Esc is pressed on the analyzer.",
    {
      ...nameShape(". connect creates the name when it is new (host and port then come from the arguments or UTS_INSTRUMENTS)"),
      host: z
        .string()
        .refine(isValidHost, "host must be a hostname or IP address")
        .optional()
        .describe('Hostname or IP address of the analyzer (defaults to the UTS_IP env var); "auto" discovers it on the local network (see discover_instruments)'),
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
    async ({ name, host, port, transport }) => {
      try {
        // Where this instrument is configured: UTS_IP/UTS_PORT belong to `default`, UTS_INSTRUMENTS to the named ones.
        const effective = name ?? instruments.implicitName() ?? DEFAULT_INSTRUMENT;
        const configured = instruments.target(effective);
        const isDefault = effective === DEFAULT_INSTRUMENT;
        let targetHost = host || configured?.host || (isDefault ? process.env.UTS_IP : undefined);
        let autoNote = "";
        if (targetHost?.toLowerCase() === AUTO_HOST) {
          const found = await resolveAutoHost();
          if ("error" in found) return errorResult(found.error);
          targetHost = found.host;
          autoNote = "\n" + autoSelectedNote(found.host, found.model, found.firmware);
        }
        if (!targetHost) {
          return errorResult(
            isDefault
              ? "No host specified. Provide a 'host' parameter or set the UTS_IP environment variable."
              : `No host specified for instrument "${effective}". Provide a 'host' parameter or define it in the UTS_INSTRUMENTS environment variable (name=host:port).`
          );
        }
        if (!isValidHost(targetHost)) {
          return errorResult(isDefault ? "UTS_IP is not a valid hostname or IP address" : `The host of instrument "${effective}" is not a valid hostname or IP address`);
        }
        const envPort = isDefault ? process.env.UTS_PORT : undefined;
        const targetPort = port ?? configured?.port ?? portFromEnv(envPort);
        const portGiven = port !== undefined || configured?.port !== undefined || (envPort !== undefined && envPort !== "");
        const choice = resolveTransport({ param: transport, env: process.env.UTS_TRANSPORT, portGiven });
        const device = vxi11DeviceFromEnv(process.env.UTS_VXI11_DEVICE);
        const vxi11ProbeBudgetMs = vxi11ProbeBudgetFromEnv(process.env.UTS_VXI11_PROBE_TIMEOUT_S);
        if (port !== undefined && choice === "vxi11") {
          return errorResult(
            "The 'port' parameter applies to the raw transport only; VXI-11 finds its port through the portmapper (port 111). " +
              "Omit 'port', or use transport raw or auto."
          );
        }
        const idn = await connection.connect(targetHost, targetPort, {
          transport: choice,
          vxi11Device: device,
          vxi11ProbeBudgetMs,
          log: (message) => console.error(message),
        });
        const where = connection.transportName === "vxi11" ? targetHost : `${targetHost}:${targetPort}`;
        return textResult(`Connected to ${where}\nTransport: ${connection.transportLabel}\nDevice: ${idn}${autoNote}${name !== undefined ? `\nInstrument: ${name}` : ""}\n${PANEL_NOTE}`);
      } catch (err) {
        return errorResult(err);
      }
    },
    { instrumentArg: { name: "name", create: true } }
  );

  defineTool(
    server,
    "disconnect",
    "Disconnect from the spectrum analyzer (the instrument named by `name`, default: the default one). The name stays registered so it can be connected again.",
    nameShape(""),
    { readOnlyHint: false },
    async () => {
      try {
        if (!connection.isConnected()) return textResult("Not connected.");
        connection.disconnect();
        return textResult(`Disconnected.\n${PANEL_NOTE_DISCONNECT}`);
      } catch (err) {
        return errorResult(err);
      }
    },
    // Must not wait behind a running operation: it fails everything queued and ends the connection.
    { exclusive: false, instrumentArg: { name: "name" } }
  );

  defineTool(
    server,
    "identify",
    "Query the analyzer identification (*IDN?): manufacturer, model, serial number and firmware version.",
    nameShape(""),
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
    },
    { instrumentArg: { name: "name" } }
  );

  defineTool(
    server,
    "list_instruments",
    "List the instruments this server knows by name (the default one, those from UTS_INSTRUMENTS and any added with connect name=...): whether each is connected, where, over which transport, and which one is used when no name is given. Read-only; the serial number is not shown.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const implicit = instruments.implicitName();
        const list = instruments.names().map((n) => {
          const conn = instruments.get(n)!;
          const target = instruments.target(n);
          const connected = conn.isConnected();
          return {
            name: n,
            connected,
            isDefault: n === implicit,
            ...(connected ? { connection: conn.getConnectionInfo(), transport: conn.transportLabel } : {}),
            ...(target ? { configured: target.port === undefined ? target.host : `${target.host}:${target.port}` } : {}),
          };
        });
        const hint =
          list.length === 0
            ? "No instruments yet. Use connect (host and optionally name) to add one, or set UTS_IP / UTS_INSTRUMENTS."
            : implicit === undefined
              ? "Several instruments and none is named \"default\": name the one you mean (argument 'name' for connect, disconnect and identify)."
              : `Calls without a name use "${implicit}".`;
        return textResult(JSON.stringify({ instruments: list, hint }, null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    // Reads the registry only; must not wait behind a long sweep.
    { exclusive: false, instrumentArg: false }
  );
}
