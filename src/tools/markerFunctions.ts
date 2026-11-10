import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack } from "../instrument.js";
import { formatNumber, onOff, parseNumber } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md section 4 (3K p.16-19). Behavior verified on the UTS3036B in
// docs/verified-hardware.md (Marker functions).

const FUNCTIONS = { off: "OFF", noise: "NOISe", band_power: "BPOWer", band_density: "BDENsity" } as const;
type FunctionName = keyof typeof FUNCTIONS;

const MARKER = z.number().int().min(1).max(10).describe("Marker number, 1 to 10");
const M = (n: number) => `:CALCulate:MARKer${n}`;

function parseFunction(reply: string): FunctionName {
  const text = reply.trim().toUpperCase();
  for (const [name, raw] of Object.entries(FUNCTIONS) as Array<[FunctionName, string]>) {
    if (text === raw.toUpperCase() || text === raw.replace(/[a-z]/g, "").toUpperCase()) return name;
  }
  throw new Error(`Unexpected marker function ${JSON.stringify(reply)}`);
}

function close(requested: number, actual: number): boolean {
  return Math.abs(requested - actual) <= Math.max(1e-9, 1e-5 * Math.abs(requested));
}

export interface MarkerFunctionState {
  marker: number;
  function: FunctionName;
  /** Hz. Width of the band the band_power / band_density functions integrate over. */
  band_span_hz: number;
}

async function readFunction(n: number): Promise<MarkerFunctionState> {
  const fn = await queryParsed(`${M(n)}:FUNCtion?`, parseFunction);
  const band_span_hz = await queryNumber(`${M(n)}:FUNCtion:BAND:SPAN?`);
  return { marker: n, function: fn, band_span_hz };
}

export interface MarkerNdbState {
  marker: number;
  enabled: boolean;
  /** dB below the marker (negative), -140 to -0.01. */
  ndb: number;
  /** Measured bandwidth in Hz; null while N-dB is off or when the trace does not fall N dB on both sides (the instrument says nan). */
  bandwidth_hz: number | null;
}

/** The instrument answers nan when no N-dB bandwidth can be found. */
const parseBandwidth = (reply: string): number | null => (reply.trim().toLowerCase() === "nan" ? null : parseNumber(reply));

async function readNdb(n: number): Promise<MarkerNdbState> {
  const enabled = await queryBool(`${M(n)}:BANDwidth:STATe?`);
  const ndb = await queryNumber(`${M(n)}:BANDwidth:NDB?`);
  const bandwidth_hz = enabled ? await queryParsed(`${M(n)}:BANDwidth:RESult?`, parseBandwidth) : null;
  return { marker: n, enabled, ndb, bandwidth_hz };
}

export interface FrequencyCounterState {
  enabled: boolean;
  gate_time_s: number;
  /** Counted frequency of the selected marker in Hz; null while the counter is off or when the instrument reports no valid count (9.91e37). */
  frequency_hz: number | null;
}

const FC = ":CALCulate:MARKer:FCOunt";

async function readCounter(): Promise<FrequencyCounterState> {
  const enabled = await queryBool(`${FC}:STATe?`);
  const gate_time_s = await queryNumber(`${FC}:GATetime?`);
  // The result query is only sent while the counter is on: with it off the instrument answers 9.91e37 (invalid).
  const count = enabled ? await queryNumber(`${FC}:X?`) : null;
  return { enabled, gate_time_s, frequency_hz: count === null || count >= 9.9e37 ? null : count };
}

export function registerMarkerFunctionTools(server: McpServer): void {
  defineTool(
    server,
    "get_marker_function",
    "Read a marker's function (off, noise, band_power, band_density) and the band span used by the band functions. " +
      "The function result is the marker's level: read it with get_marker (y).",
    { marker: MARKER.default(1) },
    { readOnlyHint: true },
    async ({ marker }) => {
      try {
        return textResult(JSON.stringify(await readFunction(marker), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_marker_function",
    "Set a marker's function: noise (noise level per Hz), band_power (power in the band), band_density (power density in the band) or off. " +
      "band_span_hz sets the band width for band_power and band_density. Read the result with get_marker. Values the instrument changed are reported in 'warnings'.",
    {
      marker: MARKER,
      function: z.enum(["off", "noise", "band_power", "band_density"]).optional().describe("Marker function"),
      band_span_hz: z.number().finite().positive().optional().describe("Band span in Hz for band_power / band_density"),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        const commands: string[] = [];
        if (a.band_span_hz !== undefined) commands.push(`${M(a.marker)}:FUNCtion:BAND:SPAN ${formatNumber(a.band_span_hz)}`);
        if (a.function !== undefined) commands.push(`${M(a.marker)}:FUNCtion ${FUNCTIONS[a.function]}`);
        await applyCommands(commands);
        const state = await readBack(() => readFunction(a.marker));
        const warnings: string[] = [];
        if (a.function !== undefined && a.function !== state.function) {
          warnings.push(`function adjusted by the instrument: requested ${a.function}, now ${state.function}`);
        }
        if (a.band_span_hz !== undefined && !close(a.band_span_hz, state.band_span_hz)) {
          warnings.push(`band_span_hz adjusted by the instrument: requested ${a.band_span_hz} Hz, now ${state.band_span_hz} Hz`);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_marker_function");
      }
    },
    { validate: (a) => (a.function === undefined && a.band_span_hz === undefined ? "No parameters given; provide function and/or band_span_hz." : undefined) }
  );

  defineTool(
    server,
    "get_marker_ndb",
    "Read a marker's N-dB bandwidth measurement: whether it is on, the N value (dB below the marker) and, when on, the measured bandwidth in Hz.",
    { marker: MARKER.default(1) },
    { readOnlyHint: true },
    async ({ marker }) => {
      try {
        return textResult(JSON.stringify(await readNdb(marker), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_marker_ndb",
    "Turn a marker's N-dB bandwidth measurement on or off and/or set N (dB below the marker, -140 to -0.01, e.g. -3 or -6). " +
      "Returns the state including the measured bandwidth in Hz (null while off).",
    {
      marker: MARKER,
      enabled: z.boolean().optional().describe("Turn the N-dB measurement on or off"),
      ndb: z.number().finite().optional().describe("N in dB, negative: -140 to -0.01"),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        const commands: string[] = [];
        if (a.ndb !== undefined) commands.push(`${M(a.marker)}:BANDwidth:NDB ${formatNumber(a.ndb)}`);
        if (a.enabled !== undefined) commands.push(`${M(a.marker)}:BANDwidth:STATe ${onOff(a.enabled)}`);
        await applyCommands(commands);
        const state = await readBack(() => readNdb(a.marker));
        const warnings: string[] = [];
        if (a.enabled !== undefined && a.enabled !== state.enabled) {
          warnings.push(`enabled adjusted by the instrument: requested ${a.enabled}, now ${state.enabled}`);
        }
        if (a.ndb !== undefined && !close(a.ndb, state.ndb)) {
          warnings.push(`ndb adjusted by the instrument: requested ${a.ndb} dB, now ${state.ndb} dB`);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_marker_ndb");
      }
    },
    {
      validate: (a) => {
        if (a.enabled === undefined && a.ndb === undefined) return "No parameters given; provide enabled and/or ndb.";
        if (a.ndb !== undefined && !(a.ndb <= -0.01 && a.ndb >= -140)) return "ndb must be between -140 and -0.01 (dB below the marker).";
        return undefined;
      },
    }
  );

  defineTool(
    server,
    "get_frequency_counter",
    "Read the marker frequency counter: whether it is on and its gate time in seconds.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readCounter(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_frequency_counter",
    "Turn the marker frequency counter on or off and/or set its gate time (1 us to 500 ms). Values the instrument changed are reported in 'warnings'.",
    {
      enabled: z.boolean().optional().describe("Counter on or off"),
      gate_time_s: z.number().finite().optional().describe("Gate time in seconds, 1e-6 to 0.5"),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        const commands: string[] = [];
        if (a.gate_time_s !== undefined) commands.push(`${FC}:GATetime ${formatNumber(a.gate_time_s)}`);
        if (a.enabled !== undefined) commands.push(`${FC}:STATe ${onOff(a.enabled)}`);
        await applyCommands(commands);
        const state = await readBack(readCounter);
        const warnings: string[] = [];
        if (a.enabled !== undefined && a.enabled !== state.enabled) {
          warnings.push(`enabled adjusted by the instrument: requested ${a.enabled}, now ${state.enabled}`);
        }
        if (a.gate_time_s !== undefined && !close(a.gate_time_s, state.gate_time_s)) {
          warnings.push(`gate_time_s adjusted by the instrument: requested ${a.gate_time_s} s, now ${state.gate_time_s} s`);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_frequency_counter");
      }
    },
    {
      validate: (a) => {
        if (a.enabled === undefined && a.gate_time_s === undefined) return "No parameters given; provide enabled and/or gate_time_s.";
        if (a.gate_time_s !== undefined && !(a.gate_time_s >= 1e-6 && a.gate_time_s <= 0.5)) return "gate_time_s must be between 1e-6 and 0.5 seconds.";
        return undefined;
      },
    }
  );
}
