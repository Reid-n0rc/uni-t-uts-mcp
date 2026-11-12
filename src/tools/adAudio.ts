import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyCommands, queryBool, queryNumber, queryParsed, readBack } from "../instrument.js";
import { onOff } from "../scpi.js";
import { readDemodType } from "./adSettings.js";
import { errorResult, setterFailure, textResult, defineTool } from "./util.js";

// Commands: docs/research/analog-demodulation.md section "Audio and filters" (PM p.158-160, #194).
// Every AD filter command takes the AM|FM prefix, read fresh from :CONFigure? each call (adSettings.ts).
// NOT live-verified (docs/verified-hardware.md): every command in this file. Ranges/enums come from the
// programming manual via the research doc.

const SPEAKER_STATE = ":SPEaker:STATe";
const VOLUME = ":SYSTem:VOLume";

/** PM p.159. Setting any of these turns the band-pass filter off (the UM, p.53). */
const LP_VALUES = ["OFF", "LPF300", "LPF3K", "LPF15K", "LPF30K", "LPF80K", "LPF100K", "LPF300K"] as const;
/** PM p.159-160. Setting any of these turns the band-pass filter off (same note). */
const HP_VALUES = ["OFF", "HPF20", "HPF50", "HPF300", "HPF400"] as const;
/** PM p.160. Setting any of these turns the low-pass and high-pass filters off (same note). */
const BP_VALUES = ["OFF", "AWEighting", "CWEighting", "CCIR1k", "CCIR2k", "CUNWeighting"] as const;

/** Case-insensitive match against a fixed enum list, returning the canonical-cased value (like parseModuleReply). */
function parseEnumReply<T extends string>(values: readonly T[]): (reply: string) => T {
  const reverse = new Map(values.map((v) => [v.toUpperCase(), v] as const));
  return (reply: string) => {
    const value = reverse.get(reply.trim().toUpperCase());
    if (value === undefined) throw new Error(`expected one of ${values.join(", ")}, got ${JSON.stringify(reply)}`);
    return value;
  };
}

interface FilterState {
  low_pass_filter: (typeof LP_VALUES)[number];
  high_pass_filter: (typeof HP_VALUES)[number];
  band_pass_filter: (typeof BP_VALUES)[number];
}

async function readFilters(p: string): Promise<FilterState> {
  return {
    low_pass_filter: await queryParsed(`${p}:LPFilter?`, parseEnumReply(LP_VALUES)),
    high_pass_filter: await queryParsed(`${p}:HPFilter?`, parseEnumReply(HP_VALUES)),
    band_pass_filter: await queryParsed(`${p}:BPFilter?`, parseEnumReply(BP_VALUES)),
  };
}

const FILTER_SHAPE = {
  low_pass_filter: z
    .enum(LP_VALUES)
    .optional()
    .describe("Low-pass audio filter cutoff (PM p.159). Setting this turns the band-pass filter off."),
  high_pass_filter: z
    .enum(HP_VALUES)
    .optional()
    .describe("High-pass audio filter cutoff (PM p.159-160). Setting this turns the band-pass filter off."),
  band_pass_filter: z
    .enum(BP_VALUES)
    .optional()
    .describe("Band-pass/weighting audio filter (PM p.160). Setting this turns the low-pass and high-pass filters off."),
};
type FilterArgs = { [K in keyof typeof FILTER_SHAPE]?: z.infer<(typeof FILTER_SHAPE)[K]> };

function validateFilters(a: FilterArgs): string | undefined {
  const given = (["low_pass_filter", "high_pass_filter", "band_pass_filter"] as const).filter((k) => a[k] !== undefined);
  if (given.length === 0) return "No parameters given.";
  if (given.length > 1) {
    return "At most one filter family (low-pass, high-pass or band-pass) can be set per call; the instrument turns the others off anyway (PM p.159-160).";
  }
  return undefined;
}

export function registerAdAudioTools(server: McpServer): void {
  defineTool(
    server,
    "set_ad_filters",
    "Set one AD (analog demodulation) audio filter family: low-pass, high-pass or band-pass/weighting (PM p.158-160). AD " +
      "module must be active. The AM/FM prefix is read fresh from :CONFigure? each call. At most one family per call: the " +
      "manual says choosing a low- or high-pass filter turns the band-pass filter off and vice versa, so this tool reads " +
      "all three before and after and reports in 'warnings' whichever other family the instrument turned off. Not yet " +
      "live-verified; ranges/enums come from the manual.",
    FILTER_SHAPE,
    { readOnlyHint: false, idempotentHint: true },
    async (args) => {
      try {
        const demod_type = await readDemodType();
        const p = `:${demod_type}`;
        const before = await readFilters(p);
        const command =
          args.low_pass_filter !== undefined
            ? `${p}:LPFilter ${args.low_pass_filter}`
            : args.high_pass_filter !== undefined
              ? `${p}:HPFilter ${args.high_pass_filter}`
              : `${p}:BPFilter ${args.band_pass_filter}`;
        await applyCommands([command]);
        const after = await readBack(() => readFilters(p));
        const warnings: string[] = [];
        const simple = (key: keyof FilterArgs) => {
          const want = args[key];
          if (want === undefined) return;
          if (after[key] !== want) warnings.push(`${key} adjusted by the instrument: requested ${want}, now ${after[key]}`);
        };
        simple("low_pass_filter");
        simple("high_pass_filter");
        simple("band_pass_filter");
        (["low_pass_filter", "high_pass_filter", "band_pass_filter"] as const)
          .filter((key) => args[key] === undefined)
          .forEach((key) => {
            if (before[key] !== "OFF" && after[key] === "OFF") {
              warnings.push(`${key} turned off by the instrument (mutually exclusive with the family just set)`);
            }
          });
        return textResult(JSON.stringify({ demod_type, ...after, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "set_ad_filters");
      }
    },
    { validate: validateFilters, requireModule: "ad" }
  );

  const AUDIO_SHAPE = {
    speaker: z
      .boolean()
      .optional()
      .describe(
        "Turn the speaker on or off. Turning it ON requires confirm=true: it plays the demodulated signal on the loudspeaker " +
          "and headphones immediately, at the shared system volume (PM p.158-159, UM p.52; docs/research/analog-demodulation.md risk 3)."
      ),
    volume_pct: z.number().finite().int().min(0).max(100).optional().describe("System volume in percent, 0-100 (PM p.9). Shared with the rest of the instrument."),
    confirm: z.boolean().optional().describe("Required (true) to turn the speaker on, or to raise the volume while it is already on."),
    keep: z
      .boolean()
      .optional()
      .describe("Leave the new speaker/volume state in place instead of restoring what it was before this call (default false: restore)."),
  };
  type AudioArgs = { [K in keyof typeof AUDIO_SHAPE]?: z.infer<(typeof AUDIO_SHAPE)[K]> };

  function validateAudio(a: AudioArgs): string | undefined {
    if (a.speaker === undefined && a.volume_pct === undefined) return "No parameters given.";
    if (a.speaker === true && a.confirm !== true) {
      return (
        "Turning the speaker on requires confirm=true: it plays the demodulated signal on the loudspeaker and headphones " +
        "immediately, audible in a shared lab (docs/research/analog-demodulation.md risk 3). Pass confirm: true to proceed."
      );
    }
    return undefined;
  }

  async function readAudio(): Promise<{ speaker: boolean; volume_pct: number }> {
    return { speaker: await queryBool(`${SPEAKER_STATE}?`), volume_pct: await queryNumber(`${VOLUME}?`) };
  }

  defineTool(
    server,
    "set_ad_audio",
    "Set the AD (analog demodulation) module's speaker and/or system volume (PM p.158-159, p.9). AD module must be active. " +
      "Turning the speaker ON, or raising the volume while it is already on, requires confirm=true (loud/unexpected tone in a " +
      "shared lab, docs/research/analog-demodulation.md risk 3). By default restores the speaker and volume to what they were " +
      "before this call once the requested change is confirmed by read-back; pass keep=true to leave the new state in place " +
      "instead. Not yet live-verified; ranges come from the manual.",
    AUDIO_SHAPE,
    { readOnlyHint: false, idempotentHint: false },
    async (args) => {
      try {
        const before = await readAudio();
        if (
          args.volume_pct !== undefined &&
          before.speaker &&
          args.volume_pct > before.volume_pct &&
          args.confirm !== true
        ) {
          return errorResult(
            `Refusing to raise the volume from ${before.volume_pct} to ${args.volume_pct} while the speaker is already on, ` +
              "without confirm=true: it is audible immediately in a shared lab (docs/research/analog-demodulation.md risk 3). " +
              "Pass confirm: true to proceed."
          );
        }
        const commands: string[] = [];
        if (args.speaker !== undefined) commands.push(`${SPEAKER_STATE} ${onOff(args.speaker)}`);
        if (args.volume_pct !== undefined) commands.push(`${VOLUME} ${args.volume_pct}`);
        await applyCommands(commands);
        const applied = await readBack(readAudio);
        const warnings: string[] = [];
        if (args.speaker !== undefined && applied.speaker !== args.speaker) {
          warnings.push(`speaker adjusted by the instrument: requested ${args.speaker}, now ${applied.speaker}`);
        }
        if (args.volume_pct !== undefined && applied.volume_pct !== args.volume_pct) {
          warnings.push(`volume_pct adjusted by the instrument: requested ${args.volume_pct}, now ${applied.volume_pct}`);
        }
        let restored = false;
        let final = applied;
        if (args.keep !== true) {
          const restoreCommands: string[] = [];
          if (args.speaker !== undefined) restoreCommands.push(`${SPEAKER_STATE} ${onOff(before.speaker)}`);
          if (args.volume_pct !== undefined) restoreCommands.push(`${VOLUME} ${before.volume_pct}`);
          if (restoreCommands.length > 0) {
            // Like restoreSa (src/tools/measurement.ts): a restore failure is a real error, not a warning on an
            // otherwise-successful call, because it would silently leave the speaker/volume changed in a shared lab.
            // The requested change above already applied, so say so explicitly rather than relying on applyCommands'
            // own "sent so far" wording, which only covers this second, separate applyCommands call.
            try {
              await applyCommands(restoreCommands);
              final = await readBack(readAudio);
              restored = true;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(
                `The requested change was applied (speaker=${applied.speaker}, volume_pct=${applied.volume_pct}), but restoring ` +
                  `the previous speaker/volume state failed: ${message}`
              );
            }
          }
        }
        return textResult(JSON.stringify({ speaker: final.speaker, volume_pct: final.volume_pct, restored, warnings }, null, 2));
      } catch (err) {
        return setterFailure(err, "set_ad_audio");
      }
    },
    { validate: validateAudio, requireModule: "ad" }
  );
}
