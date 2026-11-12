import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryParsed } from "../instrument.js";
import { readDemodType } from "./adSettings.js";
import { errorResult, textResult, defineTool } from "./util.js";

// Commands: docs/research/analog-demodulation.md section 6a / section 7 item 7 (#196). Live-verified
// 2026-11-11 (docs/verified-hardware.md, "Installed options and AD results readback"): the bare
// `:FETCh:AM?`/`:FETCh:FM?` query (suffix 1, the default) returns a 15-value line that is exactly
// the numeric result window the AD screen shows — depth/deviation, SINAD, THD, carrier power — with
// no documented command and no screenshot. This answers the open "AD results investigation" question
// (research doc proposal item 7): `read_modulation` (the tentative name in proposal item 6) is not
// needed, since a results query does exist. Suffix 0 (RF spectrum trace), 2-5 (demodulated waveform
// hold modes) and 6 (AF spectrum) exist per the same suffix map but are not exposed by this tool,
// which wraps only the numeric metrics window; the trace/waveform views stay a screenshot-only gap
// (docs/research/analog-demodulation.md, "Measurements: gap").

const FIELD_COUNT = 15;

export interface DemodResult {
  demod_type: "AM" | "FM";
  /** Center frequency in Hz. */
  center_frequency_hz: number;
  /** Carrier power; unit not independently confirmed beyond the live example (plausibly dBm). */
  carrier_power: number;
  /** Carrier frequency error in Hz; `NaN` when no real modulated signal is present (seen live). */
  carrier_frequency_error_hz: number;
  /** Modulation rate; unit not independently confirmed (plausibly Hz). */
  modulation_rate: number;
  sinad_db: number;
  /** Labeled "distortion/total Vrms" in the firmware disassembly; exact meaning not independently confirmed. */
  distortion_or_total_vrms: number;
  thd_percent: number;
  current: HoldValues;
  max_hold: HoldValues;
}

interface HoldValues {
  /** Positive peak; AM: modulation depth as a fraction (1 = 100%). FM: frequency deviation in Hz (manual, markers section). */
  peak_plus: number;
  /** Negative peak, same unit as peak_plus. */
  peak_minus: number;
  /** (peak-to-peak)/2, same unit as peak_plus. */
  pk_pk_over_2: number;
  rms: number;
}

function parseMetricsLine(reply: string): number[] {
  const parts = reply.trim().split(",");
  if (parts.length !== FIELD_COUNT) {
    throw new Error(`Expected ${FIELD_COUNT} comma-separated values from :FETCh:AM?/:FETCh:FM?, got ${parts.length}: ${JSON.stringify(reply)}`);
  }
  return parts.map((part) => {
    const text = part.trim();
    if (text.toLowerCase() === "nan") return NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
      throw new Error(`Expected a number, got ${JSON.stringify(part)} in reply ${JSON.stringify(reply)}`);
    }
    return Number(text);
  });
}

function toResult(demod_type: "AM" | "FM", v: number[]): DemodResult {
  return {
    demod_type,
    center_frequency_hz: v[0]!,
    carrier_power: v[1]!,
    carrier_frequency_error_hz: v[2]!,
    modulation_rate: v[3]!,
    sinad_db: v[4]!,
    distortion_or_total_vrms: v[5]!,
    thd_percent: v[6]!,
    current: { peak_plus: v[7]!, peak_minus: v[8]!, pk_pk_over_2: v[9]!, rms: v[10]! },
    max_hold: { peak_plus: v[11]!, peak_minus: v[12]!, pk_pk_over_2: v[13]!, rms: v[14]! },
  };
}

export function registerAdResultTools(server: McpServer): void {
  defineTool(
    server,
    "get_demod_result",
    "Get the AD (analog demodulation) module's numeric result window — center frequency, carrier power, carrier " +
      "frequency error, modulation rate, SINAD, distortion/total Vrms, THD, and peak+/peak-/(pk-pk)/2/RMS for both the " +
      "current and max-hold rows — without a screenshot. Wraps the undocumented bare `:FETCh:AM?`/`:FETCh:FM?` query " +
      "(suffix 1, the default), confirmed live on this firmware (docs/verified-hardware.md). The AM/FM type is read " +
      "fresh from :CONFigure? each call. AD module must be active (enter_analog_demod/select_instrument_module). This " +
      "does not expose the RF spectrum trace, demodulated waveform or AF spectrum views (other FETCh suffixes); those " +
      "remain screenshot-only. Units beyond what the live example confirmed (Hz, dB) are plausible, not independently verified.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const demod_type = await readDemodType();
        const values = await queryParsed(`:FETCh:${demod_type}?`, parseMetricsLine);
        return textResult(JSON.stringify(toResult(demod_type, values), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
    { requireModule: "ad" }
  );
}
