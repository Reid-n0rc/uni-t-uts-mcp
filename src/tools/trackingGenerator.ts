import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, readBack } from "../instrument.js";
import { formatNumber, onOff } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md section 6 (the manual calls the tracking generator the "trace source",
// 3K p.50, p.39, p.93). Ranges, clamping and the reference-trace and bandwidth quirks were measured on the
// UTS3036B (docs/verified-hardware.md, "Tracking generator").

const OUT = ":OUTPut:STATe";
const LEVEL = ":SOURce:POWer";
const OFFSET = ":SOURce:CORRection:OFFSet";
const REF = ":SOURce:TRACe:REFerence:STATe";
const NT = ":CALCulate:NTData:STATe";
const NRL = ":DISPlay:WINDow:TRACe:Y:SCALe:NRLevel";
const RBW_AUTO = ":SENSe:BANDwidth:RESolution:AUTO";
const VBW_AUTO = ":SENSe:BANDwidth:VIDeo:AUTO";
const RBW = ":SENSe:BANDwidth:RESolution";

/** Pause between the output going off and re-asserting the automatic bandwidths (measured: re-asserting at once is overtaken). */
const SETTLE_MS = 600;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Output level range the UTS3036B accepts (it clamps silently outside it). */
const LEVEL_MIN = -40;
const LEVEL_MAX = 0;

export interface TrackingGeneratorState {
  enabled: boolean;
  level_dbm: number;
  level_offset_db: number;
  reference_trace: boolean;
  normalize: boolean;
  normalize_ref_level_db: number;
}

const ABSENT_HINT =
  "The instrument gave no answer to the tracking generator query; this analyzer probably does not have the tracking generator option " +
  "(or the link is unreliable). Nothing was changed.";

/** The first query doubles as the presence check: an analyzer without the option leaves it unanswered. */
async function readEnabled(): Promise<boolean> {
  try {
    return await queryBool(`${OUT}?`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|timed out/i.test(message)) {
      throw new Error(`${message}. ${ABSENT_HINT}`);
    }
    throw err;
  }
}

async function readState(): Promise<TrackingGeneratorState> {
  const enabled = await readEnabled();
  const level_dbm = await queryNumber(`${LEVEL}?`);
  const level_offset_db = await queryNumber(`${OFFSET}?`);
  const reference_trace = await queryBool(`${REF}?`);
  const normalize = await queryBool(`${NT}?`);
  const normalize_ref_level_db = await queryNumber(`${NRL}?`);
  return { enabled, level_dbm, level_offset_db, reference_trace, normalize, normalize_ref_level_db };
}

function close(requested: number, actual: number): boolean {
  return Math.abs(requested - actual) <= Math.max(1e-6, 1e-6 * Math.abs(requested));
}

const SET_SHAPE = {
  enabled: z.boolean().optional().describe("Tracking generator output on or off"),
  level_dbm: z.number().finite().optional().describe(`Output level in dBm (${LEVEL_MIN} to ${LEVEL_MAX} on the UTS3036B)`),
  level_offset_db: z.number().finite().optional().describe("Output level offset in dB (-200 to 200)"),
  reference_trace: z.boolean().optional().describe("Reference trace on or off (only takes while the output is on)"),
  normalize: z.boolean().optional().describe("Normalization on or off"),
  normalize_ref_level_db: z.number().finite().optional().describe("Normalization reference level in dB (-100 to 100)"),
};

type SetArgs = { [K in keyof typeof SET_SHAPE]?: z.infer<(typeof SET_SHAPE)[K]> };

function validate(a: SetArgs): string | undefined {
  if (!Object.values(a).some((v) => v !== undefined)) return "No parameters given; provide at least one setting.";
  if (a.level_dbm !== undefined && !(a.level_dbm >= LEVEL_MIN && a.level_dbm <= LEVEL_MAX)) {
    return `level_dbm must be between ${LEVEL_MIN} and ${LEVEL_MAX} dBm.`;
  }
  if (a.level_offset_db !== undefined && !(a.level_offset_db >= -200 && a.level_offset_db <= 200)) {
    return "level_offset_db must be between -200 and 200 dB.";
  }
  if (a.normalize_ref_level_db !== undefined && !(a.normalize_ref_level_db >= -100 && a.normalize_ref_level_db <= 100)) {
    return "normalize_ref_level_db must be between -100 and 100 dB.";
  }
  return undefined;
}

export function registerTrackingGeneratorTools(server: McpServer): void {
  defineTool(
    server,
    "get_tracking_generator",
    "Get the tracking generator (the manual's 'trace source') state: output on/off, output level in dBm, level offset in dB, " +
      "reference trace, normalization on/off and its reference level in dB. An error naming the query means the option is probably not installed.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readState(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  defineTool(
    server,
    "set_tracking_generator",
    "Set the tracking generator (trace source): output on/off, level (dBm), level offset (dB), reference trace, normalization and its reference level. " +
      "Level and offset are set before the output is switched on. The output is wired to the analyzer input on some benches, so switch it off when done: " +
      "switching it off also re-asserts automatic RBW/VBW that were on (the instrument otherwise keeps a stale 300 kHz RBW). " +
      "Values the instrument changed are reported in 'warnings'.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        // Presence check: nothing is sent to an analyzer without the option.
        await readEnabled();
        let reassertRbw = false;
        let reassertVbw = false;
        let rbwBefore = 0;
        if (a.enabled === false) {
          reassertRbw = await queryBool(`${RBW_AUTO}?`);
          reassertVbw = await queryBool(`${VBW_AUTO}?`);
          if (reassertRbw) rbwBefore = await queryNumber(`${RBW}?`);
        }

        const commands: string[] = [];
        if (a.level_dbm !== undefined) commands.push(`${LEVEL} ${formatNumber(a.level_dbm)}`);
        if (a.level_offset_db !== undefined) commands.push(`${OFFSET} ${formatNumber(a.level_offset_db)}`);
        if (a.enabled === true) commands.push(`${OUT} ${onOff(true)}`);
        if (a.reference_trace !== undefined) commands.push(`${REF} ${onOff(a.reference_trace)}`);
        if (a.normalize_ref_level_db !== undefined) commands.push(`${NRL} ${formatNumber(a.normalize_ref_level_db)}`);
        if (a.normalize !== undefined) commands.push(`${NT} ${onOff(a.normalize)}`);
        if (a.enabled === false) commands.push(`${OUT} ${onOff(false)}`);
        await applyCommands(commands);

        const warnings: string[] = [];
        if (a.enabled === false && (reassertRbw || reassertVbw)) {
          // Quirk: shortly after the output goes off the automatic RBW drops to 300 kHz and stays there (both auto flags still
          // read 1) until auto is sent again; sent at once, the command is overtaken by the drop. So wait, then re-assert.
          const reassert = [...(reassertRbw ? [`${RBW_AUTO} ON`] : []), ...(reassertVbw ? [`${VBW_AUTO} ON`] : [])];
          await sleep(SETTLE_MS);
          await applyCommands(reassert);
          if (reassertRbw) {
            let rbw = await readBack(() => queryNumber(`${RBW}?`));
            if (!close(rbwBefore, rbw)) {
              await sleep(SETTLE_MS * 2);
              await applyCommands(reassert);
              rbw = await readBack(() => queryNumber(`${RBW}?`));
            }
            if (!close(rbwBefore, rbw)) {
              warnings.push(`RBW did not return to ${rbwBefore} Hz after the output was switched off (now ${rbw} Hz); set it with set_bandwidth`);
            }
          }
        }

        const state = await readBack(readState);
        const numeric: Array<[keyof TrackingGeneratorState, number | undefined, string]> = [
          ["level_dbm", a.level_dbm, "dBm"],
          ["level_offset_db", a.level_offset_db, "dB"],
          ["normalize_ref_level_db", a.normalize_ref_level_db, "dB"],
        ];
        for (const [name, requested, unit] of numeric) {
          const actual = state[name] as number;
          if (requested !== undefined && !close(requested, actual)) {
            warnings.push(`${name} adjusted by the instrument: requested ${requested} ${unit}, now ${actual} ${unit}`);
          }
        }
        for (const name of ["enabled", "reference_trace", "normalize"] as const) {
          const requested = a[name];
          if (requested !== undefined && requested !== state[name]) {
            warnings.push(
              `${name} adjusted by the instrument: requested ${requested}, now ${state[name]}` +
                (name === "reference_trace" && requested && !state.enabled ? " (the reference trace only takes while the tracking generator output is on)" : "")
            );
          }
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_tracking_generator");
      }
    },
    { validate }
  );
}
