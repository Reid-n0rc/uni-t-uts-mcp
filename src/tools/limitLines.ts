import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack, ReplyError } from "../instrument.js";
import { connection } from "../connection.js";
import { formatNumber, parseNumberList } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md section 5 (3K p.27-32). Behavior verified on the UTS3036B in
// docs/verified-hardware.md (Limit lines). The manual documents no pass/fail read-back, so there is
// no tool for it (ambiguity 10).

const LINE = z.number().int().min(1).max(6).describe("Limit line number, 1 to 6 (the 1000-series models have 1 to 4)");
const L = (n: number) => `:CALCulate:LLINe${n}`;
const TYPES = { upper: "UPPer", lower: "LOWer" } as const;
type TypeName = keyof typeof TYPES;

/** Tool-side guard, not an instrument limit (the manual gives none): keeps a command line short. */
const MAX_POINTS = 100;
/** The instrument sends no reply at all to DATA? on a line without points, so this wait is the "empty" signal. */
const DATA_TIMEOUT_MS = 1500;

/** How often, and how long apart, delete_limit_line re-reads the points while waiting for the delete to finish. */
const DELETE_CHECKS = 4;
const DELETE_CHECK_DELAY_MS = 300;

export interface LimitPoint {
  frequency_hz: number;
  amplitude_dbm: number;
  /** Whether this point is joined to the previous one by a line. The instrument always reports the first point as connected. */
  connected: boolean;
}

export interface LimitLineState {
  line: number;
  displayed: boolean;
  type: TypeName;
  /** Number of the trace the line is tested against. */
  trace: number;
  margin_db: number;
  margin_enabled: boolean;
  points: LimitPoint[];
}

function parseType(reply: string): TypeName {
  const text = reply.trim().toUpperCase();
  if (text === "UPPER" || text === "UPP") return "upper";
  if (text === "LOWER" || text === "LOW") return "lower";
  throw new Error(`Unexpected limit line type ${JSON.stringify(reply)}`);
}

function parsePoints(reply: string): LimitPoint[] {
  const values = parseNumberList(reply);
  if (values.length % 3 !== 0) {
    throw new Error(`Expected frequency,amplitude,connect triplets, got ${values.length} values`);
  }
  const points: LimitPoint[] = [];
  for (let i = 0; i < values.length; i += 3) {
    points.push({ frequency_hz: values[i], amplitude_dbm: values[i + 1], connected: values[i + 2] !== 0 });
  }
  return points;
}

/**
 * Read a line's points. The analyzer does not answer `DATA?` on a line without points (and posts no
 * error), so a timeout here is an empty line; callers must have just had other queries answered so a
 * dead connection is not mistaken for it.
 */
async function readPoints(n: number): Promise<LimitPoint[]> {
  const command = `${L(n)}:DATA?`;
  let reply: string;
  try {
    reply = await connection.query(command, DATA_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof Error && /^Query timeout after/.test(err.message)) return [];
    throw err;
  }
  try {
    return parsePoints(reply);
  } catch (err) {
    throw new ReplyError(command, reply, err instanceof Error ? err.message : String(err));
  }
}

async function readLine(n: number): Promise<LimitLineState> {
  const displayed = await queryBool(`${L(n)}:DISPlay?`);
  const type = await queryParsed(`${L(n)}:TYPE?`, parseType);
  const trace = await queryNumber(`${L(n)}:TRACe?`);
  const margin_db = await queryNumber(`${L(n)}:MARGin?`);
  const margin_enabled = await queryBool(`${L(n)}:MARGin:STATe?`);
  const points = await readPoints(n); // last: its silence on an empty line triggers the hold-off
  return { line: n, displayed, type, trace, margin_db, margin_enabled, points };
}

const POINT = z.object({
  frequency_hz: z.number().finite().min(0).describe("Frequency in Hz (>= 0)"),
  amplitude_dbm: z.number().finite().describe("Limit level in dBm"),
  connected: z.boolean().optional().describe("Join this point to the previous one (default true; ignored for the first point)"),
});

const SET_SHAPE = {
  line: LINE.default(1),
  displayed: z.boolean().optional().describe("Show the line on the display"),
  type: z.enum(["upper", "lower"]).optional().describe("upper: the trace must stay below the line; lower: above"),
  trace: z.number().int().min(1).max(6).optional().describe("Trace number (1-6) to test against the line"),
  margin_db: z.number().finite().optional().describe("Margin in dB, -40 to 40"),
  margin_enabled: z.boolean().optional().describe("Margin on/off"),
  points: z.array(POINT).optional().describe(`Replace the whole point list: 1 to ${MAX_POINTS} points in ascending frequency order (equal frequencies make a vertical step)`),
};
type SetArgs = { [K in keyof typeof SET_SHAPE]?: z.infer<(typeof SET_SHAPE)[K]> };

/** Returns an error message, or undefined when the arguments are valid. */
export function validateSet(a: SetArgs): string | undefined {
  const { line: _line, ...rest } = a;
  if (!Object.values(rest).some((v) => v !== undefined)) return "No parameters given; provide at least one setting.";
  if (a.margin_db !== undefined && (a.margin_db < -40 || a.margin_db > 40)) return "margin_db must be between -40 and 40.";
  if (a.points !== undefined) {
    const p = a.points;
    if (p.length < 1) return "points needs at least 1 point; use delete_limit_line to remove all points.";
    if (p.length > MAX_POINTS) return `points has ${p.length} entries; at most ${MAX_POINTS} are accepted.`;
    for (let i = 1; i < p.length; i++) {
      if (p[i].frequency_hz < p[i - 1].frequency_hz) {
        return `points must be in ascending frequency order (point ${i + 1} is below point ${i}).`;
      }
    }
  }
  return undefined;
}

const freqClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, 1e-8 * Math.abs(a));
const levelClose = (a: number, b: number) => Math.abs(a - b) <= 1e-4;

function pointsMatch(requested: LimitPoint[], actual: LimitPoint[]): boolean {
  return (
    requested.length === actual.length &&
    requested.every(
      (r, i) =>
        freqClose(r.frequency_hz, actual[i].frequency_hz) &&
        levelClose(r.amplitude_dbm, actual[i].amplitude_dbm) &&
        (i === 0 || r.connected === actual[i].connected)
    )
  );
}

export function registerLimitLineTools(server: McpServer): void {
  defineTool(
    server,
    "get_limit_line",
    "Read one limit line: whether it is displayed, its type (upper or lower), the trace it is tested against, the margin " +
      "and its on/off state, and the point list (frequency in Hz, level in dBm, connected). The analyzer documents no " +
      "pass/fail read-back, so whether a trace violates the line cannot be read; check the screenshot or compare get_trace_data with the points.",
    { line: LINE.default(1) },
    { readOnlyHint: true },
    async ({ line }) => {
      try {
        return textResult(JSON.stringify(await readLine(line), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_limit_line",
    "Create or edit a limit line. Give any of: displayed, type (upper/lower), trace, margin_db and margin_enabled, and points " +
      "(replaces the whole point list; 1 to 100 points in ascending frequency order, equal frequencies make a vertical step, each with frequency_hz, amplitude_dbm and optional connected). " +
      "The line is re-read afterwards; anything the instrument did not take is reported in 'warnings'.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        const n = a.line!;
        const commands: string[] = [];
        let requested: LimitPoint[] | undefined;
        if (a.points !== undefined) {
          requested = a.points.map((p, i) => ({
            frequency_hz: p.frequency_hz,
            amplitude_dbm: p.amplitude_dbm,
            connected: i === 0 ? true : p.connected ?? true,
          }));
          const flat = requested.map((p) => `${formatNumber(p.frequency_hz)},${formatNumber(p.amplitude_dbm)},${p.connected ? 1 : 0}`);
          commands.push(`${L(n)}:DATA ${flat.join(",")}`);
        }
        if (a.type !== undefined) commands.push(`${L(n)}:TYPE ${TYPES[a.type]}`);
        if (a.trace !== undefined) commands.push(`${L(n)}:TRACe ${a.trace}`);
        // Setting the margin switches its state on (verified), so the state goes second.
        if (a.margin_db !== undefined) commands.push(`${L(n)}:MARGin ${formatNumber(a.margin_db)}`);
        if (a.margin_enabled !== undefined) commands.push(`${L(n)}:MARGin:STATe ${a.margin_enabled ? 1 : 0}`);
        if (a.displayed !== undefined) commands.push(`${L(n)}:DISPlay ${a.displayed ? 1 : 0}`);

        await applyCommands(commands);

        const state = await readBack(() => readLine(n));
        const warnings: string[] = [];
        if (a.type !== undefined && a.type !== state.type) {
          warnings.push(`type adjusted by the instrument: requested ${a.type}, now ${state.type}`);
        }
        if (a.trace !== undefined && a.trace !== state.trace) {
          warnings.push(`trace adjusted by the instrument: requested ${a.trace}, now ${state.trace}`);
        }
        if (a.margin_db !== undefined && Math.abs(a.margin_db - state.margin_db) > 1e-6) {
          warnings.push(`margin_db adjusted by the instrument: requested ${a.margin_db}, now ${state.margin_db}`);
        }
        if (a.margin_enabled !== undefined && a.margin_enabled !== state.margin_enabled) {
          warnings.push(`margin_enabled adjusted by the instrument: requested ${a.margin_enabled}, now ${state.margin_enabled}`);
        }
        if (a.displayed !== undefined && a.displayed !== state.displayed) {
          warnings.push(`displayed adjusted by the instrument: requested ${a.displayed}, now ${state.displayed}`);
        }
        if (requested && !pointsMatch(requested, state.points)) {
          warnings.push(
            `points adjusted by the instrument: requested ${requested.length} points, now ${state.points.length}` +
              " (see state.points for what it holds)"
          );
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_limit_line");
      }
    },
    { validate: validateSet }
  );

  defineTool(
    server,
    "delete_limit_line",
    "Delete the points of one limit line (line) or of all limit lines (all: true). Type, trace and margin settings are left as they are. " +
      "The result confirms the line is empty (for all, line 1 is checked); the analyzer finishes a delete a moment after it is sent, so the tool waits for it.",
    {
      line: LINE.optional(),
      all: z.boolean().optional().describe("Delete every limit line instead of one"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async ({ line, all }) => {
      try {
        const warnings: string[] = [];
        const check = line ?? 1;
        await applyCommands([all ? ":CALCulate:LLINe:ALL:DELete" : `${L(line!)}:DELete`]);
        // The delete finishes after its *OPC? reply (verified: a DATA? right away still returns the old
        // points, and a late delete would erase points set in the next call), so wait until it shows.
        const left = await readBack(async () => {
          let points = await readPoints(check);
          for (let attempt = 1; attempt < DELETE_CHECKS && points.length > 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, DELETE_CHECK_DELAY_MS));
            points = await readPoints(check);
          }
          return points;
        });
        if (left.length > 0) warnings.push(`limit line ${check} still has ${left.length} points after the delete`);
        return textResult(JSON.stringify({ deleted: all ? "all" : [line], warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_limit_line");
      }
    },
    {
      validate: ({ line, all }) =>
        all === true && line !== undefined
          ? "Give either line or all, not both."
          : all !== true && line === undefined
            ? "Give line (1-6) or all: true."
            : undefined,
    }
  );
}
