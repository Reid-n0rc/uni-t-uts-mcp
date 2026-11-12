import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, readBack, ReplyError } from "../instrument.js";
import { connection } from "../connection.js";
import { ensureModuleOk } from "../moduleGuard.js";
import { formatNumber, parseNumberList } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: `[:SENSe]:CORRection:CSET<n>...` (programming manual pp.125-127; docs/research/emi-function.md
// section 3.8), the EMI module's 10 antenna/cable correction-factor slots. `:CORRection:SELect` exists in
// the manual but is not needed here: every command already names its slot via `CSET<n>`, and a live probe
// (2026-11-12, this unit, EMI licensed) wrote and read back `:SENSe:CORRection:CSET1:DATA` directly without
// ever sending `SELect`. The same probe found the point cap: a 10-point write round-tripped exactly; an
// 11-point write was silently rejected with no error on `*ESR?`/`*STB?`/`:SYSTem:ERRor?` (same silent-reject
// behavior already documented for other out-of-range setters), after which `DATA?` on that slot went silent
// the same way an empty line does, so the failed write left the slot's data empty rather than partial.

const SLOT = z.number().int().min(1).max(10).describe("Correction set number, 1 to 10");
const CSET = (n: number) => `:SENSe:CORRection:CSET${n}`;
const MAX_POINTS = 10;
/** The instrument sends no reply at all to DATA? on an empty slot (verified live), so this wait is the "empty" signal. */
const DATA_TIMEOUT_MS = 1500;
const DELETE_CHECKS = 4;
const DELETE_CHECK_DELAY_MS = 300;

export interface EmiCorrectionPoint {
  frequency_hz: number;
  gain_db: number;
}

export interface EmiCorrectionState {
  slot: number;
  enabled: boolean;
  points: EmiCorrectionPoint[];
}

function parsePoints(reply: string): EmiCorrectionPoint[] {
  const values = parseNumberList(reply);
  if (values.length % 2 !== 0) {
    throw new Error(`Expected frequency,gain pairs, got ${values.length} values`);
  }
  const points: EmiCorrectionPoint[] = [];
  for (let i = 0; i < values.length; i += 2) {
    points.push({ frequency_hz: values[i], gain_db: values[i + 1] });
  }
  return points;
}

/**
 * Read a slot's points. Verified live: the analyzer does not answer `DATA?` on a slot with no points
 * (and posts no error), so a timeout here is an empty slot, not a dead connection.
 */
async function readPoints(n: number): Promise<EmiCorrectionPoint[]> {
  const command = `${CSET(n)}:DATA?`;
  let reply: string;
  try {
    await ensureModuleOk();
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

async function readSlot(n: number): Promise<EmiCorrectionState> {
  const enabled = await queryBool(`${CSET(n)}:STATe?`);
  const points = await readPoints(n); // last: its silence on an empty slot triggers the hold-off
  return { slot: n, enabled, points };
}

const freqClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, 1e-8 * Math.abs(a));
const gainClose = (a: number, b: number) => Math.abs(a - b) <= 1e-4;

function pointsMatch(requested: EmiCorrectionPoint[], actual: EmiCorrectionPoint[]): boolean {
  return (
    requested.length === actual.length &&
    requested.every((r, i) => freqClose(r.frequency_hz, actual[i].frequency_hz) && gainClose(r.gain_db, actual[i].gain_db))
  );
}

const POINT = z.object({
  frequency_hz: z.number().finite().min(0).describe("Frequency in Hz (>= 0)"),
  gain_db: z.number().finite().describe("Correction gain in dB, added to the measured level at this frequency"),
});

const SET_SHAPE = {
  slot: SLOT.optional().describe("Required unless all_off or delete_all is the only action given"),
  points: z
    .array(POINT)
    .optional()
    .describe(`Replace slot's whole point list: 1 to ${MAX_POINTS} points in ascending frequency order`),
  enabled: z.boolean().optional().describe("Turn this slot's correction on/off"),
  delete: z.boolean().optional().describe("Clear this slot's points (sent before points/enabled)"),
  all_off: z.boolean().optional().describe("Turn off every correction slot's enabled state (:CSET:ALL:STATe OFF); exclusive of slot/points/enabled/delete/delete_all"),
  delete_all: z.boolean().optional().describe("Clear every correction slot's points (:CSET:ALL:DELete); exclusive of slot/points/enabled/delete/all_off"),
};
type SetArgs = { [K in keyof typeof SET_SHAPE]?: z.infer<(typeof SET_SHAPE)[K]> };

/** Returns an error message, or undefined when the arguments are valid. */
export function validateSet(a: SetArgs): string | undefined {
  const perSlot = a.points !== undefined || a.enabled !== undefined || a.delete !== undefined;
  const bulk = a.all_off === true || a.delete_all === true;
  if (!perSlot && !bulk) return "No parameters given; provide at least one of points, enabled, delete, all_off or delete_all.";
  if (bulk && (perSlot || a.slot !== undefined)) {
    return "all_off and delete_all apply to every slot; give them alone, not with slot, points, enabled or delete.";
  }
  if (a.all_off === true && a.delete_all === true) return "Give all_off or delete_all, not both.";
  if (perSlot && a.slot === undefined) return "slot is required when giving points, enabled or delete.";
  if (a.delete === true && a.points !== undefined) return "Give delete or points for a slot, not both.";
  if (a.points !== undefined) {
    const p = a.points;
    if (p.length < 1) return "points needs at least 1 point; use delete to remove all points from this slot.";
    if (p.length > MAX_POINTS) return `points has ${p.length} entries; at most ${MAX_POINTS} are kept by the instrument (it silently rejects a longer list).`;
    for (let i = 1; i < p.length; i++) {
      if (p[i].frequency_hz < p[i - 1].frequency_hz) {
        return `points must be in ascending frequency order (point ${i + 1} is below point ${i}).`;
      }
    }
  }
  return undefined;
}

export function registerEmiCorrectionTools(server: McpServer): void {
  defineTool(
    server,
    "get_emi_correction",
    "Read one EMI correction (antenna/cable) factor set: whether it is enabled and its point list (frequency in Hz, " +
      "gain in dB, added to the measured level at that frequency). EMI module must be active (select_instrument_module).",
    { slot: SLOT.default(1) },
    { readOnlyHint: true },
    async ({ slot }) => {
      try {
        return textResult(JSON.stringify(await readSlot(slot), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "emi" }
  );

  defineTool(
    server,
    "set_emi_correction",
    "Edit an EMI correction (antenna/cable) factor set. EMI module must be active (select_instrument_module). Give " +
      "slot plus any of: points (replaces the whole point list; 1 to 10 points in ascending frequency order, each " +
      "with frequency_hz and gain_db), enabled (on/off), or delete (clears this slot's points; not combined with " +
      "points). Or give all_off (turns every slot off) or delete_all (clears every slot's points) alone, without " +
      "slot. The slot (or slot 1, for all_off/delete_all) is re-read afterwards; anything the instrument did not " +
      "take is reported in 'warnings'.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (a) => {
      try {
        const commands: string[] = [];
        if (a.all_off) commands.push(":SENSe:CORRection:CSET:ALL:STATe OFF");
        if (a.delete_all) commands.push(":SENSe:CORRection:CSET:ALL:DELete");

        const n = a.slot;
        let requested: EmiCorrectionPoint[] | undefined;
        if (n !== undefined) {
          if (a.delete) commands.push(`${CSET(n)}:DELete`);
          if (a.points !== undefined) {
            requested = a.points;
            const flat = requested.map((p) => `${formatNumber(p.frequency_hz)},${formatNumber(p.gain_db)}`);
            commands.push(`${CSET(n)}:DATA ${flat.join(",")}`);
          }
          if (a.enabled !== undefined) commands.push(`${CSET(n)}:STATe ${a.enabled ? 1 : 0}`);
        }

        await applyCommands(commands);

        const check = n ?? 1;
        const deleting = a.delete === true || a.delete_all === true;
        const state = await readBack(async () => {
          let s = await readSlot(check);
          for (let attempt = 1; deleting && attempt < DELETE_CHECKS && s.points.length > 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, DELETE_CHECK_DELAY_MS));
            s = await readSlot(check);
          }
          return s;
        });
        const warnings: string[] = [];
        if (n !== undefined) {
          if (a.enabled !== undefined && a.enabled !== state.enabled) {
            warnings.push(`enabled adjusted by the instrument: requested ${a.enabled}, now ${state.enabled}`);
          }
          if (requested && !pointsMatch(requested, state.points)) {
            warnings.push(
              `points adjusted by the instrument: requested ${requested.length} points, now ${state.points.length}` +
                " (see state.points for what it holds)"
            );
          }
          if (a.delete && state.points.length > 0) {
            warnings.push(`slot ${n} still has ${state.points.length} points after delete`);
          }
        }
        if (a.all_off && state.enabled) warnings.push(`slot ${check} still enabled after all_off`);
        if (a.delete_all && state.points.length > 0) warnings.push(`slot ${check} still has ${state.points.length} points after delete_all`);
        return textResult(JSON.stringify({ state, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_correction");
      }
    },
    { validate: validateSet, requireModule: "emi" }
  );
}
