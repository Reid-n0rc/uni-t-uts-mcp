import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, readBack } from "../instrument.js";
import { formatNumber } from "../scpi.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";
import { BAND_COUNT, readBand, type Band } from "./emiSettings.js";

// Commands: docs/research/emi-function.md section 3.2 (EMI scan table, programming manual pp.132-137).
// Behavior not yet verified live (EMI-12, #187, needs the owner present): ranges and the preset band
// list come from the programming manual via the research document. The manual documents silent
// coupling when bands overlap or cross (UM p.21), so every call re-reads the whole table and warns
// about anything the instrument changed beyond what was asked.

const BAND_NUM = z.number().int().min(1).max(BAND_COUNT).describe(`Scan band number, 1 to ${BAND_COUNT}`);

const CIS_PRESETS = { A: "CISA", B: "CISB", C: "CISC", D: "CISD", CD: "CISCD", E: "CISE" } as const;
type CisPreset = keyof typeof CIS_PRESETS;

const BAND_EDIT = z.object({
  band: BAND_NUM,
  enabled: z.boolean().optional().describe("Whether this band is scanned"),
  start_hz: z.number().finite().min(0).optional().describe("Band start frequency in Hz"),
  stop_hz: z.number().finite().min(0).optional().describe("Band stop frequency in Hz (must be at least 100 Hz above start_hz)"),
  rbw_hz: z.number().finite().min(0).optional().describe("Resolution bandwidth in Hz; turns rbw_auto off"),
  rbw_auto: z.boolean().optional().describe("Automatic resolution bandwidth on/off"),
  time_s: z.number().finite().min(0).optional().describe("Sweep time for this band in seconds, 1 ms to 4000 s; turns time_auto off"),
  time_auto: z.boolean().optional().describe("Automatic sweep time on/off"),
  attenuation_db: z.number().int().optional().describe("RF attenuation in dB, even number 0 to 50; turns attenuation_auto off"),
  attenuation_auto: z.boolean().optional().describe("Automatic attenuation on/off"),
  points: z.number().int().min(11).max(40001).optional().describe("Sweep points for this band, 11 to 40001"),
  preamp: z.boolean().optional().describe("Preamplifier on/off for this band"),
});
type BandEdit = z.infer<typeof BAND_EDIT>;

const PRESET = z.object({
  band: BAND_NUM,
  cis: z.enum(["A", "B", "C", "D", "CD", "E"]).describe(
    "CISPR band preset to load into this band: A 9 kHz-150 kHz, B 150 kHz-30 MHz, C 30 MHz-300 MHz, D 300 MHz-1 GHz, CD 30 MHz-1 GHz, E 1 GHz-fmax"
  ),
});

const SET_SHAPE = {
  bands: z.array(BAND_EDIT).optional().describe("Per-band edits; give only the fields to change for each band"),
  presets: z.array(PRESET).optional().describe("Load a CISPR band preset into a band (applied before any bands edits for the same band number)"),
};
type SetArgs = { bands?: BandEdit[]; presets?: Array<z.infer<typeof PRESET>> };

function p(n: number): string {
  return `:SENSe:FSCan:SCAN${n}`;
}

export function validateSet(a: SetArgs): string | undefined {
  if (!a.bands?.length && !a.presets?.length) return "No parameters given; provide bands and/or presets.";
  for (const b of a.bands ?? []) {
    const given = Object.entries(b).some(([k, v]) => k !== "band" && v !== undefined);
    if (!given) return `bands entry for band ${b.band} has no fields to change.`;
    if (b.start_hz !== undefined && b.stop_hz !== undefined && b.stop_hz - b.start_hz < 100) {
      return `band ${b.band}: stop_hz must be at least 100 Hz above start_hz.`;
    }
    if (b.attenuation_db !== undefined && (b.attenuation_db < 0 || b.attenuation_db > 50 || b.attenuation_db % 2 !== 0)) {
      return `band ${b.band}: attenuation_db must be an even number from 0 to 50.`;
    }
    if (b.time_s !== undefined && (b.time_s < 1e-3 || b.time_s > 4000)) {
      return `band ${b.band}: time_s must be between 0.001 and 4000.`;
    }
  }
  const bandNumbers = new Set<number>();
  for (const b of a.bands ?? []) {
    if (bandNumbers.has(b.band)) return `band ${b.band} appears more than once in bands.`;
    bandNumbers.add(b.band);
  }
  const presetNumbers = new Set<number>();
  for (const pr of a.presets ?? []) {
    if (presetNumbers.has(pr.band)) return `band ${pr.band} appears more than once in presets.`;
    presetNumbers.add(pr.band);
  }
  return undefined;
}

function bandCommands(b: BandEdit): string[] {
  const n = b.band;
  const commands: string[] = [];
  // Start/stop first: the manual documents silent coupling with neighboring bands on overlap or
  // crossing, so placing the edges before the other fields keeps that effect isolated to this step.
  if (b.start_hz !== undefined) commands.push(`${p(n)}:STARt ${formatNumber(b.start_hz)}`);
  if (b.stop_hz !== undefined) commands.push(`${p(n)}:STOP ${formatNumber(b.stop_hz)}`);
  if (b.rbw_hz !== undefined) commands.push(`${p(n)}:BANDwidth:RESolution ${formatNumber(b.rbw_hz)}`);
  if (b.rbw_auto !== undefined) commands.push(`${p(n)}:BANDwidth:RESolution:AUTO ${b.rbw_auto ? 1 : 0}`);
  if (b.time_s !== undefined) commands.push(`${p(n)}:TIME ${formatNumber(b.time_s)}`);
  if (b.time_auto !== undefined) commands.push(`${p(n)}:TIME:AUTO ${b.time_auto ? 1 : 0}`);
  if (b.attenuation_db !== undefined) commands.push(`${p(n)}:INPut:ATTenuation ${formatNumber(b.attenuation_db)}`);
  if (b.attenuation_auto !== undefined) commands.push(`${p(n)}:INPut:ATTenuation:AUTO ${b.attenuation_auto ? 1 : 0}`);
  if (b.points !== undefined) commands.push(`${p(n)}:POINt ${b.points}`);
  if (b.preamp !== undefined) commands.push(`${p(n)}:POWer:GAIN:STATe ${b.preamp ? 1 : 0}`);
  // State last: an edit to a disabled band is still accepted, and enabling it last avoids a sweep
  // restarting mid-edit on a band that was already active.
  if (b.enabled !== undefined) commands.push(`${p(n)}:STATe ${b.enabled ? 1 : 0}`);
  return commands;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, 1e-9 * Math.abs(a));

function warnBand(requested: BandEdit, actual: Band, warnings: string[]): void {
  const n = requested.band;
  const check = <K extends keyof BandEdit & keyof Band>(key: K, label: string) => {
    const want = requested[key];
    if (want === undefined) return;
    const got = actual[key];
    const matches = typeof want === "number" && typeof got === "number" ? close(want, got) : want === got;
    if (!matches) warnings.push(`band ${n} ${label} adjusted by the instrument: requested ${want}, now ${got}`);
  };
  check("enabled", "enabled");
  check("start_hz", "start_hz");
  check("stop_hz", "stop_hz");
  check("rbw_hz", "rbw_hz");
  check("rbw_auto", "rbw_auto");
  check("time_s", "time_s");
  check("time_auto", "time_auto");
  check("attenuation_db", "attenuation_db");
  check("attenuation_auto", "attenuation_auto");
  check("points", "points");
  check("preamp", "preamp");
}

export function registerEmiScanTableTools(server: McpServer): void {
  defineTool(
    server,
    "set_emi_scan_table",
    "Edit the EMI module's 10-band scan table: per band, enabled, start_hz, stop_hz, rbw_hz/rbw_auto, time_s/time_auto, " +
      "attenuation_db/attenuation_auto, points (11-40001) and preamp; or load a CISPR band preset (presets: band, cis: " +
      "A/B/C/D/CD/E). EMI module must be active (select_instrument_module). The whole table is re-read afterwards and " +
      "anything adjusted by the instrument (including the neighbor-band coupling the manual describes on overlap or " +
      "crossing) is reported in 'warnings'.",
    SET_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async ({ bands, presets }) => {
      try {
        const touched = new Set<number>([...(presets ?? []).map((pr) => pr.band), ...(bands ?? []).map((b) => b.band)]);
        const before: Band[] = [];
        for (let n = 1; n <= BAND_COUNT; n++) before.push(await readBand(n));

        const commands: string[] = [];
        // Presets first: they are coarse-grained band loads; any bands edit for the same band number
        // then refines on top of the preset's result.
        for (const pr of presets ?? []) commands.push(`:SENSe:FSCan:RANGe${pr.band}:PREset ${CIS_PRESETS[pr.cis as CisPreset]}`);
        for (const b of bands ?? []) commands.push(...bandCommands(b));

        await applyCommands(commands);

        const table = await readBack(async () => {
          const result: Band[] = [];
          for (let n = 1; n <= BAND_COUNT; n++) result.push(await readBand(n));
          return result;
        });

        const warnings: string[] = [];
        for (const b of bands ?? []) {
          const actual = table.find((t) => t.band === b.band)!;
          warnBand(b, actual, warnings);
        }
        for (let n = 1; n <= BAND_COUNT; n++) {
          if (touched.has(n)) continue;
          const was = before.find((t) => t.band === n)!;
          const now = table.find((t) => t.band === n)!;
          if (was.start_hz !== now.start_hz || was.stop_hz !== now.stop_hz) {
            warnings.push(
              `band ${n} was not edited but its range changed (${was.start_hz}-${was.stop_hz} Hz -> ${now.start_hz}-${now.stop_hz} Hz): ` +
                "the instrument's neighbor-band coupling (manual p.21)"
            );
          }
        }
        return textResult(JSON.stringify({ scan_table: table, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "get_emi_settings");
      }
    },
    { validate: validateSet, requireModule: "emi" }
  );
}
