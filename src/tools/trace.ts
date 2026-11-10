import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack } from "../instrument.js";
import { formatNumber, onOff } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md section 3 (trace) and ambiguities 8 and 9. Behavior verified on the
// UTS3036B (docs/verified-hardware.md): the per-trace queries :TRACe<n>:TYPE?, :UPDate:STATe? and
// :DISPlay:STATe? and the global :SENSe:AVERage:COUNt?/TYPE? answer; :CALCulate:MATH? does NOT (it stalls the
// instrument for ~2 s and posts -113), so trace math is write-only. Invalid values are rejected with -224 and
// leave the old value; the average count is rounded to an integer, 0 becomes 1 and 1000 is NOT clamped to 999.

const TRACES = [1, 2, 3, 4, 5, 6] as const;
const TRACE = z.number().int().min(1).max(6);

const TYPES = { write: "WRITe", average: "AVERage", max_hold: "MAXHold", min_hold: "MINHold" } as const;
type TypeName = keyof typeof TYPES;
const AVERAGE_TYPES = { voltage: "VOLTage", power: "POWEr", log: "LOG" } as const;
type AverageTypeName = keyof typeof AVERAGE_TYPES;
const MATH_OPS = {
  off: "OFF", power_difference: "PDIFference", power_sum: "PSUM", log_difference: "LDIFference", log_offset: "LOFFset",
} as const;

/** Map a reply (compared case-insensitively on the short form) back to our name; anything else is an error. */
function parseChoice<T extends string>(table: Record<T, string>, what: string) {
  return (reply: string): T => {
    const text = reply.trim().toUpperCase();
    for (const [name, raw] of Object.entries(table) as Array<[T, string]>) {
      if (text === raw.toUpperCase()) return name;
    }
    throw new Error(`Unexpected ${what} ${JSON.stringify(reply)}`);
  };
}
const parseType = parseChoice(TYPES, "trace type");
const parseAverageType = parseChoice(AVERAGE_TYPES, "average type");

export function parseTraceNumber(reply: string): number {
  const n = Number(reply.trim());
  if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error(`Unexpected trace number ${JSON.stringify(reply)}`);
  return n;
}

export interface TraceInfo {
  trace: number;
  type: TypeName;
  /** true = live update; false = view/hold (trace frozen). */
  update: boolean;
  display: boolean;
}

export async function readTrace(n: number): Promise<TraceInfo> {
  // Queries are serialized by the connection; read one at a time.
  const type = await queryParsed(`:TRACe${n}:TYPE?`, parseType);
  const update = await queryBool(`:TRACe${n}:UPDate:STATe?`);
  const display = await queryBool(`:TRACe${n}:DISPlay:STATe?`);
  return { trace: n, type, update, display };
}

async function readState(traces: readonly number[]) {
  const selected_trace = await queryParsed(":TRACe:SELect?", parseTraceNumber);
  const infos: TraceInfo[] = [];
  for (const n of traces) infos.push(await readTrace(n));
  const average_count = await queryNumber(":SENSe:AVERage:COUNt?");
  const average_type = await queryParsed(":SENSe:AVERage:TYPE?", parseAverageType);
  return { selected_trace, average_count, average_type, traces: infos };
}

const SET_SHAPE = {
  selected_trace: TRACE.optional().describe("Make this trace (1-6) the current trace (:TRACe:SELect)"),
  trace: TRACE.optional().describe("Trace (1-6) that type, update and display apply to"),
  type: z.enum(["write", "average", "max_hold", "min_hold"]).optional().describe("Trace type of `trace`: write (clear/write, live), average, max_hold or min_hold"),
  update: z.boolean().optional().describe("Update state of `trace`: true = live, false = view/hold (frozen)"),
  display: z.boolean().optional().describe("Show (true) or hide (false) `trace`"),
  average_count: z.number().finite().optional().describe("Average count, integer 1-999. Global: shared by every trace of type average"),
  average_type: z.enum(["voltage", "power", "log"]).optional().describe("Average type (global): voltage, power or log"),
};

export function registerTraceTools(server: McpServer): void {
  defineTool(
    server,
    "get_trace",
    "Get the trace configuration: the selected (current) trace, and for each trace 1-6 (or only `trace`) its type (write, average, max_hold, " +
      "min_hold), update state (true = live, false = view/hold) and display state, plus the global average count and average type. " +
      "Trace math cannot be read (the instrument has no query for it).",
    { trace: TRACE.optional().describe("Only this trace (1-6); all six when omitted") },
    { readOnlyHint: true },
    async ({ trace }) => {
      try {
        return textResult(JSON.stringify(await readState(trace !== undefined ? [trace] : TRACES), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_trace",
    "Set trace configuration: select the current trace, and for one trace set its type (write, average, max_hold, min_hold), update state " +
      "(live or view/hold) and display state, and set the global average count (1-999) and average type. Everything is re-read afterwards and anything " +
      "the instrument did not take is reported in 'warnings'. Changing a trace type or the averaging restarts that trace's hold/average. " +
      "To restart hold or averaging without changing settings use restart_trace.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const { selected_trace, trace, type, update, display, average_count, average_type } = args;

        const commands: string[] = [];
        if (selected_trace !== undefined) commands.push(`:TRACe:SELect ${selected_trace}`);
        if (trace !== undefined) {
          if (type !== undefined) commands.push(`:TRACe${trace}:TYPE ${TYPES[type]}`);
          if (update !== undefined) commands.push(`:TRACe${trace}:UPDate:STATe ${onOff(update)}`);
          if (display !== undefined) commands.push(`:TRACe${trace}:DISPlay:STATe ${onOff(display)}`);
        }
        // The average type goes before the count so the count is applied to the final type.
        if (average_type !== undefined) commands.push(`:SENSe:AVERage:TYPE ${AVERAGE_TYPES[average_type]}`);
        if (average_count !== undefined) commands.push(`:SENSe:AVERage:COUNt ${formatNumber(average_count)}`);

        await applyCommands(commands);

        const state = await readBack(() => readState(trace !== undefined ? [trace] : TRACES));
        const warnings: string[] = [];
        const check = (name: string, requested: unknown, actual: unknown) => {
          if (requested !== undefined && requested !== actual) {
            warnings.push(`${name} adjusted by the instrument: requested ${requested}, now ${actual}`);
          }
        };
        check("selected_trace", selected_trace, state.selected_trace);
        check("average_count", average_count, state.average_count);
        check("average_type", average_type, state.average_type);
        const info = state.traces[0];
        if (trace !== undefined && info) {
          check("type", type, info.type);
          check("update", update, info.update);
          check("display", display, info.display);
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_trace");
      }
    },
    { validate }
  );

  defineTool(
    server,
    "restart_trace",
    "Restart max hold, min hold or averaging by re-sending the trace's current type (:TRACe<n>:TYPE <current type>). Verified on the instrument: this clears " +
      "the accumulated hold/average and starts over, and so do changing the type or the update state; :INITiate:RESTart and :INITiate:IMMediate do NOT. " +
      "Without `trace` every trace that is in average, max_hold or min_hold is restarted; write traces need no restart.",
    { trace: TRACE.optional().describe("Only this trace (1-6); every hold/average trace when omitted") },
    { readOnlyHint: false },
    async ({ trace }) => {
      try {
        const targets: Array<{ trace: number; type: TypeName }> = [];
        for (const n of trace !== undefined ? [trace] : TRACES) {
          const type = await queryParsed(`:TRACe${n}:TYPE?`, parseType);
          if (trace !== undefined || type !== "write") targets.push({ trace: n, type });
        }
        if (targets.length === 0) {
          return textResult(JSON.stringify({
            restarted: [],
            warnings: ["Nothing to restart: no trace is in average, max_hold or min_hold type."],
          }, null, 2));
        }
        await applyCommands(targets.map((t) => `:TRACe${t.trace}:TYPE ${TYPES[t.type]}`));
        const warnings: string[] = [];
        for (const t of targets) {
          const now = await readBack(() => queryParsed(`:TRACe${t.trace}:TYPE?`, parseType));
          if (now !== t.type) warnings.push(`type adjusted by the instrument: requested ${t.type}, now ${now} (trace ${t.trace})`);
        }
        return textResult(JSON.stringify({ restarted: targets, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_trace");
      }
    }
  );

  defineTool(
    server,
    "set_trace_math",
    "Set trace math for a trace (:CALCulate:MATH): result trace <- operand_a (op) operand_b. Operations: off, power_difference, power_sum, " +
      "log_difference, log_offset; offset_db (-100..100) applies only to the two log operations. The instrument has no query for the math " +
      "setting, so it cannot be read back (check the trace data). Enabling math switches the trace on (update and display); turning it off does not switch it off again.",
    {
      trace: TRACE.describe("Trace (1-6) the operation is applied to"),
      operation: z.enum(["off", "power_difference", "power_sum", "log_difference", "log_offset"]).describe("Math operation"),
      operand_a: TRACE.optional().describe("Operand A trace (1-6); required unless operation is off"),
      operand_b: TRACE.optional().describe("Operand B trace (1-6); required unless operation is off"),
      offset_db: z.number().finite().min(-100).max(100).optional().describe("Offset in dB, only for log_difference and log_offset (default 0)"),
    },
    { readOnlyHint: false, idempotentHint: true },
    async ({ trace, operation, operand_a, operand_b, offset_db }) => {
      try {
        if (operation !== "off" && (operand_a === undefined || operand_b === undefined)) {
          return errorResult(`operand_a and operand_b (traces 1-6) are required for operation ${operation}.`);
        }
        if (offset_db !== undefined && operation !== "log_difference" && operation !== "log_offset") {
          return errorResult("offset_db only applies to the log_difference and log_offset operations.");
        }
        const a = operand_a ?? trace;
        const b = operand_b ?? trace;
        const command = `:CALCulate:MATH TRACE${trace},${MATH_OPS[operation]},TRACE${a},TRACE${b},${formatNumber(offset_db ?? 0)}`;
        await applyCommands([command]);
        // Verified live: enabling math on a trace switches that trace on (update and display), and "off" leaves it on.
        const trace_state = await readBack(() => readTrace(trace));
        return textResult(JSON.stringify({
          sent: command,
          trace_state,
          warnings: [
            "The instrument has no query for trace math; the setting was accepted without error but cannot be read back (check the trace data).",
            ...(operation !== "off" && (trace_state.update || trace_state.display)
              ? [`Trace ${trace} is now ${trace_state.display ? "displayed" : "hidden"} and ${trace_state.update ? "updating" : "held"}: enabling math switches the trace on, and turning math off does not switch it off again (use set_trace).`]
              : []),
          ],
        }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_trace");
      }
    }
  );
}

/** Returns an error message, or undefined when the combination is valid. */
function validate(a: z.infer<z.ZodObject<typeof SET_SHAPE>>): string | undefined {
  if (!Object.values(a).some((v) => v !== undefined)) return "No parameters given; provide at least one setting.";
  if (a.trace === undefined && (a.type !== undefined || a.update !== undefined || a.display !== undefined)) {
    return "type, update and display need `trace` (1-6) to say which trace they apply to.";
  }
  if (a.trace !== undefined && a.type === undefined && a.update === undefined && a.display === undefined) {
    return "`trace` was given without type, update or display; nothing to set for it.";
  }
  if (a.average_count !== undefined && (!Number.isInteger(a.average_count) || a.average_count < 1 || a.average_count > 999)) {
    return "average_count must be an integer from 1 to 999.";
  }
  return undefined;
}
