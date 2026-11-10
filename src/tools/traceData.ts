import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { SweepTimeoutError, startSweep, waitForSweepComplete } from "../acquisition.js";
import { ReplyError, applyCommands, checkInstrumentErrors, queryBool, queryNumber, queryParsed } from "../instrument.js";
import {
  decimateMinMax,
  frequencyAxis,
  parseAsciiTrace,
  parseBinaryTrace,
  summarizeTrace,
  timeAxis,
} from "../traceData.js";
import { parseTraceNumber, readTrace } from "./trace.js";
import { defineTool, errorResult, textResult } from "./util.js";

// Trace data: docs/programming-guide.md section 3, behavior verified on the UTS3036B (docs/verified-hardware.md,
// "Trace data"). `:TRACe:DATA? TRACE<n>` returns one value per sweep point (`:SENSe:SWEep:POINts?`), in the
// unit of `:UNIT:POWer?`. ASCII: comma-separated numbers, CRLF terminated. After `:FORMat REAL32|REAL64`: a
// `#4` block with a 4-digit byte length, big-endian IEEE 754, then CRLF. `:FORMat?` answers ASC8 but the
// setter wants ASCii, so the format that was found is mapped back to its setter form when restoring.

type DataFormat = "ascii" | "real32" | "real64";
type InstrumentFormat = "ASC8" | "REAL32" | "REAL64";
const FORMAT_SETTER: Record<InstrumentFormat, string> = { ASC8: "ASCii", REAL32: "REAL32", REAL64: "REAL64" };
const INSTRUMENT_FORMAT: Record<DataFormat, InstrumentFormat> = { ascii: "ASC8", real32: "REAL32", real64: "REAL64" };

/** The format reply; ASCII is ASC8 on this unit, the other spellings are accepted for other firmware. */
function parseInstrumentFormat(reply: string): InstrumentFormat {
  const text = reply.trim().toUpperCase();
  if (text === "ASC8" || text === "ASCII" || text === "ASC") return "ASC8";
  if (text === "REAL32" || text === "REAL64") return text;
  throw new Error(`Unexpected data format ${JSON.stringify(reply)} (expected ASC8, REAL32 or REAL64)`);
}

const UNITS = new Map([["DBM", "dBm"], ["DBMV", "dBmV"], ["DBUV", "dBuV"], ["V", "V"], ["W", "W"]]);
function parseUnit(reply: string): string {
  const unit = UNITS.get(reply.trim().toUpperCase());
  if (unit === undefined) throw new Error(`Unexpected power unit ${JSON.stringify(reply)}`);
  return unit;
}

const DATA_TIMEOUT_MS = 15_000;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Add the command to a transport error that does not name it (the block reader's "Expected a binary block reply"). */
function naming(command: string, err: unknown): Error {
  const text = message(err);
  return err instanceof ReplyError || text.includes(command) ? (err as Error) : new Error(`${text} (reply to ${command})`);
}

/**
 * Run `fn` with the instrument in `wanted` data format and put the format back as it was found, in a finally
 * that also runs when `fn` or the switch fails. If the restore fails, the error says so explicitly.
 */
async function withDataFormat<T>(wanted: DataFormat, fn: () => Promise<T>): Promise<T> {
  const found = await queryParsed(":FORMat?", parseInstrumentFormat);
  const target = INSTRUMENT_FORMAT[wanted];
  if (found === target) return fn();

  let primary: unknown;
  let failed = false;
  let value: T | undefined;
  try {
    await applyCommands([`:FORMat ${FORMAT_SETTER[target]}`]);
    value = await fn();
  } catch (err) {
    primary = err;
    failed = true;
  }
  // Nothing can have been changed when the connection was never there.
  if (!(failed && primary instanceof Error && /^Not connected/.test(primary.message))) {
    try {
      await applyCommands([`:FORMat ${FORMAT_SETTER[found]}`]);
    } catch (restoreErr) {
      throw new Error(
        (failed ? `${message(primary)}. ` : "") +
          `Could not restore the data format with :FORMat ${FORMAT_SETTER[found]}: ${message(restoreErr)}. ` +
          `The instrument may still be in ${target} format; send :FORMat ${FORMAT_SETTER[found]} with scpi_command ` +
          "(the query answers ASC8 but the setter needs ASCii)."
      );
    }
  }
  if (failed) throw primary;
  return value as T;
}

async function readValues(command: string, format: DataFormat): Promise<number[]> {
  if (format === "ascii") {
    const reply = await connection.query(command, DATA_TIMEOUT_MS);
    return parseAsciiTrace(command, reply);
  }
  let payload: Buffer;
  try {
    payload = await connection.queryBinary(command, DATA_TIMEOUT_MS);
  } catch (err) {
    throw naming(command, err);
  }
  return parseBinaryTrace(command, payload, format === "real32" ? 4 : 8);
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));
/** REAL32 carries about 7 significant digits; widening to a double would show float noise (-64.63521575927734). */
const clean = (value: number, format: DataFormat) => (!Number.isFinite(value) ? null : format === "real32" ? Number(value.toPrecision(7)) : value);

interface Fresh {
  swept: true;
  sweep_time_s: number;
  waited_ms: number;
  continuous_restored: boolean;
}

export function registerTraceDataTools(server: McpServer): void {
  defineTool(
    server,
    "get_trace_data",
    "Read the amplitude values of one trace (1-6, default the selected trace) with the computed frequency axis, the power unit, the trace type and " +
      "summary statistics (min, max, mean, peak level and peak frequency). The axis is linear from :FREQuency:STARt? to :FREQuency:STOP? over " +
      ":SENSe:SWEep:POINts? points (zero span has no frequency axis: a time axis from 0 to the sweep time is returned and the result says so). " +
      "`format` is real32 (default, binary, exact to float precision, about 4 KB) or ascii (about 14 KB) or real64; the instrument's data format is switched for the read and always put " +
      "back. `fresh` runs one single sweep first so the data is a complete, current sweep (continuous mode is switched back on afterwards); without it " +
      "the values are whatever the trace currently holds, which in continuous mode can be mid-sweep. `max_points` (>= 2) reduces the response by peak-preserving " +
      "min/max decimation and the result says so with the original count; the statistics always use the full trace. `include_axis` (default true) adds the per-point axis.",
    {
      trace: z.number().int().min(1).max(6).optional().describe("Trace 1-6; default the selected trace (:TRACe:SELect?)"),
      format: z.enum(["ascii", "real32", "real64"]).optional().describe("Transfer format (default real32). The instrument's :FORMat is restored afterwards"),
      fresh: z.boolean().optional().describe("Run a single sweep first and read the finished trace; restores continuous mode if it was on (default false)"),
      max_points: z.number().int().min(2).optional().describe("Return at most this many points using peak-preserving min/max decimation (default: all points)"),
      include_axis: z.boolean().optional().describe("Include the per-point frequency (or time) axis (default true)"),
    },
    { readOnlyHint: true },
    async (args) => {
      const fresh = args.fresh ?? false;
      const format: DataFormat = args.format ?? "real32";
      let continuousWas = false;
      let modeTouched = false;
      let freshInfo: Fresh | undefined;
      let result: Record<string, unknown> | undefined;
      let primary: unknown;
      let failed = false;

      try {
        if (fresh) {
          continuousWas = await queryBool(":INITiate:CONTinuous?");
          modeTouched = true; // set before the send: a failure mid-send may already have switched the mode
          await applyCommands([":INITiate:CONTinuous OFF"]);
          const { sweepTimeS } = await startSweep("immediate");
          const { waitedMs } = await waitForSweepComplete();
          await checkInstrumentErrors([":INITiate:CONTinuous OFF", ":INITiate:IMMediate"]);
          freshInfo = { swept: true, sweep_time_s: sweepTimeS, waited_ms: waitedMs, continuous_restored: false };
        }
        result = await collect(args.trace, format, args.max_points, args.include_axis ?? true);
      } catch (err) {
        failed = true;
        primary = err instanceof SweepTimeoutError
          ? new Error(`${err.message}. The instrument may still be sweeping (for example waiting for a trigger); check get_sweep.`)
          : err;
      }

      // Put continuous mode back (also after a failure): it was on when we started.
      let restoreFailure: string | undefined;
      const neverSent = failed && primary instanceof Error && /^Not connected/.test(primary.message);
      if (fresh && modeTouched && continuousWas && !neverSent) {
        try {
          await applyCommands([":INITiate:CONTinuous ON"]);
          if (freshInfo) freshInfo.continuous_restored = true;
        } catch (err) {
          restoreFailure =
            `Could not restore continuous sweep mode (:INITiate:CONTinuous ON): ${message(err)}. ` +
            "The instrument may still be in single sweep mode; use set_acquisition continuous=true.";
        }
      }

      if (restoreFailure !== undefined) return errorResult(failed ? `${message(primary)}. ${restoreFailure}` : restoreFailure);
      if (failed) return errorResult(primary);
      const out = { ...result, ...(freshInfo ? { fresh: freshInfo } : {}) };
      return textResult(JSON.stringify(out));
    }
  );
}

/** Read the settings, the trace and its data, and build the result. */
async function collect(
  requestedTrace: number | undefined,
  format: DataFormat,
  maxPoints: number | undefined,
  includeAxis: boolean
): Promise<Record<string, unknown>> {
  const sweepPoints = await queryNumber(":SENSe:SWEep:POINts?");
  if (!Number.isInteger(sweepPoints) || sweepPoints < 1) {
    throw new ReplyError(":SENSe:SWEep:POINts?", String(sweepPoints), "expected a whole number of sweep points >= 1");
  }
  const startHz = await queryNumber(":FREQuency:STARt?");
  const stopHz = await queryNumber(":FREQuency:STOP?");
  const unit = await queryParsed(":UNIT:POWer?", parseUnit);
  const trace = requestedTrace ?? (await queryParsed(":TRACe:SELect?", parseTraceNumber));
  const info = await readTrace(trace);
  if (stopHz < startHz) {
    throw new Error(`The instrument reports a stop frequency (${stopHz} Hz) below the start frequency (${startHz} Hz); cannot build the frequency axis.`);
  }
  const zeroSpan = stopHz === startHz;
  const sweepTimeS = zeroSpan ? await queryNumber(":SENSe:SWEep:TIME?") : undefined;

  const command = `:TRACe:DATA? TRACE${trace}`;
  const raw = await withDataFormat(format, () => readValues(command, format));
  if (raw.length !== sweepPoints) {
    throw new Error(
      `The reply to ${command} holds ${raw.length} values but :SENSe:SWEep:POINts? says ${sweepPoints}; ` +
        "the trace and the sweep points disagree (did the sweep points change during the read?), so no axis can be assigned. Read again."
    );
  }

  const warnings: string[] = [];
  const summary = summarizeTrace(raw);
  if (summary === null) throw new Error(`The reply to ${command} holds no finite value (${raw.length} values, all NaN or infinite).`);
  if (summary.non_finite_points > 0) {
    warnings.push(`${summary.non_finite_points} of ${raw.length} values are not a finite number (NaN or infinite); they are null in values and left out of the statistics.`);
  }
  if (!info.update) warnings.push(`Trace ${trace} is frozen (view/hold): the data is from when it was last updated, not a new sweep.`);
  if (!info.display) warnings.push(`Trace ${trace} is hidden (not displayed); it may not hold current data.`);

  const axisValues = zeroSpan ? timeAxis(sweepTimeS as number, sweepPoints) : frequencyAxis(startHz, stopHz, sweepPoints);
  const axis = zeroSpan
    ? {
        kind: "time",
        zero_span: true,
        center_hz: startHz,
        sweep_time_s: sweepTimeS,
        points: sweepPoints,
        note: "Zero span: the analyzer sits on one frequency, so there is no frequency axis. times_s runs linearly from 0 to the sweep time over the points (assumes the trace covers one sweep time).",
      }
    : {
        kind: "frequency",
        start_hz: startHz,
        stop_hz: stopHz,
        span_hz: stopHz - startHz,
        step_hz: sweepPoints > 1 ? round((stopHz - startHz) / (sweepPoints - 1), 6) : 0,
        points: sweepPoints,
      };
  if (zeroSpan) warnings.push("Zero span: no frequency axis; times_s is a time axis from 0 to the sweep time and the peak is given as peak_time_s.");

  const peak = summary.peak_index;
  const summaryOut: Record<string, unknown> = {
    points: summary.points,
    finite_points: summary.finite_points,
    non_finite_points: summary.non_finite_points,
    min: clean(summary.min, format),
    max: clean(summary.max, format),
    mean: round(summary.mean, 6),
    peak_index: peak,
    peak_level: clean(summary.max, format),
    ...(zeroSpan ? { peak_time_s: axisValues[peak] } : { peak_frequency_hz: round(axisValues[peak], 3) }),
  };

  let indices: number[] | undefined;
  let values: number[] = raw;
  let decimation: Record<string, unknown> = { decimated: false };
  if (maxPoints !== undefined && raw.length > maxPoints) {
    const d = decimateMinMax(raw, maxPoints);
    indices = d.indices;
    values = d.values;
    decimation = {
      decimated: true,
      original_points: raw.length,
      returned_points: values.length,
      max_points: maxPoints,
      method: "peak-preserving min/max decimation: the trace is split into equal buckets and the minimum and maximum of each bucket are kept, in order; indices gives each returned point's index in the full trace",
    };
    warnings.push(`Decimated from ${raw.length} to ${values.length} points (max_points ${maxPoints}); the statistics use all ${raw.length} points.`);
  }

  const axisOut = indices ? indices.map((i) => axisValues[i]) : axisValues;
  const base = {
    trace,
    trace_type: info.type,
    trace_updating: info.update,
    trace_displayed: info.display,
    unit,
    format,
    points: sweepPoints,
    axis,
    summary: summaryOut,
    decimation,
    warnings,
    ...(indices ? { indices } : {}),
    values: values.map((v) => clean(v, format)),
  };
  if (!includeAxis) return base;
  return zeroSpan ? { ...base, times_s: axisOut } : { ...base, frequencies_hz: axisOut.map((f) => round(f, 3)) };
}
