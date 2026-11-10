import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, readBack } from "../instrument.js";
import { formatWithUnit } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md section 2 (frequency). Query forms and the
// "Hz" suffix were verified on the UTS3036B (docs/verified-hardware.md).

export interface FrequencyState {
  center_hz: number;
  span_hz: number;
  start_hz: number;
  stop_hz: number;
  center_step_hz: number;
  center_step_auto: boolean;
  offset_hz: number;
}

async function readFrequencyState(): Promise<FrequencyState> {
  // Queries are serialized by the connection; read one at a time.
  const center_hz = await queryNumber(":FREQuency:CENTer?");
  const span_hz = await queryNumber(":FREQuency:SPAN?");
  const start_hz = await queryNumber(":FREQuency:STARt?");
  const stop_hz = await queryNumber(":FREQuency:STOP?");
  const center_step_hz = await queryNumber(":FREQuency:CENTer:STEP?");
  const center_step_auto = await queryBool(":FREQuency:CENTer:STEP:AUTO?");
  const offset_hz = await queryNumber(":FREQuency:OFFSet?");
  return { center_hz, span_hz, start_hz, stop_hz, center_step_hz, center_step_auto, offset_hz };
}

const hz = (description: string) => z.number().finite().optional().describe(description);

const SET_SHAPE = {
  center_hz: hz("Center frequency in Hz (> 0)"),
  span_hz: hz("Span in Hz (> 0; use zero_span for zero span)"),
  start_hz: hz("Start frequency in Hz (>= 0)"),
  stop_hz: hz("Stop frequency in Hz (> 0)"),
  full_span: z.boolean().optional().describe("Set the full span. Cannot be combined with center/span/start/stop"),
  zero_span: z.boolean().optional().describe("Set zero span (time domain). Cannot be combined with center/span/start/stop"),
  center_step_hz: hz("Center frequency step in Hz (> 0); turns the automatic step off"),
  center_step_auto: z.boolean().optional().describe("Automatic center frequency step on/off"),
  offset_hz: hz("Frequency offset in Hz"),
};

type SetArgs = {
  [K in keyof typeof SET_SHAPE]?: z.infer<(typeof SET_SHAPE)[K]>;
};

/** Returns an error message, or undefined when the combination is valid. */
function validate(a: SetArgs): string | undefined {
  const given = Object.values(a).some((v) => v !== undefined);
  if (!given) return "No parameters given; provide at least one setting.";

  if (a.center_hz !== undefined && !(a.center_hz > 0)) return "center_hz must be > 0.";
  if (a.span_hz !== undefined && !(a.span_hz > 0)) {
    return "span_hz must be > 0 (use zero_span for zero span).";
  }
  if (a.start_hz !== undefined && !(a.start_hz >= 0)) return "start_hz must be >= 0.";
  if (a.stop_hz !== undefined && !(a.stop_hz > 0)) return "stop_hz must be > 0.";
  if (a.center_step_hz !== undefined && !(a.center_step_hz > 0)) return "center_step_hz must be > 0.";
  if (a.start_hz !== undefined && a.stop_hz !== undefined && !(a.start_hz < a.stop_hz)) {
    return "start_hz must be less than stop_hz.";
  }

  const centerSpan = a.center_hz !== undefined || a.span_hz !== undefined;
  const startStop = a.start_hz !== undefined || a.stop_hz !== undefined;
  if (centerSpan && startStop) {
    return "Use either center/span or start/stop in one call, not both (they are coupled).";
  }
  if (a.full_span && a.zero_span) return "full_span and zero_span cannot be combined.";
  if ((a.full_span || a.zero_span) && (centerSpan || startStop)) {
    return "full_span/zero_span cannot be combined with center/span/start/stop.";
  }
  if (a.center_step_hz !== undefined && a.center_step_auto === true) {
    return "center_step_hz and center_step_auto=true conflict.";
  }
  return undefined;
}

function close(requested: number, actual: number): boolean {
  return Math.abs(requested - actual) <= Math.max(1, 1e-6 * Math.abs(requested));
}

export function registerFrequencyTools(server: McpServer): void {
  defineTool(
    server,
    "get_frequency",
    "Get the analyzer's frequency settings: center, span, start, stop, center step (and whether it is automatic) and offset, all in Hz.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readFrequencyState(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_frequency",
    "Set frequency parameters (all in Hz). Give center and/or span, OR start and/or stop, OR full_span, OR zero_span; " +
      "center step and offset can be combined with any of these. Frequency parameters are coupled, so the settings are re-read " +
      "afterwards; values the instrument changed are reported in 'warnings'.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const commands: string[] = [];
        if (args.full_span) commands.push(":FREQuency:SPAN:FULL");
        if (args.zero_span) commands.push(":FREQuency:SPAN:ZERO");

        if (args.span_hz !== undefined) commands.push(`:FREQuency:SPAN ${formatWithUnit(args.span_hz, "Hz")}`);
        if (args.center_hz !== undefined) commands.push(`:FREQuency:CENTer ${formatWithUnit(args.center_hz, "Hz")}`);

        if (args.start_hz !== undefined && args.stop_hz !== undefined) {
          // Move the edge that will not cross the other one first.
          const currentStop = await queryNumber(":FREQuency:STOP?");
          const start = `:FREQuency:STARt ${formatWithUnit(args.start_hz, "Hz")}`;
          const stop = `:FREQuency:STOP ${formatWithUnit(args.stop_hz, "Hz")}`;
          commands.push(...(args.start_hz >= currentStop ? [stop, start] : [start, stop]));
        } else if (args.start_hz !== undefined) {
          commands.push(`:FREQuency:STARt ${formatWithUnit(args.start_hz, "Hz")}`);
        } else if (args.stop_hz !== undefined) {
          commands.push(`:FREQuency:STOP ${formatWithUnit(args.stop_hz, "Hz")}`);
        }

        if (args.center_step_hz !== undefined) {
          commands.push(`:FREQuency:CENTer:STEP ${formatWithUnit(args.center_step_hz, "Hz")}`);
        }
        if (args.center_step_auto !== undefined) {
          commands.push(`:FREQuency:CENTer:STEP:AUTO ${args.center_step_auto ? "ON" : "OFF"}`);
        }
        if (args.offset_hz !== undefined) commands.push(`:FREQuency:OFFSet ${formatWithUnit(args.offset_hz, "Hz")}`);

        await applyCommands(commands);

        const state = await readBack(readFrequencyState);
        const checks: Array<[string, number | undefined, number]> = [
          ["center_hz", args.center_hz, state.center_hz],
          ["span_hz", args.span_hz, state.span_hz],
          ["start_hz", args.start_hz, state.start_hz],
          ["stop_hz", args.stop_hz, state.stop_hz],
          ["center_step_hz", args.center_step_hz, state.center_step_hz],
          ["offset_hz", args.offset_hz, state.offset_hz],
        ];
        if (args.zero_span) checks.push(["span_hz", 0, state.span_hz]);
        const warnings = checks
          .filter(([, requested, actual]) => requested !== undefined && !close(requested, actual))
          .map(
            ([name, requested, actual]) =>
              `${name} adjusted by the instrument: requested ${requested} Hz, now ${actual} Hz`
          );
        if (args.center_step_auto !== undefined && args.center_step_auto !== state.center_step_auto) {
          warnings.push(
            `center_step_auto adjusted by the instrument: requested ${args.center_step_auto}, now ${state.center_step_auto}`
          );
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_frequency");
      }
    },
    { validate }
  );
}
