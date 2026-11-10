import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { InstrumentError, applyCommands } from "../instrument.js";
import { formatNumber, onOff, parseBool, parseNumber } from "../scpi.js";
import { errorResult, textResult } from "./util.js";

// Commands: docs/programming-guide.md section 2 (amplitude). Behavior verified on the
// UTS3036B (docs/verified-hardware.md): setters take bare numbers (a unit suffix is also
// accepted), out-of-range values are clamped silently, and the reference level reads back
// in the current power unit.

const UNITS = { dBm: "DBM", dBmV: "DBMV", dBuV: "DBUV", V: "V", W: "W" } as const;
type UnitName = keyof typeof UNITS;
const UNIT_BY_REPLY = new Map<string, UnitName>(
  (Object.entries(UNITS) as Array<[UnitName, string]>).map(([name, raw]) => [raw, name])
);

const SCALE_TYPES = { logarithmic: "LOGarithmic", linear: "LINear" } as const;
type ScaleType = keyof typeof SCALE_TYPES;

const Y = ":DISPlay:WINDow:TRACe:Y";
// :INPut:IMPedance gives no reply and its setter is undefined on this firmware; the alias works.
const IMPEDANCE = ":SENSe:CORRection:IMPedance:INPut:MAGNitude";

export interface AmplitudeState {
  /** In the current power unit (`power_unit`). */
  reference_level: number;
  power_unit: UnitName;
  scale_per_div_db: number;
  scale_type: ScaleType;
  reference_level_offset_db: number;
  attenuation_db: number;
  attenuation_auto: boolean;
  preamp: boolean;
  input_impedance_ohm: number;
}

function parseUnit(reply: string): UnitName {
  const unit = UNIT_BY_REPLY.get(reply.trim().toUpperCase());
  if (!unit) throw new Error(`Unexpected power unit ${JSON.stringify(reply)}`);
  return unit;
}

function parseScaleType(reply: string): ScaleType {
  const text = reply.trim().toUpperCase();
  if (text.startsWith("LOG")) return "logarithmic";
  if (text.startsWith("LIN")) return "linear";
  throw new Error(`Unexpected scale type ${JSON.stringify(reply)}`);
}

async function readAmplitudeState(): Promise<AmplitudeState> {
  // Queries are serialized by the connection; read one at a time.
  const reference_level = parseNumber(await connection.query(`${Y}:RLEVel?`));
  const scale_per_div_db = parseNumber(await connection.query(`${Y}:PDIVision?`));
  const scale_type = parseScaleType(await connection.query(`${Y}:SPACing?`));
  const reference_level_offset_db = parseNumber(await connection.query(`${Y}:RLEVel:OFFSet?`));
  const power_unit = parseUnit(await connection.query(":UNIT:POWer?"));
  const attenuation_db = parseNumber(await connection.query(":POWer:ATTenuation?"));
  const attenuation_auto = parseBool(await connection.query(":POWer:ATTenuation:AUTO?"));
  const preamp = parseBool(await connection.query(":POWer:GAIN:STATe?"));
  const input_impedance_ohm = parseNumber(await connection.query(`${IMPEDANCE}?`));
  return {
    reference_level, power_unit, scale_per_div_db, scale_type, reference_level_offset_db,
    attenuation_db, attenuation_auto, preamp, input_impedance_ohm,
  };
}

const SET_SHAPE = {
  reference_level: z.number().finite().optional().describe(
    "Reference level in the power unit in effect after this call (power_unit if given, otherwise the current unit). " +
      "In dBm the instrument accepts -100 to 30; other values are clamped"
  ),
  power_unit: z.enum(["dBm", "dBmV", "dBuV", "V", "W"]).optional().describe("Power unit; set before the reference level"),
  scale_per_div_db: z.number().finite().optional().describe("Scale per division in dB (0.1 to 20)"),
  scale_type: z.enum(["logarithmic", "linear"]).optional().describe("Y scale type"),
  reference_level_offset_db: z.number().finite().optional().describe("Reference level offset in dB (clamped to +-327.6)"),
  attenuation_db: z.number().finite().optional().describe("Manual input attenuation, integer dB 0 to 51; turns automatic attenuation off"),
  attenuation_auto: z.boolean().optional().describe("Automatic attenuation on/off (not with attenuation_db)"),
  preamp: z.boolean().optional().describe("Preamplifier on/off"),
  input_impedance_ohm: z.union([z.literal(50), z.literal(75)]).optional().describe("Input impedance in ohms (50 or 75; 75 is a correction for a 75 ohm source)"),
};

type SetArgs = {
  [K in keyof typeof SET_SHAPE]?: z.infer<(typeof SET_SHAPE)[K]>;
};

/** Returns an error message, or undefined when the combination is valid. */
function validate(a: SetArgs): string | undefined {
  if (!Object.values(a).some((v) => v !== undefined)) return "No parameters given; provide at least one setting.";
  if (a.scale_per_div_db !== undefined && !(a.scale_per_div_db >= 0.1 && a.scale_per_div_db <= 20)) {
    return "scale_per_div_db must be between 0.1 and 20.";
  }
  if (a.attenuation_db !== undefined) {
    if (!Number.isInteger(a.attenuation_db) || a.attenuation_db < 0 || a.attenuation_db > 51) {
      return "attenuation_db must be an integer from 0 to 51.";
    }
    if (a.attenuation_auto === true) return "attenuation_db and attenuation_auto=true conflict.";
  }
  return undefined;
}

function close(requested: number, actual: number): boolean {
  // Readbacks carry six significant digits.
  return Math.abs(requested - actual) <= Math.max(1e-9, 1e-5 * Math.abs(requested));
}

export function registerAmplitudeTools(server: McpServer): void {
  server.tool(
    "get_amplitude",
    "Get the analyzer's amplitude settings: reference level (in the current power unit), power unit, scale per division (dB), " +
      "Y scale type, reference level offset (dB), input attenuation (dB) and whether it is automatic, preamp state and input impedance (ohms).",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        return textResult(JSON.stringify(await readAmplitudeState(), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "set_amplitude",
    "Set amplitude parameters. The power unit is applied first, so reference_level is interpreted in the new unit. Manual attenuation_db turns " +
      "automatic attenuation off. Out-of-range values are clamped by the instrument; the settings are re-read afterwards and anything it " +
      "changed is reported in 'warnings'.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const problem = validate(args);
        if (problem) return errorResult(problem);

        const commands: string[] = [];
        if (args.power_unit !== undefined) commands.push(`:UNIT:POWer ${UNITS[args.power_unit]}`);
        if (args.scale_per_div_db !== undefined) commands.push(`${Y}:PDIVision ${formatNumber(args.scale_per_div_db)}`);
        if (args.scale_type !== undefined) commands.push(`${Y}:SPACing ${SCALE_TYPES[args.scale_type]}`);
        if (args.reference_level !== undefined) commands.push(`${Y}:RLEVel ${formatNumber(args.reference_level)}`);
        if (args.reference_level_offset_db !== undefined) {
          commands.push(`${Y}:RLEVel:OFFSet ${formatNumber(args.reference_level_offset_db)}`);
        }
        // The preamp changes the automatic attenuation, so set it before attenuation.
        if (args.preamp !== undefined) commands.push(`:POWer:GAIN:STATe ${onOff(args.preamp)}`);
        if (args.attenuation_db !== undefined) commands.push(`:POWer:ATTenuation ${formatNumber(args.attenuation_db)}`);
        if (args.attenuation_auto !== undefined) commands.push(`:POWer:ATTenuation:AUTO ${onOff(args.attenuation_auto)}`);
        if (args.input_impedance_ohm !== undefined) commands.push(`${IMPEDANCE} ${args.input_impedance_ohm}`);

        await applyCommands(commands);

        const state = await readAmplitudeState();
        const warnings: string[] = [];
        const numeric: Array<[string, number | undefined, number, string]> = [
          ["reference_level", args.reference_level, state.reference_level, state.power_unit],
          ["scale_per_div_db", args.scale_per_div_db, state.scale_per_div_db, "dB"],
          ["reference_level_offset_db", args.reference_level_offset_db, state.reference_level_offset_db, "dB"],
          ["input_impedance_ohm", args.input_impedance_ohm, state.input_impedance_ohm, "ohm"],
        ];
        // Automatic attenuation follows the reference level (and lags it), so only check a manual value.
        if (args.attenuation_db !== undefined && args.attenuation_auto === undefined) {
          numeric.push(["attenuation_db", args.attenuation_db, state.attenuation_db, "dB"]);
        }
        for (const [name, requested, actual, unit] of numeric) {
          if (requested !== undefined && !close(requested, actual)) {
            warnings.push(`${name} adjusted by the instrument: requested ${requested} ${unit}, now ${actual} ${unit}`);
          }
        }
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        if (err instanceof InstrumentError) {
          return errorResult(`${err.message}. Settings may be partially applied; use get_amplitude to check.`);
        }
        return errorResult(err);
      }
    }
  );
}
