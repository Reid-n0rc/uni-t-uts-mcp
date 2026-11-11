/**
 * Stateful fake UTS spectrum analyzer for end-to-end tests (issue #146).
 *
 * `UtsModel` is the pure instrument (one SCPI line in, replies out, an injectable clock, no sockets, so the
 * timing behavior can be tested with a fake clock); `startFakeUts()` puts it behind a raw TCP server on
 * 127.0.0.1 for tests that spawn the BUILT server over stdio.
 *
 * Every number and behavior traces back to docs/verified-hardware.md (section named in the comment) or to a
 * fixture under tests/fixtures/p2. Where the document has nothing, the value is tagged ASSUMED and is
 * only a stand-in that makes set/get round-trips work; it must never be relied on as a measured fact.
 *
 * Modelled: LF in / CRLF out, `*IDN?`, `*OPC?`, the `:SYSTem:ERRor?` queue (`*CLS` clears it), setters that
 * clamp silently or reject with -224, an unsupported query that gets no reply, stalls the instrument for about
 * 2.15 s and posts -113 about 4 s later, the window in which a single sweep ignores commands (raw TCP drops lines, VXI-11 queues them),
 * trace data as ASCII or a #4 block with CRLF, and the 144,800 byte screenshot cutoff.
 * Measurement modes (#150, docs "Measurements: channel power, time-domain power, OBW" and "Measurements: ACPR, TOI,
 * C/N, harmonics"): `:CONFigure:<meas>[:NDEFault]` presets the span and the measurement's parameters, `:CONFigure:SANalyzer`
 * does not undo the span, no query reports the mode, mode-dependent queries are silent, wrong-mode setters give -113,
 * and :FETCh:/:READ: results have the verified value counts and framing (READ: trailing space, no terminator over raw TCP).
 * Not modelled: trace averaging/hold, real signals (the trace is the fixture; measurement results are constant
 * noise-floor numbers, ASSUMED where the document gives none).
 */

import * as net from "node:net";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- timing constants (verified-hardware.md)

/** "Command timing and error queue": stall after an unsupported query. */
export const STALL_MS = 2150;
/** Same section: the -113 for an unsupported query lands about 4 s after it. */
export const LATE_ERROR_MS = 4000;
/** "Trace and screenshot probe": a large reply stops after exactly this many bytes over raw TCP. */
export const RAW_BLOCK_LIMIT = 144_800;
/** "Bandwidth, sweep ...": default automatic sweep time. */
const AUTO_SWEEP_TIME_S = 2.6475e-3;
/** "Tracking generator": with the output on the automatic sweep time is about 2.15 s. */
const TG_SWEEP_TIME_S = 2.15;

const FIXTURES = new URL("./fixtures/p2/", import.meta.url);
const fixtureText = readFileSync(new URL("trace1-ascii.txt", FIXTURES), "latin1");
const fixtureReal32 = readFileSync(new URL("trace1-real32.bin", FIXTURES));
const fixtureReal64 = readFileSync(new URL("trace1-real64.bin", FIXTURES));
const traceValues = fixtureText.trim().split(",").map(Number);
const screenshotHeader = Buffer.from(readFileSync(new URL("screenshot-data-header.hex", FIXTURES), "latin1").trim(), "hex");

// ---------------------------------------------------------------- output of the model

export type Out = { text: string } | { bytes: Buffer };

export interface ModelOptions {
  /** Clock in ms (default Date.now); tests pass a fake one. */
  now?: () => number;
  /** "raw": lines sent during a single sweep are dropped (verified). "vxi11": they are queued and answered after it. */
  transport?: "raw" | "vxi11";
  /** Scale (default 1) applied to the 2.15 s sweep time with the tracking generator on, so tests need not wait it out. */
  tgSweepScale?: number;
}

// ---------------------------------------------------------------- command table

type Units = Record<string, number>;
const HZ: Units = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9 };
const DB: Units = { DB: 1, DBM: 1 };
const SEC: Units = { S: 1, MS: 1e-3, US: 1e-6, NS: 1e-9 };
const NONE: Units = {};

type V = number | string | boolean;

interface Spec {
  id: string;
  /** SCPI path: `[:SENSe]` optional node, `<n>` numeric suffix, mixed case short/long form. */
  path: string;
  kind: "num" | "bool" | "enum" | "int";
  def?: V | ((idx: number) => V);
  min?: number;
  max?: number;
  units?: Units;
  values?: string[]; // enums: reply form (mixed case)
  upper?: boolean; // enum reply in upper case
  /** Highest valid numeric suffix; a larger one is unsupported (no reply / -113). */
  suffixMax?: number;
  /** Values are rounded to integers. */
  round?: boolean;
  /** Values are truncated to integers (the sweep points do that: 1001.6 -> 1001). */
  trunc?: boolean;
  /** Measurement parameter: only the measurement with this code (`CHPower`, ...) has it (a query elsewhere is silent, a setter gives -113). */
  mode?: string;
  /** Answers only in spectrum analyzer mode ("in a measurement they time out"). */
  saOnly?: boolean;
  /** Query gets no reply while this holds (":SPAN? (not in zero span)"). */
  silentWhen?: (m: UtsModel) => boolean;
  /** Called after a set (value already stored and clamped). */
  onSet?: (m: UtsModel, idx: number, v: V) => void;
  /** Custom reply. */
  get?: (m: UtsModel, idx: number) => string;
  /** Decimals of the reply (default 6); frequency-like values print 10 ("Reply format", issue #147). */
  dp?: number;
}

interface Node { short: string; long: string; optional: boolean; numeric: boolean }

function parsePath(path: string): Node[] {
  const cleaned = path.replace(/\[:?/g, ":[").replace(/^:/, "");
  return cleaned.split(":").filter(Boolean).map((raw) => {
    const optional = raw.startsWith("[");
    let name = raw.replace(/[[\]]/g, "");
    const numeric = name.endsWith("<n>");
    name = name.replace("<n>", "");
    const short = /^\*?[A-Z0-9]+/.exec(name)![0];
    return { short: short.toUpperCase(), long: name.toUpperCase(), optional, numeric };
  });
}

function matchNodes(spec: Node[], incoming: string[], at = 0, from = 0, suffixes: number[] = []): number[] | null {
  if (from === spec.length) return at === incoming.length ? suffixes : null;
  const node = spec[from]!;
  const word = incoming[at];
  if (word !== undefined) {
    const m = /^(\*?[A-Z]+)(\d*)$/.exec(word);
    if (m && (m[1] === node.short || m[1] === node.long) && (node.numeric ? true : m[2] === "")) {
      const next = node.numeric ? [...suffixes, m[2] === "" ? 1 : Number(m[2])] : suffixes;
      const r = matchNodes(spec, incoming, at + 1, from + 1, next);
      if (r) return r;
    }
  }
  return node.optional ? matchNodes(spec, incoming, at, from + 1, suffixes) : null;
}

const norm = (v: number, max?: number, min?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
/** 1-3-10 snapping used by RBW/VBW ("Bandwidth, sweep ..."): 50 kHz -> 30 kHz, 0 -> 1 Hz. */
function snap13(v: number): number {
  if (!(v > 1)) return 1;
  const decade = 10 ** Math.floor(Math.log10(v));
  const mant = v / decade;
  return decade * (mant >= 10 ? 10 : mant >= 3 ? 3 : 1);
}

const REF_UNITS: Record<string, string> = { DBM: "dBm", DBMV: "dBmV", DBUV: "dBuV", V: "V", W: "W" };
const FULL_START = 1e7; // "Probe": start 10 MHz, stop 3.6 GHz
const FULL_STOP = 3.6e9;
const MAX_FREQ = 3.61e9; // "Live check": span 10 GHz -> 3.61 GHz, stop 5 GHz -> 3.61 GHz
const MAX_CENTER = 3.60999995e9; // same section: center 5 GHz -> 3.60999995 GHz

function sweepTimeS(m: UtsModel): number {
  if (!m.bool("swt.auto")) return m.num("swt");
  return m.bool("tg.out") ? TG_SWEEP_TIME_S * m.tgSweepScale : AUTO_SWEEP_TIME_S;
}

const SPECS: Spec[] = [
  // --- frequency (docs: "Probe", "Live check of the error handling standard", "Trace data tool")
  { id: "fc", path: "[:SENSe]:FREQuency:CENTer", kind: "num", units: HZ, dp: 10, def: 1.805e9, min: 0, max: MAX_CENTER,
    onSet: (m) => m.centerChanged() },
  { id: "span", path: "[:SENSe]:FREQuency:SPAN", kind: "num", units: HZ, dp: 10, def: 3.59e9, min: 0, max: MAX_FREQ,
    silentWhen: (m) => m.num("span") === 0, // "`:SPAN?` (not in zero span)" answers in the measurements
    onSet: (m) => m.spanSet() },
  { id: "start", path: "[:SENSe]:FREQuency:STARt", kind: "num", units: HZ, dp: 10, def: FULL_START, min: 0, max: MAX_FREQ, // min ASSUMED
    onSet: (m) => m.edgeChanged() },
  { id: "stop", path: "[:SENSe]:FREQuency:STOP", kind: "num", units: HZ, dp: 10, def: FULL_STOP, min: 0, max: MAX_FREQ,
    onSet: (m) => m.edgeChanged() },
  { id: "step", path: "[:SENSe]:FREQuency:CENTer:STEP", kind: "num", units: HZ, dp: 10, def: 3e6, min: 0, max: MAX_FREQ, // 3 MHz seen in zero span; default ASSUMED
    onSet: (m) => m.set("step.auto", false) },
  { id: "step.auto", path: "[:SENSe]:FREQuency:CENTer:STEP:AUTO", kind: "bool", def: true },
  { id: "foff", path: "[:SENSe]:FREQuency:OFFSet", kind: "num", units: HZ, dp: 10, def: 0 }, // offset 0: ASSUMED

  // --- amplitude (docs: "Amplitude")
  { id: "rl", path: ":DISPlay:WINDow:TRACe:Y[:SCALe]:RLEVel", kind: "num", units: DB, def: 0, min: -100, max: 30,
    onSet: (m) => m.refChanged(),
    get: (m) => fmtNum(m.refLevelInUnit()) },
  { id: "rl.off", path: ":DISPlay:WINDow:TRACe:Y[:SCALe]:RLEVel:OFFSet", kind: "num", units: DB, def: 0, min: -327.6, max: 327.6,
    onSet: (m) => m.refChanged() },
  { id: "pdiv", path: ":DISPlay:WINDow:TRACe:Y[:SCALe]:PDIVision", kind: "num", units: DB, def: 10, min: 0.1, max: 20 },
  { id: "spacing", path: ":DISPlay:WINDow:TRACe:Y[:SCALe]:SPACing", kind: "enum", values: ["LOGarithmic", "LINear"], def: "LOGarithmic" },
  { id: "nrl", path: ":DISPlay:WINDow:TRACe:Y[:SCALe]:NRLevel", kind: "num", units: DB, def: 10, min: -100, max: 100 }, // "Tracking generator"
  { id: "unit", path: ":UNIT:POWer", kind: "enum", values: Object.keys(REF_UNITS), upper: true, def: "DBM" },
  { id: "att", path: ":POWer:ATTenuation", kind: "int", def: 10, min: 0, max: 51, round: true,
    onSet: (m) => m.set("att.auto", false) },
  { id: "att.auto", path: ":POWer:ATTenuation:AUTO", kind: "bool", def: true, onSet: (m) => m.refChanged() },
  { id: "preamp", path: ":POWer:GAIN:STATe", kind: "bool", def: false, onSet: (m) => m.refChanged() },
  { id: "imp", path: ":SENSe:CORRection:IMPedance:INPut:MAGNitude", kind: "num", units: NONE, def: 50,
    onSet: (m, _i, v) => m.set("imp", v === 75 ? 75 : 50) }, // "Amplitude": only 75 sticks, anything else reads 50

  // --- bandwidth, sweep, detector, trigger (docs: "Bandwidth, sweep, detector and trigger")
  { id: "rbw", path: ":SENSe:BANDwidth[:RESolution]", kind: "num", units: HZ, dp: 10, def: 3e6, min: 1, max: 3e6,
    onSet: (m, _i, v) => { m.set("rbw", snap13(v as number)); m.set("rbw.auto", false); m.vbwFollow(); } },
  { id: "rbw.auto", path: ":SENSe:BANDwidth[:RESolution]:AUTO", kind: "bool", def: true, onSet: (m) => m.autoBandwidth() },
  { id: "vbw", path: ":SENSe:BANDwidth:VIDeo", kind: "num", units: HZ, dp: 10, def: 3e6, min: 1, max: 3e6,
    onSet: (m, _i, v) => { m.set("vbw", snap13(v as number)); m.set("vbw.auto", false); } },
  { id: "vbw.auto", path: ":SENSe:BANDwidth:VIDeo:AUTO", kind: "bool", def: true, onSet: (m) => m.autoBandwidth() },
  { id: "ratio", path: ":SENSe:BANDwidth:VIDeo:RATio", kind: "num", units: NONE, def: 1, min: 1e-5, max: 3e6, onSet: (m) => m.vbwFollow() },
  { id: "shape", path: ":SENSe:BANDwidth:SHAPe", kind: "enum", values: ["GAUSsian", "FLATtop"], def: "GAUSsian" },
  { id: "swt", path: ":SENSe:SWEep:TIME", kind: "num", units: SEC, def: AUTO_SWEEP_TIME_S, min: 1e-3, max: 4000,
    onSet: (m) => m.set("swt.auto", false), get: (m) => fmtNum(sweepTimeS(m)) },
  { id: "swt.auto", path: ":SENSe:SWEep:TIME:AUTO", kind: "bool", def: true },
  { id: "swt.rule", path: ":SENSe:SWEep:TIME:AUTO:RULes", kind: "enum", values: ["NORMal", "ACCuracy"], def: "NORMal" },
  { id: "swtype", path: ":SENSe:SWEep:TYPE", kind: "enum", values: ["SWEep", "FFT"], def: "SWEep",
    onSet: (m) => m.set("swtype.auto", false) },
  { id: "swtype.auto", path: ":SENSe:SWEep:TYPE:AUTO", kind: "bool", def: true },
  { id: "pts", path: ":SENSe:SWEep:POINts", kind: "int", def: 1001, min: 11, max: 40001, trunc: true },
  { id: "det", path: ":SENSe:DETector:TRACe<n>", kind: "enum", suffixMax: 6, values: ["NORMal", "SAMPle", "POSitive", "NEGative", "AVERage"], def: "NORMal", saOnly: true, // "answers only in spectrum analyzer mode"
    onSet: (m, i) => m.set("det.auto", false, i) },
  { id: "det.auto", path: ":SENSe:DETector:TRACe<n>:AUTO", kind: "bool", suffixMax: 6, def: true },
  { id: "trig", path: ":TRIGger[:SEQuence]:SOURce", kind: "enum", values: ["IMMediate", "VIDeo"], def: "IMMediate" },
  { id: "trig.lvl", path: ":TRIGger[:SEQuence]:VIDeo:LEVel", kind: "num", units: DB, def: -25, min: -170, max: 30,
    onSet: (m) => m.set("trig", "VIDeo") }, // "Setting the video trigger level switches the source to VIDeo"

  // --- acquisition (docs: "Acquisition and sweep completion")
  { id: "cont", path: ":INITiate:CONTinuous", kind: "bool", def: true },

  // --- trace (docs: "Trace configuration")
  { id: "tr.type", path: ":TRACe<n>:TYPE", kind: "enum", suffixMax: 6, values: ["WRITe", "AVERage", "MAXHold", "MINHold"],
    def: "WRITe", saOnly: true, onSet: () => {} },
  { id: "tr.upd", path: ":TRACe<n>:UPDate:STATe", kind: "bool", suffixMax: 6, def: (i) => i <= 3 },
  { id: "tr.disp", path: ":TRACe<n>:DISPlay:STATe", kind: "bool", suffixMax: 6, def: (i) => i <= 3 },
  { id: "tr.sel", path: ":TRACe:SELect", kind: "int", def: 1, min: 1, max: 6 }, // rejected, not clamped: see rejectOutOfRange
  { id: "avg.count", path: "[:SENSe]:AVERage:COUNt", kind: "int", def: 100, round: true, min: 1 }, // 0 -> 1, 1000 kept
  { id: "avg.type", path: "[:SENSe]:AVERage:TYPE", kind: "enum", values: ["LOG", "VOLTage", "POWEr"], def: "LOG" },
  { id: "fmt", path: ":FORMat", kind: "enum", values: ["ASCii", "REAL32", "REAL64"], def: "ASCii",
    get: () => "ASC8" }, // "the query returns ASC8; the setter needs ASCii"
  { id: "pic", path: ":SYSTem:PICture:FORMat", kind: "enum", values: ["BMP", "PNG"], def: "BMP" },

  // --- markers (docs: "Markers", "Marker functions, N-dB bandwidth and frequency counter")
  { id: "mk.mode", path: ":CALCulate:MARKer<n>:MODE", kind: "enum", suffixMax: 10, values: ["OFF", "POSition", "DELTa", "FIXed"], def: "OFF" },
  { id: "mk.trace", path: ":CALCulate:MARKer<n>:TRACe", kind: "int", suffixMax: 10, def: 1, min: 1, max: 6 },
  { id: "mk.ref", path: ":CALCulate:MARKer<n>:REFerence", kind: "int", suffixMax: 10, def: (i) => (i % 10) + 1, min: 1, max: 10,
    onSet: (m, i) => { if (m.str("mk.mode", i) === "OFF") m.set("mk.mode", "DELTa", i); } },
  { id: "mk.x", path: ":CALCulate:MARKer<n>:X", kind: "num", units: HZ, dp: 10, suffixMax: 10, def: 0 }, // not clamped
  { id: "mk.y", path: ":CALCulate:MARKer<n>:Y", kind: "num", units: NONE, suffixMax: 10, def: -80, get: (m, i) => fmtNum(m.markerLevel(i)) }, // level: ASSUMED stand-in
  { id: "mk.sel", path: ":CALCulate:MARKer:SELect", kind: "int", def: 1, min: 1, max: 10 },
  { id: "pk.thr", path: ":CALCulate:MARKer:PEAK:THReshold", kind: "num", units: DB, def: -70.2, min: -300, max: 30, // "Peak criteria": -70.2 dBm automatic
    onSet: (m) => m.set("pk.thr.auto", false) },
  { id: "pk.thr.auto", path: ":CALCulate:MARKer:PEAK:THReshold:STATe", kind: "bool", def: true },
  { id: "pk.exc", path: ":CALCulate:MARKer:PEAK:EXCursion", kind: "num", units: DB, def: 5.9, min: 0, max: 200, // 5.9 dB automatic
    onSet: (m) => m.set("pk.exc.auto", false) },
  { id: "pk.exc.auto", path: ":CALCulate:MARKer:PEAK:EXCursion:STATe", kind: "bool", def: true },
  { id: "mf.fn", path: ":CALCulate:MARKer<n>:FUNCtion", kind: "enum", suffixMax: 10, values: ["OFF", "NOISe", "BPOWer", "BDENsity"], def: "OFF" },
  { id: "mf.span", path: ":CALCulate:MARKer<n>:FUNCtion:BAND:SPAN", kind: "num", units: HZ, suffixMax: 10, def: 0 },
  { id: "nd.on", path: ":CALCulate:MARKer<n>:BANDwidth:STATe", kind: "bool", suffixMax: 10, def: false },
  { id: "nd.n", path: ":CALCulate:MARKer<n>:BANDwidth:NDB", kind: "num", units: DB, suffixMax: 10, def: -3.01, min: -140, max: -0.01 },
  { id: "nd.res", path: ":CALCulate:MARKer<n>:BANDwidth:RESult", kind: "num", units: HZ, suffixMax: 10, def: 0, get: () => "nan" }, // flat trace never falls N dB
  { id: "fc.on", path: ":CALCulate:MARKer:FCOunt:STATe", kind: "bool", def: false },
  { id: "fc.gate", path: ":CALCulate:MARKer:FCOunt:GATetime", kind: "num", units: SEC, def: 0.1, min: 1e-6, max: 0.5 },
  { id: "fc.x", path: ":CALCulate:MARKer:FCOunt:X", kind: "num", units: HZ, def: 0,
    get: (m) => (m.bool("fc.on") ? "0" : "9.910000000000e+37") },

  // --- limit lines (docs: "Limit lines")
  { id: "ll.disp", path: ":CALCulate:LLINe<n>:DISPlay", kind: "bool", suffixMax: 6, def: false },
  { id: "ll.type", path: ":CALCulate:LLINe<n>:TYPE", kind: "enum", suffixMax: 6, values: ["UPPer", "LOWer"], def: "UPPer" },
  { id: "ll.trace", path: ":CALCulate:LLINe<n>:TRACe", kind: "int", suffixMax: 6, def: (i) => i, min: 1, max: 6 },
  { id: "ll.margin", path: ":CALCulate:LLINe<n>:MARGin", kind: "num", units: DB, suffixMax: 6, def: 0, min: -40, max: 40,
    onSet: (m, i) => m.set("ll.margin.on", true, i) },
  { id: "ll.margin.on", path: ":CALCulate:LLINe<n>:MARGin:STATe", kind: "bool", suffixMax: 6, def: false },

  // --- tracking generator (docs: "Tracking generator")
  { id: "tg.out", path: ":OUTPut:STATe", kind: "bool", def: false, onSet: (m, _i, v) => { if (!v) m.set("tg.ref", false); } },
  { id: "tg.level", path: ":SOURce:POWer", kind: "num", units: DB, def: -30, min: -40, max: 0 },
  { id: "tg.off", path: ":SOURce:CORRection:OFFSet", kind: "num", units: DB, def: 0, min: -200, max: 200 },
  { id: "tg.ref", path: ":SOURce:TRACe:REFerence:STATe", kind: "bool", def: false,
    onSet: (m, _i, v) => { if (v && !m.bool("tg.out")) m.set("tg.ref", false); } }, // only takes while the output is on
  { id: "tg.nt", path: ":CALCulate:NTData:STATe", kind: "bool", def: false },

  // --- status
  { id: "ese", path: "*ESE", kind: "int", def: 0 },
  { id: "sre", path: "*SRE", kind: "int", def: 0 },
];

// ---------------------------------------------------------------- measurement modes (#150)

type MeasCode = "CHPower" | "TPOWer" | "OBWidth" | "ACPower" | "TOI" | "CNRatio" | "HARMonics";
const MEAS_PRESET_SPAN: Record<MeasCode, number> = {
  CHPower: 3e6, // "took span 3.59 GHz to 3 MHz"
  TPOWer: 0, // "gives zero span"
  OBWidth: 3e6, // ASSUMED (not documented)
  ACPower: 10e6, // "ACPR 10 MHz"
  TOI: 8e6, // "TOI 8 MHz at the same center"
  CNRatio: 3e6, // ASSUMED
  HARMonics: 3e6, // "harmonics around the center": exact span ASSUMED
};
const MEAS_CODES = Object.keys(MEAS_PRESET_SPAN) as MeasCode[];

/** Measurement specific parameters; `m.<code>.` ids are reset by every :CONFigure:<code> (the preset). Defaults: docs "Parameter behavior" / "Parameters read back as set". */
function measSpecs(): Spec[] {
  const out: Spec[] = [];
  const add = (code: MeasCode, id: string, path: string, rest: Omit<Spec, "id" | "path" | "mode">) => out.push({ id: `m.${code}.${id}`, path: `[:SENSe]:${code}:${path}`, mode: code, ...rest });
  for (const code of MEAS_CODES) {
    // averaging exists in every measurement; the defaults are only documented for channel power (10 averages, on, POWEr, EXPonential), the others ASSUMED the same
    add(code, "avg", "AVERage:STATe", { kind: "bool", def: true });
    add(code, "avg.count", "AVERage:COUNt", { kind: "int", def: 10, round: true, min: 1 }); // 5000 was accepted (manual: 1-999), so no upper clamp
    add(code, "avg.type", "AVERage:TYPE", { kind: "enum", values: ["VOLTage", "POWEr", "LOG"], def: "POWEr" });
    add(code, "avg.tctl", "AVERage:TCONtrol", { kind: "enum", values: ["EXPonential", "REPeat"], def: "EXPonential" });
  }
  add("CHPower", "ibw", "BANDwidth:INTegration", { kind: "num", units: HZ, def: 2e6, min: 100, max: 3.61e9 }); // "clamps to 100 Hz-3.61 GHz"
  add("TPOWer", "llim", "LLIMit", { kind: "num", units: SEC, def: 0, min: 0, max: 0.01 }); // max ASSUMED like the right limit
  add("TPOWer", "rlim", "RLIMit", { kind: "num", units: SEC, def: 0.01, min: 0, max: 0.01 }); // "clamped to 10 ms"
  add("OBWidth", "pct", "PERCent", { kind: "num", units: NONE, def: 0.99, min: 1e-4, max: 0.9999 }); // min ASSUMED
  add("OBWidth", "xdb", "XDB", { kind: "num", units: DB, def: -26, min: -100, max: -0.1 }); // "5 clamps to -0.1"; min from the manual
  add("ACPower", "ibw", "BANDwidth:INTegration", { kind: "num", units: HZ, def: 2e6, min: 1 }); // "preset 2 MHz"; clamping not probed
  add("ACPower", "carrier", "CARRier:LIST:BANDwidth", { kind: "num", units: HZ, def: 2e6, min: 1 });
  add("ACPower", "offset", "OFFSet:LIST:FREQuency", { kind: "num", units: HZ, def: 3e6, min: 0 });
  add("ACPower", "side", "OFFSet:LIST:SIDE", { kind: "enum", values: ["BOTH", "NEGative", "POSitive"], def: "BOTH" });
  add("CNRatio", "ibw", "BANDwidth:INTegration", { kind: "num", units: HZ, def: 2e6, min: 1 });
  add("CNRatio", "noise", "BANDwidth:NOISe", { kind: "num", units: HZ, def: 2e6, min: 1 });
  add("CNRatio", "offset", "OFFSet", { kind: "num", units: HZ, def: 2e6, min: 0 });
  add("HARMonics", "fund", "FREQuency:FUNDamental", { kind: "num", units: HZ, def: 1.805e9, min: 0 }); // preset = the center (set on entering)
  add("HARMonics", "num", "NUMBer", { kind: "int", def: 2, round: true, min: 2, max: 10 }); // range from the manual, clamp ASSUMED
  add("HARMonics", "swt", "SWEeptime", { kind: "num", units: SEC, def: 0.1, min: 0.001, max: 100 }); // range from the manual, clamp ASSUMED
  return out;
}
SPECS.push(...measSpecs());

/** Noise-floor level of every measurement result: "noise floor around -74 dBm / -137 dBm/Hz with 3 MHz span and no signal". */
const FLOOR_DBM = -74;

interface ResultSpec { mode: MeasCode; path: string; read: boolean; values: (m: UtsModel) => number[]; spaced?: boolean }
const nanIf = (cond: boolean, v: number[]) => (cond ? v.map(() => NaN) : v);
const RESULTS: ResultSpec[] = [
  // channel power: two values (power, density); density follows the integration bandwidth (-74 - 63 = -137 dBm/Hz at 2 MHz)
  { mode: "CHPower", path: "CHPower", read: true, values: (m) => [FLOOR_DBM, FLOOR_DBM - 10 * Math.log10(m.num("m.CHPower.ibw"))] },
  { mode: "TPOWer", path: "TPOWer", read: true, values: () => [FLOOR_DBM] }, // one value; the number is ASSUMED
  // OBW: seven values, "order not as documented" (ASSUMED: the four the tools use first, then three placeholders); sub-results one value each; READ sub-forms get no reply
  { mode: "OBWidth", path: "OBWidth", read: true, values: () => [2.5e6, 0, 2e6, FLOOR_DBM, 0, 0, 0] }, // numbers ASSUMED
  { mode: "OBWidth", path: "OBWidth:OBWidth", read: false, values: () => [2.5e6] },
  { mode: "OBWidth", path: "OBWidth:FERRor", read: false, values: () => [0] },
  { mode: "OBWidth", path: "OBWidth:XDB", read: false, values: () => [2e6] },
  { mode: "OBWidth", path: "OBWidth:APOWr", read: false, values: () => [FLOOR_DBM] },
  // ACPR: three values (main dBm, lower dBc, upper dBc), MAIN one, LOWer/UPPer (dBm, dBc); a side that is not measured reads nan
  { mode: "ACPower", path: "ACPower", read: true, values: (m) => [FLOOR_DBM, ...nanIf(m.acprSide() === "POSitive", [-1]), ...nanIf(m.acprSide() === "NEGative", [-1])] }, // -75 dBm / -1 dBc ASSUMED
  { mode: "ACPower", path: "ACPower:MAIN", read: false, values: () => [FLOOR_DBM] },
  { mode: "ACPower", path: "ACPower:LOWer", read: false, values: (m) => nanIf(m.acprSide() === "POSitive", [FLOOR_DBM - 1, -1]) },
  { mode: "ACPower", path: "ACPower:UPPer", read: false, values: (m) => nanIf(m.acprSide() === "NEGative", [FLOOR_DBM - 1, -1]) }, // nan for NEGative ASSUMED symmetric
  { mode: "CNRatio", path: "CNRatio", read: true, values: () => [FLOOR_DBM, FLOOR_DBM - 1, 1] }, // carrier, noise, C/N; numbers ASSUMED
  // TOI: TRD four values (frequency, amplitude, dBc, TOI), TONE two; :FETCh:TOI:IPT? is NOT answered (gets no reply, -113); numbers ASSUMED
  { mode: "TOI", path: "TOI:LOW:TRD", read: true, values: (m) => [m.num("fc") - 3e6, -90, -16, -55] },
  { mode: "TOI", path: "TOI:UP:TRD", read: false, values: (m) => [m.num("fc") + 3e6, -90, -16, -55] },
  { mode: "TOI", path: "TOI:LOW:TONE", read: false, values: (m) => [m.num("fc") - 1e6, FLOOR_DBM] },
  { mode: "TOI", path: "TOI:UP:TONE", read: false, values: (m) => [m.num("fc") + 1e6, FLOOR_DBM] },
  // harmonics: both lists always hold 10 values with trailing spaces; the first NUMBer are results (fundamental counts), the rest
  // placeholders (+|fundamental| dBc, frequency 0 ASSUMED)
  {
    mode: "HARMonics", path: "HARMonics:AMPLitude:ALL", read: true, spaced: true,
    values: (m) => Array.from({ length: 10 }, (_, i) => (i === 0 ? FLOOR_DBM : i < m.num("m.HARMonics.num") ? -60 - 5 * (i - 1) : -FLOOR_DBM)), // dBc of the harmonics ASSUMED
  },
  {
    mode: "HARMonics", path: "HARMonics:FREQuency:ALL", read: false, spaced: true,
    values: (m) => Array.from({ length: 10 }, (_, i) => (i < m.num("m.HARMonics.num") ? (i + 1) * m.num("m.HARMonics.fund") : 0)),
  },
  { mode: "HARMonics", path: "HARMonics:DISTortion", read: false, values: () => [0.1, -60] }, // THD % and dBc ASSUMED
];
const compiledResults = RESULTS.map((r) => ({ ...r, nodes: parsePath(r.path) }));

/** Commands without a value and without a query, with their effect. */
const ACTIONS: Array<{ path: string; run: (m: UtsModel, idx: number[]) => void }> = [
  { path: ":FREQuency:SPAN:FULL", run: (m) => { m.set("span", FULL_STOP - FULL_START); m.set("fc", (FULL_START + FULL_STOP) / 2); m.spanChanged(); } },
  { path: ":FREQuency:SPAN:ZERO", run: (m) => { m.set("span", 0); m.spanChanged(); } },
  { path: ":INITiate:IMMediate", run: (m) => m.startSweep() },
  { path: ":INITiate:RESTart", run: (m) => m.startSweep() },
  { path: ":CALCulate:MARKer:AOFF", run: (m) => { for (let n = 1; n <= 10; n++) m.set("mk.mode", "OFF", n); } },
  { path: ":CALCulate:MARKer<n>:MAXimum", run: (m, [n]) => m.search(n!) },
  { path: ":CALCulate:MARKer<n>:MAXimum:NEXT", run: (m, [n]) => m.search(n!) },
  { path: ":CALCulate:MARKer<n>:MAXimum:LEFT", run: (m, [n]) => m.search(n!) },
  { path: ":CALCulate:MARKer<n>:MAXimum:RIGHt", run: (m, [n]) => m.search(n!) },
  { path: ":CALCulate:MARKer<n>:MINimum", run: (m, [n]) => m.search(n!) },
  { path: ":CALCulate:MARKer<n>:PTPeak", run: (m, [n]) => { m.search(n!); m.set("mk.mode", "DELTa", n!); } },
  { path: ":CALCulate:MARKer<n>:SET:CENTer", run: (m, [n]) => { m.set("fc", m.num("mk.x", n!)); m.spanChanged(); } },
  { path: ":CALCulate:MARKer<n>:SET:STEP", run: (m, [n]) => { m.set("step", m.num("mk.x", n!)); m.set("step.auto", false); } },
  { path: ":CALCulate:MARKer<n>:SET:STARt", run: (m, [n]) => { m.set("start", m.num("mk.x", n!)); m.edgeChanged(); } },
  { path: ":CALCulate:MARKer<n>:SET:STOP", run: (m, [n]) => { m.set("stop", m.num("mk.x", n!)); m.edgeChanged(); } },
  { path: ":CALCulate:MARKer<n>:SET:RLEVel", run: (m, [n]) => { m.set("rl", m.markerLevel(n!)); m.refChanged(); } },
  { path: ":CALCulate:LLINe<n>:DELete", run: (m, [n]) => m.limitPoints.delete(n!) },
  { path: ":CALCulate:LLINe:ALL:DELete", run: (m) => m.limitPoints.clear() },
  { path: ":CONFigure:SANalyzer", run: (m) => { m.mode = "SA"; } }, // does NOT undo the span ("returns to spectrum analyzer mode with the span still at 3 MHz")
  ...MEAS_CODES.flatMap((code) => [
    { path: `:CONFigure:${code}`, run: (m: UtsModel) => m.enter(code) },
    { path: `:CONFigure:${code}:NDEFault`, run: (m: UtsModel) => m.enter(code) }, // "same effect here"
  ]),
  { path: "*CLS", run: (m) => m.clearErrors() },
  { path: "*OPC", run: () => {} },
];

/** Headers the instrument rejects with -113 even though they look right (verified: "Trace configuration"). */
const compiled = SPECS.map((spec) => ({ spec, nodes: parsePath(spec.path) }));
const compiledActions = ACTIONS.map((a) => ({ ...a, nodes: parsePath(a.path) }));

/** Scientific notation as the instrument prints it: six decimals, two-digit exponent (`-6.112838e+01`). */
function sci(v: number, dp = 6): string {
  let text = v.toExponential(dp);
  for (let d = dp + 1; d <= 15 && Number(text) !== v; d++) text = v.toExponential(d); // keep what a fixed-decimal print would lose
  return text.replace(/e([+-])(\d)$/, "e$10$2");
}

/**
 * A numeric reply as the real analyzer prints it ("Reply format", issue #147): scientific notation, and a space
 * where a minus sign would be, so a value that is not negative ends with a trailing space.
 */
function fmtNum(v: number, dp = 6): string {
  const text = sci(v, dp);
  return text.startsWith("-") ? text : text + " ";
}

/** Queries answered without a table entry. A switch, so input-derived text never selects a function to call. */
function privateQuery(header: string, m: UtsModel): string | undefined {
  switch (header) {
    case "*IDN?": return "UNI-TREND,UTS3036B,SN000000,V1.04.0040"; // serial deliberately not recorded in the repo
    case "*OPC?": return "1";
    case "*ESR?": return "0";
    case "*STB?": return "0";
    case "*ESE?": return String(m.num("ese"));
    case "*SRE?": return String(m.num("sre"));
    case ":INSTrument:SELect?".toUpperCase(): return "SA";
    default: return undefined;
  }
}


interface PendingError { code: number; text: string; at: number }

export class UtsModel {
  private values = new Map<string, V>();
  private errors: PendingError[] = [];
  private busyUntil = 0; // single sweep: ignoring commands (raw) or queueing (vxi11) until then
  private stallUntil = 0; // unsupported query stall
  private queued: string[] = [];
  readonly limitPoints = new Map<number, number[]>();
  /** Every line received, including dropped ones. */
  readonly received: string[] = [];
  /** Lines dropped while the instrument ignored commands. */
  readonly dropped: string[] = [];
  readonly tgSweepScale: number;
  /** Active measurement; no query reports it (docs "Measurements"). */
  mode: "SA" | MeasCode = "SA";
  private lose = new Map<string, number>();
  private readonly now: () => number;
  readonly transport: "raw" | "vxi11";

  constructor(options: ModelOptions = {}) {
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? "raw";
    this.tgSweepScale = options.tgSweepScale ?? 1;
  }

  // ---- state access
  private key(id: string, idx = 0) { return idx ? `${id}#${idx}` : id; }
  private spec(id: string) { return compiled.find((c) => c.spec.id === id)!.spec; }
  get(id: string, idx = 0): V {
    const k = this.key(id, idx);
    if (this.values.has(k)) return this.values.get(k)!;
    const def = this.spec(id).def;
    return typeof def === "function" ? def(idx) : def!;
  }
  set(id: string, v: V, idx = 0): void { this.values.set(this.key(id, idx), v); }
  num(id: string, idx = 0): number { return this.get(id, idx) as number; }
  bool(id: string, idx = 0): boolean { return this.get(id, idx) as boolean; }
  str(id: string, idx = 0): string { return this.get(id, idx) as string; }
  /** Current sweep time in seconds (for tests). */
  get sweepTimeS(): number { return sweepTimeS(this); }
  /** True while a single sweep is running. */
  get sweeping(): boolean { return this.now() < this.busyUntil; }
  /** ms until the end of the sweep or stall (0 when idle). */
  get busyForMs(): number { return Math.max(0, this.busyUntil - this.now(), this.stallUntil - this.now()); }

  /** Test hook: silently drop the next `times` setters of parameter `id` (no error), like the lost span setter of #133. */
  loseNext(id: string, times = 1): void { this.lose.set(id, times); }
  acprSide(): string { return this.str("m.ACPower.side"); }
  /** `:CONFigure:<meas>`: presets the span (center unchanged) and the measurement's parameters; auto RBW follows the span. */
  enter(code: MeasCode): void {
    this.mode = code;
    for (const k of [...this.values.keys()]) if (k.startsWith(`m.${code}.`)) this.values.delete(k);
    if (code === "HARMonics") this.set("m.HARMonics.fund", this.num("fc"));
    this.set("span", MEAS_PRESET_SPAN[code]);
    this.spanChanged();
    this.autoBandwidth();
  }

  // ---- couplings (docs: "Amplitude", "Bandwidth, sweep, detector and trigger")
  /** The center was set: the span shrinks to stay inside the range (center 100 kHz -> span 200 kHz; verified, "Frequency"). */
  centerChanged(): void { this.spanChanged(); }
  /**
   * The span was set: it is capped at the maximum frequency and the CENTER moves to keep start >= 0 and stop <= the
   * maximum (verified #147: center 1 GHz, span 10 GHz -> span 3.61 GHz, center 1.805 GHz; span 3 GHz at 1 GHz -> center 1.5 GHz).
   */
  spanSet(): void {
    const s = Math.min(this.num("span"), MAX_FREQ);
    const c = Math.min(MAX_FREQ - s / 2, Math.max(s / 2, this.num("fc")));
    this.set("span", s);
    this.set("fc", c);
    this.set("start", c - s / 2);
    this.set("stop", c + s / 2);
  }
  spanChanged(): void {
    // The span shrinks when it would reach outside the range ("Live check": center 100 kHz is accepted but the span
    // shrinks). The exact rule is not documented; ASSUMED here: start >= 0 and stop <= the maximum frequency.
    const c = this.num("fc");
    const s = Math.min(this.num("span"), 2 * c, 2 * (MAX_FREQ - c));
    this.set("span", s);
    this.set("start", c - s / 2);
    this.set("stop", c + s / 2);
  }
  edgeChanged(): void {
    let a = this.num("start"), b = this.num("stop");
    if (a > b) { if (this.lastEdge === "start") a = b; else b = a; this.set("start", a); this.set("stop", b); }
    this.set("span", b - a);
    this.set("fc", (a + b) / 2);
  }
  private lastEdge = "start";
  refChanged(): void {
    if (this.bool("att.auto")) {
      // "attenuation follows the reference level (0 dBm -> 10 dB, -30 dBm -> 0 dB), preamp on raised it from 10 to 30"
      this.set("att", Math.min(51, Math.max(0, Math.round(this.num("rl") + 10 + (this.bool("preamp") ? 20 : 0)))));
    }
  }
  refLevelInUnit(): number {
    const dbm = this.num("rl") + this.num("rl.off");
    switch (this.str("unit")) {
      case "DBMV": return dbm + 46.9897; // "-10 dBm -> 36.9897 dBmV"
      case "DBUV": return dbm + 106.9897;
      case "V": return Math.sqrt(10 ** (dbm / 10) * 1e-3 * 50);
      case "W": return 10 ** (dbm / 10) * 1e-3;
      default: return dbm;
    }
  }
  autoBandwidth(): void {
    // spectrum analyzer: 3 MHz at every span (the verified default); in a measurement the auto RBW follows the span ("RBW and sweep time follow because they are auto"), rule ASSUMED
    if (this.bool("rbw.auto")) this.set("rbw", this.mode === "SA" || this.num("span") === 0 ? 3e6 : Math.min(3e6, snap13(this.num("span") / 100)));
    this.vbwFollow();
  }
  vbwFollow(): void {
    if (this.bool("vbw.auto")) this.set("vbw", Math.min(3e6, snap13(this.num("rbw") * this.num("ratio"))));
  }
  markerLevel(idx: number): number {
    const x = this.num("mk.x", idx), a = this.num("start"), b = this.num("stop");
    const i = b > a ? Math.min(traceValues.length - 1, Math.max(0, Math.round(((x - a) / (b - a)) * (traceValues.length - 1)))) : 0;
    return traceValues[i]!;
  }
  search(idx: number): void {
    // A search turns an off marker on and puts it on the fixture trace maximum ("Markers").
    if (this.str("mk.mode", idx) === "OFF") this.set("mk.mode", "POSition", idx);
    let best = 0;
    traceValues.forEach((v, i) => { if (v > traceValues[best]!) best = i; });
    const a = this.num("start"), b = this.num("stop");
    this.set("mk.x", a + ((b - a) * best) / (traceValues.length - 1), idx);
  }
  startSweep(): void {
    // "A single sweep takes the sweep time"; in continuous mode INITiate is accepted without effect.
    if (!this.bool("cont")) this.busyUntil = this.now() + this.sweepTimeS * 1000;
  }

  // ---- error queue (docs: "Command timing and error queue")
  private post(code: number, text: string, delayMs = 0): void {
    this.errors.push({ code, text, at: this.now() + delayMs });
  }
  clearErrors(): void {
    // `*CLS` clears what is in the queue; a late -113 still arrives afterwards (issue #47).
    const t = this.now();
    this.errors = this.errors.filter((e) => e.at > t);
  }
  /** Errors queued (visible or not), for tests. */
  get pendingErrors(): readonly PendingError[] { return this.errors; }

  // ---- line handling
  /**
   * Handle one line received now. Returns the replies to write (without terminator handling: text gets CRLF
   * from the caller), or an empty array when the instrument is silent.
   */
  handleLine(line: string): Out[] {
    this.received.push(line);
    const t = this.now();
    if (this.sweeping) {
      if (this.transport === "vxi11") { this.queued.push(line); return []; }
      this.dropped.push(line); // "Every line sent during the sweep is dropped, not queued"
      return [];
    }
    if (t < this.stallUntil) { this.dropped.push(line); return []; } // "stops responding for about 2.15 s"
    return this.process(line);
  }

  /** VXI-11 only: replies to lines that were queued during a sweep, once it has ended. */
  drainQueued(): Out[] {
    if (this.sweeping) return [];
    const out: Out[] = [];
    for (const line of this.queued.splice(0)) out.push(...this.handleLine(line));
    return out;
  }

  private process(raw: string): Out[] {
    const line = raw.trim();
    if (line === "") return [];
    const sp = line.search(/\s/);
    const header = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const args = sp < 0 ? "" : line.slice(sp).trim();
    if (header.endsWith("?")) return this.query(header.slice(0, -1), args, line);
    return this.command(header, args);
  }

  private unsupportedQuery(): Out[] {
    // "no reply, stalls ~2.15 s, posts -113 about 4 s later"
    this.stallUntil = this.now() + STALL_MS;
    this.post(-113, "Undefined header", LATE_ERROR_MS);
    return [];
  }

  private resolve(header: string): { spec: Spec; idx: number[] } | null {
    const nodes = header.replace(/^:/, "").split(":");
    for (const c of compiled) {
      const idx = matchNodes(c.nodes, nodes);
      if (idx) return { spec: c.spec, idx };
    }
    return null;
  }
  private resolveAction(header: string): { run: (m: UtsModel, idx: number[]) => void; idx: number[] } | null {
    const nodes = header.replace(/^:/, "").split(":");
    for (const c of compiledActions) {
      const idx = matchNodes(c.nodes, nodes);
      if (idx) return { run: c.run, idx };
    }
    return null;
  }

  private query(header: string, args: string, line: string): Out[] {
    const special = privateQuery(header + "?", this);
    if (special !== undefined) return [{ text: special }];
    if (/^:SYST(EM)?:ERR(OR)?$/.test(header)) return [{ text: this.nextError() }];
    if (/^:(TRAC|TRACE):DATA$/.test(header)) return this.traceData(args);
    if (/^:DISP(LAY)?:(ZBMP|ZBM|DATA)$/.test(header)) return this.screenshot(header);
    const sys = /^:SYST(EM)?:ERR(OR)?:?/.test(header);
    if (sys) return this.unsupportedQuery();
    // limit line data (docs: "Limit lines"): triplets sorted by frequency, first connect 1; silent when empty
    const ll = /^:CALC(ULATE)?:LLIN(E)?(\d+):DATA$/.exec(header);
    if (ll) {
      const n = Number(ll[3]);
      const pts = this.limitPoints.get(n);
      if (n < 1 || n > 6 || !pts || pts.length === 0) return n >= 1 && n <= 6 ? [] : this.unsupportedQuery();
      return [{ text: pts.map((v) => sci(v)).join(",") }];
    }
    const result = /^:(FETC|FETCH|READ):(.+)$/.exec(header);
    if (result) return this.results(result[1] === "READ", result[2]!);
    const r = this.resolve(header);
    if (!r) return this.unsupportedQuery();
    const { spec, idx } = r;
    const n = idx[0] ?? 0;
    if (spec.suffixMax !== undefined && (n < 1 || n > spec.suffixMax)) return this.unsupportedQuery();
    // "[:SENSe]:<meas>:AVERage:STATe? answers only while that measurement is active", detector/trace type only in SA mode
    if ((spec.mode !== undefined && spec.mode !== this.mode) || (spec.saOnly && this.mode !== "SA") || spec.silentWhen?.(this)) return this.unsupportedQuery();
    void line;
    if (spec.get) return [{ text: spec.get(this, n) }];
    const v = this.get(spec.id, n);
    if (spec.kind === "bool") return [{ text: v ? "1" : "0" }];
    if (spec.kind === "enum") return [{ text: spec.upper ? String(v).toUpperCase() : String(v) }];
    if (spec.kind === "int") return [{ text: String(v) }];
    return [{ text: fmtNum(v as number, spec.dp) }];
  }

  /** `:FETCh:<path>?` / `:READ:<path>?` of the active measurement; anything else gets no reply. */
  private results(read: boolean, path: string): Out[] {
    const nodes = path.split(":");
    const hit = compiledResults.find((c) => c.mode === this.mode && matchNodes(c.nodes, nodes));
    if (!hit || (read && !hit.read)) return this.unsupportedQuery(); // "the READ sub-forms get no reply"
    const text = hit.values(this).map((v) => (Number.isNaN(v) ? "nan" : sci(v)) + (hit.spaced ? " " : "")).join(",");
    // "READ has no line terminator over raw TCP: the reply ends with a space"; FETCh ends with CRLF (added by the caller)
    if (read) return this.transport === "raw" ? [{ bytes: Buffer.from(text + " ", "latin1") }] : [{ text: text + " " }];
    return [{ text }];
  }

  private nextError(): string {
    const t = this.now();
    const i = this.errors.findIndex((e) => e.at <= t);
    if (i < 0) return '0,"No error"';
    const [e] = this.errors.splice(i, 1);
    return `${e!.code},"${e!.text}"`;
  }

  private command(header: string, args: string): Out[] {
    // trace math is write only ("Trace configuration"); limit data and trace data have their own parsers
    const ll = /^:CALC(ULATE)?:LLIN(E)?(\d+):DATA$/.exec(header);
    if (ll) { this.limitData(Number(ll[3]), args); return []; }
    if (/^:CALC(ULATE)?:MATH$/.test(header)) { this.math(args); return []; }
    const action = this.resolveAction(header);
    if (action) { action.run(this, action.idx); return []; }
    const r = this.resolve(header);
    if (!r) { this.post(-113, "Undefined header"); return []; }
    const { spec, idx } = r;
    const n = idx[0] ?? 0;
    if (spec.suffixMax !== undefined && (n < 1 || n > spec.suffixMax)) { this.post(-108, "Parameter not allowed"); return []; }
    if (spec.mode !== undefined && spec.mode !== this.mode) { this.post(-113, "Undefined header"); return []; } // "wrong-mode parameter setters give -113"
    const lost = this.lose.get(spec.id) ?? 0;
    if (lost > 0) { this.lose.set(spec.id, lost - 1); return []; } // fault injection
    if (args === "") { this.post(-109, "Missing parameter"); return []; }
    const parsed = this.parseValue(spec, args);
    if (parsed === undefined) return [];
    let v = parsed;
    if (spec.kind === "num" || spec.kind === "int") {
      v = Number(v);
      if (spec.id === "tr.sel" || spec.id === "mk.trace" || spec.id === "ll.trace" || spec.id === "mk.ref" || spec.id === "mk.sel") {
        // rejected, not clamped (-224, old value stays) for trace select, marker trace/reference; limit line trace is ignored silently
        if (spec.id === "ll.trace") { if (v < 1 || v > 6) return []; }
        else if (spec.id === "tr.sel" && v > spec.max!) return []; // verified #147: 7 and 9 are ignored without an error (0 gives -224)
        else if (!(v >= spec.min! && v <= spec.max!) || (spec.id === "mk.ref" && v === n)) { this.post(-224, "Illegal parameter value"); return []; }
      }
      if (spec.round) v = Math.round(v as number);
      if (spec.trunc) v = Math.trunc(v as number);
      if (spec.id === "avg.count" && (v as number) < 1) v = 1;
      v = norm(v as number, spec.id === "avg.count" ? undefined : spec.max, spec.min);
    }
    if (spec.id === "trig" && v === "EXTernal") { this.post(-224, "Illegal parameter value"); return []; }
    if (spec.id === "start") this.lastEdge = "start";
    if (spec.id === "stop") this.lastEdge = "stop";
    this.set(spec.id, v as V, n);
    spec.onSet?.(this, n, v as V);
    return [];
  }

  /** Parse a setter argument; undefined = rejected (error queued). */
  private parseValue(spec: Spec, args: string): V | undefined {
    const text = args.trim();
    if (spec.kind === "bool") {
      const u = text.toUpperCase();
      if (u === "ON" || u === "1") return true;
      if (u === "OFF" || u === "0") return false;
      this.post(-224, "Illegal parameter value");
      return undefined;
    }
    if (spec.kind === "enum") {
      const u = text.toUpperCase();
      const found = spec.values!.find((val) => {
        const long = val.toUpperCase();
        const short = /^[A-Z0-9]+/.exec(val)![0].toUpperCase();
        return u === long || u === short;
      });
      if (!found) {
        // verified #147: an unknown enum word posts -224 twice (MODE, UNIT, TRACe TYPE and DETector all did)
        this.post(-224, "Illegal parameter value");
        this.post(-224, "Illegal parameter value");
        return undefined;
      }
      return found;
    }
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z]*)$/.exec(text);
    if (!m) { this.post(-224, "Illegal parameter value"); return undefined; }
    const suffix = m[2]!.toUpperCase();
    let factor = 1;
    if (suffix !== "") {
      const f = spec.units !== undefined && Object.hasOwn(spec.units, suffix) ? spec.units[suffix] : undefined;
      if (f === undefined) {
        this.post(-224, "Illegal parameter value"); // "`:FREQuency:CENTer 1 XYZ` gives -224 plus -131"
        this.post(-131, "Invalid suffix");
        return undefined;
      }
      factor = f;
    }
    return Number(m[1]) * factor;
  }

  private limitData(n: number, args: string): void {
    if (n < 1 || n > 6) { this.post(-108, "Parameter not allowed"); return; }
    const nums = args.split(",").map((s) => Number(s.trim()));
    if (nums.length % 3 !== 0 || nums.some((x) => Number.isNaN(x))) { this.post(-200, "Execution error"); return; }
    if (nums.length / 3 > 10) return; // "At most 10 points: a longer list is silently ignored"
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < nums.length; i += 3) pts.push([nums[i]!, nums[i + 1]!, nums[i + 2]!]);
    pts.sort((a, b) => a[0] - b[0]);
    if (pts[0]) pts[0][2] = 1; // first point always connect 1
    this.limitPoints.set(n, pts.flat());
    this.set("ll.disp", true, n); // "setting :DATA turns :DISPlay on"
  }

  private math(args: string): void {
    // `:CALCulate:MATH TRACEn,OP,TRACEa,TRACEb,offset`; OFF without operands is rejected, offset limited ("Trace configuration")
    const p = args.split(",").map((s) => s.trim().toUpperCase());
    const trace = /^TRACE([1-6])$/.exec(p[0] ?? "");
    if (!trace) { this.post(-224, "Illegal parameter value"); return; }
    const ops = ["PDIF", "PDIFFERENCE", "PSUM", "LDIF", "LDIFFERENCE", "LOFF", "LOFFSET"];
    if (p[1] === "OFF") { if (p.length <= 2) this.post(-224, "Illegal parameter value"); return; } // OFF alone is rejected; the tool sends operands
    if (!ops.includes(p[1] ?? "")) { this.post(-108, "Parameter not allowed"); return; }
    if (p.length < 5 || Math.abs(Number(p[4])) > 100) { this.post(p.length < 5 ? -109 : -224, p.length < 5 ? "Missing parameter" : "Illegal parameter value"); return; } // offset limit ASSUMED
    // "Enabling math on a trace switches that trace on"
    const n = Number(trace[1]);
    this.set("tr.upd", true, n);
    this.set("tr.disp", true, n);
  }

  // ---- big replies
  private traceData(args: string): Out[] {
    const m = /^TRACE([1-6])$/i.exec(args.trim());
    if (!m) { this.post(-224, "Illegal parameter value"); return []; }
    const points = this.num("pts");
    const fmt = this.str("fmt");
    if (points === 1001) {
      // replayed byte for byte from the capture (tests/fixtures/p2)
      if (fmt === "REAL32") return [{ bytes: fixtureReal32 }];
      if (fmt === "REAL64") return [{ bytes: fixtureReal64 }];
      return [{ bytes: Buffer.from(fixtureText, "latin1") }];
    }
    const values = Array.from({ length: points }, (_, i) => traceValues[i % traceValues.length]!);
    if (fmt === "ASCii") return [{ bytes: Buffer.from(values.map((v) => sci(v)).join(",") + "\r\n", "latin1") }];
    const size = fmt === "REAL32" ? 4 : 8;
    const body = Buffer.alloc(points * size);
    values.forEach((v, i) => (size === 4 ? body.writeFloatBE(v, i * 4) : body.writeDoubleBE(v, i * 8)));
    return [{ bytes: Buffer.concat([Buffer.from(`#4${String(body.length).padStart(4, "0")}`), body, Buffer.from("\r\n")]) }];
  }

  private screenshot(header: string): Out[] {
    // "Over raw TCP only 144,800 bytes ever arrive" (issue #42); the header is the capture's. ASSUMED: the rest is zero fill.
    void header;
    const full = Buffer.concat([screenshotHeader, Buffer.alloc(RAW_BLOCK_LIMIT)]);
    return [{ bytes: full.subarray(0, RAW_BLOCK_LIMIT) }];
  }
}

// ---------------------------------------------------------------- TCP server

export interface FakeUts {
  port: number;
  model: UtsModel;
  sockets: Set<net.Socket>;
  close(): Promise<void>;
}

/** Raw SCPI over TCP on 127.0.0.1 (random port) in front of a UtsModel. */
export async function startFakeUts(options: ModelOptions = {}): Promise<FakeUts> {
  const model = new UtsModel(options);
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    const write = (outs: Out[]) => {
      for (const o of outs) if (!socket.destroyed) socket.write("text" in o ? o.text + "\r\n" : o.bytes);
    };
    const pump = () => {
      if (!model.sweeping) write(model.drainQueued());
      else {
        const timer = setTimeout(() => { timers.delete(timer); pump(); }, model.busyForMs + 1);
        timers.add(timer);
      }
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        write(model.handleLine(line));
        if (model.transport === "vxi11" && model.sweeping) pump();
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    model,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
