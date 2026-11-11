import { describe, it, expect } from "vitest";
import { UtsModel, type Out } from "../fakeUts.js";

/**
 * Measurement modes of the fake UTS (#150). Every behavior asserted here comes from docs/verified-hardware.md,
 * "Measurements: channel power, time-domain power, OBW" and "Measurements: ACPR, TOI, C/N, harmonics";
 * values that section does not give are ASSUMED in the fake and only checked for shape here.
 */
function rig(options: ConstructorParameters<typeof UtsModel>[0] = {}) {
  let t = 1_000_000;
  const model = new UtsModel({ now: () => t, ...options });
  const show = (o: Out) => ("text" in o ? o.text : o.bytes.toString("latin1"));
  return {
    model,
    advance: (ms: number) => (t += ms),
    send: (line: string) => model.handleLine(line),
    /** The raw reply text including framing: text replies get CRLF from the TCP layer. */
    raw: (line: string) => model.handleLine(line).map((o) => ("text" in o ? o.text + "\r\n" : show(o))).join(""),
    ask: (line: string) => model.handleLine(line).map(show)[0],
    nums: (line: string) => model.handleLine(line).map(show).join("").split(",").map((s) => Number(s.trim())),
    err: () => model.handleLine(":SYSTem:ERRor?").map(show)[0],
    /** Wait out the stall and the late -113 of an unanswered query, then drop the errors. */
    settle() { t += 5000; model.handleLine("*CLS"); while (!/^0,/.test(this.err()!)) { /* drain */ } },
  };
}

describe("entering a measurement (docs: Measurements, #18)", () => {
  it("starts in spectrum analyzer mode: the detector query answers, the measurement's average state does not", () => {
    const r = rig();
    expect(r.ask(":SENSe:DETector:TRACe1?")).toBe("NORMal");
    expect(r.ask(":SENSe:CHPower:AVERage:STATe?")).toBeUndefined();
  });
  it(":CONFigure:CHPower takes the span to 3 MHz and leaves the center", () => {
    const r = rig();
    r.send(":FREQuency:CENTer 1 GHz");
    r.send(":CONFigure:CHPower");
    expect(r.ask(":FREQuency:SPAN?")).toBe("3.0000000000e+06 ");
    expect(r.ask(":FREQuency:CENTer?")).toBe("1.0000000000e+09 ");
    expect(r.err()).toBe('0,"No error"');
  });
  it("presets: ACPR 10 MHz, TOI 8 MHz, TPOWer zero span; :NDEFault has the same effect as the preset", () => {
    for (const [cmd, span] of [[":CONFigure:ACPower", "1.0000000000e+07 "], [":CONFigure:TOI", "8.0000000000e+06 "], [":CONFigure:CHPower:NDEFault", "3.0000000000e+06 "]] as const) {
      const r = rig();
      r.send(cmd);
      expect(r.ask(":FREQuency:SPAN?")).toBe(span);
    }
    const r = rig();
    r.send(":CONFigure:TPOWer");
    expect(r.model.num("span")).toBe(0);
  });
  it("in zero span :SPAN? gets no reply (stall and -113) but :FREQuency:CENTer? answers", () => {
    const r = rig();
    r.send(":CONFigure:TPOWer");
    expect(r.ask(":FREQuency:CENTer?")).toBe("1.8050000000e+09 ");
    expect(r.ask(":FREQuency:SPAN?")).toBeUndefined();
  });
  it("RBW and sweep time are auto and follow the span; the detector, reference level and continuous flag are unchanged", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    expect(r.model.bool("rbw.auto")).toBe(true);
    expect(r.model.num("rbw")).toBeLessThan(3e6);
    expect(r.ask(":SENSe:BANDwidth:RESolution?")).toBeDefined();
    expect(r.ask(":SENSe:SWEep:TIME?")).toBeDefined();
    expect(r.ask(":INITiate:CONTinuous?")).toBe("1");
    expect(r.model.num("rl")).toBe(0);
    expect(r.model.str("det", 1)).toBe("NORMal");
  });
  it(":CONFigure:SANalyzer returns to spectrum analyzer mode and does NOT restore the span", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    r.send(":CONFigure:SANalyzer");
    expect(r.model.mode).toBe("SA");
    expect(r.ask(":FREQuency:SPAN?")).toBe("3.0000000000e+06 ");
    expect(r.ask(":SENSe:DETector:TRACe1?")).toBe("NORMal");
  });
  it("no query reports the active measurement", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    for (const q of [":CONFigure?", ":CONFigure:CHPower?", ":CONFigure:SANalyzer?", ":SENSe:MEASure?", ":CALCulate:MEASure?", ":INSTrument:MEASure?"]) {
      expect(r.ask(q), q).toBeUndefined();
      r.settle();
    }
    expect(r.ask(":INSTrument:SELect?")).toBe("SA");
  });
});

describe("tracking generator in the measurement modes (#161, docs: Measurements, results with a real signal)", () => {
  it(":CONFigure:<meas> switches the output off; :OUTPut:STATe? gets no reply and :OUTPut:STATe gives -113 while it is active", () => {
    const r = rig();
    r.send(":SOURce:POWer -25");
    r.send(":OUTPut:STATe ON");
    expect(r.ask(":OUTPut:STATe?")).toBe("1");
    r.send(":CONFigure:CNRatio");
    expect(r.model.bool("tg.out")).toBe(false);
    expect(r.ask(":OUTPut:STATe?")).toBeUndefined();
    r.settle();
    r.send(":OUTPut:STATe ON");
    expect(r.err()).toBe('-113,"Undefined header"');
    expect(r.model.bool("tg.out")).toBe(false);
  });
  it("after :CONFigure:SANalyzer the output stays off, but the level is kept and the output can be switched on again", () => {
    const r = rig();
    r.send(":SOURce:POWer -25");
    r.send(":OUTPut:STATe ON");
    r.send(":CONFigure:CHPower");
    r.send(":CONFigure:SANalyzer");
    expect(r.ask(":OUTPut:STATe?")).toBe("0");
    expect(r.ask(":SOURce:POWer?")).toBe("-2.500000e+01");
    r.send(":OUTPut:STATe ON");
    expect(r.ask(":OUTPut:STATe?")).toBe("1");
  });
});

describe("mode dependent queries (docs: Measurements, #18)", () => {
  it("[:SENSe]:<meas>:AVERage:STATe? answers only while that measurement is active", () => {
    const r = rig();
    r.send(":CONFigure:OBWidth");
    expect(r.ask(":SENSe:OBWidth:AVERage:STATe?")).toBeDefined();
    expect(r.ask(":SENSe:CHPower:AVERage:STATe?")).toBeUndefined();
    r.settle();
    expect(r.ask(":OBWidth:AVERage:STATe?")).toBeDefined(); // [:SENSe] is optional
  });
  it(":SENSe:DETector:TRACe1? and :TRACe1:TYPE? answer only in spectrum analyzer mode", () => {
    const r = rig();
    r.send(":CONFigure:CNRatio");
    expect(r.ask(":SENSe:DETector:TRACe1?")).toBeUndefined();
    r.settle();
    expect(r.ask(":TRACe1:TYPE?")).toBeUndefined();
    r.settle();
    r.send(":CONFigure:SANalyzer");
    expect(r.ask(":TRACe1:TYPE?")).toBe("WRITe");
  });
  it("a parameter setter of another mode gives -113 and changes nothing", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    r.send(":SENSe:OBWidth:PERCent 0.5");
    expect(r.err()).toBe('-113,"Undefined header"');
    r.send(":SENSe:ACPower:BANDwidth:INTegration 1 MHz");
    expect(r.err()).toBe('-113,"Undefined header"');
    r.send(":CONFigure:SANalyzer");
    r.send(":SENSe:CHPower:BANDwidth:INTegration 1 MHz");
    expect(r.err()).toBe('-113,"Undefined header"');
  });
});

describe("parameters, defaults and clamps (docs: Measurements, #18 and #19)", () => {
  it("channel power: defaults after the preset, clamp to 100 Hz..3.61 GHz, count 5000 accepted", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    expect(r.ask(":SENSe:CHPower:BANDwidth:INTegration?")).toBe("2.000000e+06 ");
    expect(r.ask(":SENSe:CHPower:AVERage:COUNt?")).toBe("10");
    expect(r.ask(":SENSe:CHPower:AVERage:STATe?")).toBe("1");
    expect(r.ask(":SENSe:CHPower:AVERage:TYPE?")).toBe("POWEr");
    expect(r.ask(":SENSe:CHPower:AVERage:TCONtrol?")).toBe("EXPonential");
    r.send(":SENSe:CHPower:BANDwidth:INTegration 1");
    expect(r.ask(":SENSe:CHPower:BANDwidth:INTegration?")).toBe("1.000000e+02 ");
    r.send(":SENSe:CHPower:BANDwidth:INTegration 1e12");
    expect(r.ask(":SENSe:CHPower:BANDwidth:INTegration?")).toBe("3.610000e+09 ");
    r.send(":SENSe:CHPower:AVERage:COUNt 5000");
    expect(r.ask(":SENSe:CHPower:AVERage:COUNt?")).toBe("5000");
    r.send(":SENSe:CHPower:AVERage:TYPE LOG");
    r.send(":SENSe:CHPower:AVERage:TCONtrol REPeat");
    r.send(":SENSe:CHPower:AVERage:STATe OFF");
    expect([r.ask(":SENSe:CHPower:AVERage:TYPE?"), r.ask(":SENSe:CHPower:AVERage:TCONtrol?"), r.ask(":SENSe:CHPower:AVERage:STATe?")]).toEqual(["LOG", "REPeat", "0"]);
    expect(r.err()).toBe('0,"No error"');
  });
  it("the preset puts a measurement's parameters back to their defaults", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    r.send(":SENSe:CHPower:BANDwidth:INTegration 1 MHz");
    r.send(":CONFigure:CHPower");
    expect(r.ask(":SENSe:CHPower:BANDwidth:INTegration?")).toBe("2.000000e+06 ");
  });
  it("OBW: percent 0.99 (5 clamps to 0.9999), x dB -26 (5 clamps to -0.1)", () => {
    const r = rig();
    r.send(":CONFigure:OBWidth");
    expect([r.ask(":SENSe:OBWidth:PERCent?"), r.ask(":SENSe:OBWidth:XDB?")]).toEqual(["9.900000e-01 ", "-2.600000e+01"]);
    r.send(":SENSe:OBWidth:PERCent 5");
    r.send(":SENSe:OBWidth:XDB 5");
    expect([r.ask(":SENSe:OBWidth:PERCent?"), r.ask(":SENSe:OBWidth:XDB?")]).toEqual(["9.999000e-01 ", "-1.000000e-01"]);
  });
  it("time power: left limit 0, right limit 10 ms and clamped to 10 ms", () => {
    const r = rig();
    r.send(":CONFigure:TPOWer");
    expect([r.ask(":SENSe:TPOWer:LLIMit?"), r.ask(":SENSe:TPOWer:RLIMit?")]).toEqual(["0.000000e+00 ", "1.000000e-02 "]);
    r.send(":SENSe:TPOWer:RLIMit 1 s");
    expect(r.ask(":SENSe:TPOWer:RLIMit?")).toBe("1.000000e-02 ");
  });
  it("ACPR, C/N and harmonics presets (2 MHz, 2 MHz, 3 MHz BOTH; 2 MHz each; fundamental = center, 2, 0.1 s)", () => {
    const r = rig();
    r.send(":CONFigure:ACPower");
    expect([":BANDwidth:INTegration", ":CARRier:LIST:BANDwidth", ":OFFSet:LIST:FREQuency", ":OFFSet:LIST:SIDE"].map((p) => r.ask(`:SENSe:ACPower${p}?`)))
      .toEqual(["2.000000e+06 ", "2.000000e+06 ", "3.000000e+06 ", "BOTH"]);
    r.send(":CONFigure:SANalyzer");
    r.send(":CONFigure:CNRatio");
    expect([":BANDwidth:INTegration", ":BANDwidth:NOISe", ":OFFSet"].map((p) => r.ask(`:SENSe:CNRatio${p}?`))).toEqual(["2.000000e+06 ", "2.000000e+06 ", "2.000000e+06 "]);
    r.send(":CONFigure:SANalyzer");
    r.send(":CONFigure:HARMonics");
    expect([r.ask(":SENSe:HARMonics:FREQuency:FUNDamental?"), r.ask(":SENSe:HARMonics:NUMBer?"), r.ask(":SENSe:HARMonics:SWEeptime?")])
      .toEqual(["1.805000e+09 ", "2", "1.000000e-01 "]);
    r.send(":SENSe:HARMonics:NUMBer 5");
    r.send(":SENSe:HARMonics:FREQuency:FUNDamental 50 MHz");
    expect([r.ask(":SENSe:HARMonics:NUMBer?"), r.ask(":SENSe:HARMonics:FREQuency:FUNDamental?")]).toEqual(["5", "5.000000e+07 "]);
  });
});

describe("results: FETCh and READ framing (docs: Measurements, #18 and #19)", () => {
  it(":FETCh:CHPower? gives two values (noise floor -74 dBm, -137 dBm/Hz with a 2 MHz integration bandwidth) and ends in CRLF", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    const reply = r.raw(":FETCh:CHPower?");
    expect(reply.endsWith("\r\n")).toBe(true);
    const [p, d] = reply.trim().split(",").map(Number);
    expect(p).toBeCloseTo(-74, 0);
    expect(d).toBeCloseTo(-137, 0);
  });
  it(":READ:CHPower? ends with a space and NO terminator over raw TCP; with vxi11 it is a normal text reply", () => {
    const r = rig();
    r.send(":CONFigure:CHPower");
    const reply = r.raw(":READ:CHPower?");
    expect(reply.endsWith(" ")).toBe(true);
    expect(reply).not.toContain("\n");
    expect(reply.trim().split(",")).toHaveLength(2);
    const v = rig({ transport: "vxi11" });
    v.send(":CONFigure:CHPower");
    expect(v.raw(":READ:CHPower?").trim().split(",")).toHaveLength(2);
  });
  it("value counts: TPOWer 1, OBWidth 7, ACPower 3, CNRatio 3", () => {
    for (const [cmd, query, count] of [[":CONFigure:TPOWer", ":FETCh:TPOWer?", 1], [":CONFigure:OBWidth", ":FETCh:OBWidth?", 7], [":CONFigure:ACPower", ":FETCh:ACPower?", 3], [":CONFigure:CNRatio", ":FETCh:CNRatio?", 3]] as const) {
      const r = rig();
      r.send(cmd);
      expect(r.nums(query), query).toHaveLength(count);
    }
  });
  it("OBW sub-results answer under FETCh, the READ sub-forms and the bare forms get no reply", () => {
    const r = rig();
    r.send(":CONFigure:OBWidth");
    for (const sub of ["OBWidth", "FERRor", "XDB", "APOWr"]) expect(r.nums(`:FETCh:OBWidth:${sub}?`), sub).toHaveLength(1);
    expect(r.ask(":READ:OBWidth:OBWidth?")).toBeUndefined();
    r.settle();
    expect(r.ask(":OBWidth:OBWidth?")).toBeUndefined();
  });
  it("ACPR sub-results: MAIN 1 value, LOWer and UPPer 2; offset side POSitive makes the lower values nan", () => {
    const r = rig();
    r.send(":CONFigure:ACPower");
    expect(r.nums(":FETCh:ACPower:MAIN?")).toHaveLength(1);
    expect(r.nums(":FETCh:ACPower:LOWer?")).toHaveLength(2);
    expect(r.nums(":FETCh:ACPower:UPPer?")).toHaveLength(2);
    r.send(":SENSe:ACPower:OFFSet:LIST:SIDE POSitive");
    expect(r.nums(":FETCh:ACPower:LOWer?").every(Number.isNaN)).toBe(true);
    expect(r.nums(":FETCh:ACPower:UPPer?").some(Number.isNaN)).toBe(false);
  });
  it("TOI: TRD lists have four values, TONE lists two, :FETCh:TOI:IPT? gets no reply and posts -113", () => {
    const r = rig();
    r.send(":CONFigure:TOI");
    expect(r.nums(":FETCh:TOI:LOW:TRD?")).toHaveLength(4);
    expect(r.nums(":FETCh:TOI:UP:TRD?")).toHaveLength(4);
    expect(r.nums(":FETCh:TOI:LOW:TONE?")).toHaveLength(2);
    expect(r.nums(":FETCh:TOI:UP:TONE?")).toHaveLength(2);
    expect(r.ask(":FETCh:TOI:IPT?")).toBeUndefined();
    r.advance(4001);
    expect(r.err()).toBe('-113,"Undefined header"');
  });
  it("harmonics: the lists always hold 10 values, only the first NUMBer are results, the rest are +|fundamental| dBc placeholders", () => {
    const r = rig();
    r.send(":CONFigure:HARMonics");
    r.send(":SENSe:HARMonics:NUMBer 5");
    const amp = r.nums(":FETCh:HARMonics:AMPLitude:ALL?");
    const freq = r.nums(":FETCh:HARMonics:FREQuency:ALL?");
    expect(amp).toHaveLength(10);
    expect(freq).toHaveLength(10);
    expect(amp.slice(5)).toEqual(Array(5).fill(Math.abs(amp[0]!)));
    expect(freq.slice(0, 5)).toEqual([1, 2, 3, 4, 5].map((k) => k * r.model.num("m.HARMonics.fund")));
    expect(r.nums(":FETCh:HARMonics:DISTortion?")).toHaveLength(2);
    expect(r.raw(":FETCh:HARMonics:AMPLitude:ALL?").endsWith("\r\n")).toBe(true);
  });
  it("a result query of a measurement that is not active gets no reply", () => {
    const r = rig();
    expect(r.ask(":FETCh:CHPower?")).toBeUndefined();
    r.settle();
    r.send(":CONFigure:CHPower");
    expect(r.ask(":FETCh:OBWidth?")).toBeUndefined();
  });
});

describe("fault injection for the restore-by-readback paths (#133)", () => {
  it("loseNext drops the next N setters of a parameter silently", () => {
    const r = rig();
    r.model.loseNext("span", 1);
    r.send(":FREQuency:SPAN 1 MHz");
    expect(r.model.num("span")).toBe(3.59e9);
    r.send(":FREQuency:SPAN 1 MHz");
    expect(r.model.num("span")).toBe(1e6);
    expect(r.err()).toBe('0,"No error"');
  });
});
