import { describe, it, expect } from "vitest";
import { connect, type Socket } from "node:net";
import { UtsModel, startFakeUts, STALL_MS, LATE_ERROR_MS, RAW_BLOCK_LIMIT, type Out } from "../fakeUts.js";

/** Drive the pure model with a fake clock; every value asserted here is from docs/verified-hardware.md. */
function rig(options: ConstructorParameters<typeof UtsModel>[0] = {}) {
  let t = 1_000_000;
  const model = new UtsModel({ now: () => t, ...options });
  const text = (outs: Out[]) => outs.map((o) => ("text" in o ? o.text : `<${o.bytes.length} bytes>`));
  return {
    model,
    advance: (ms: number) => (t += ms),
    send: (line: string) => model.handleLine(line),
    ask: (line: string) => text(model.handleLine(line))[0],
    err: () => text(model.handleLine(":SYSTem:ERRor?"))[0],
  };
}

describe("framing and identity", () => {
  it("answers *IDN? with the verified shape and no serial", () => {
    expect(rig().ask("*IDN?")).toBe("UNI-TREND,UTS3036B,SN000000,V1.04.0040");
  });
  it("answers *OPC? with 1 and the idle status registers with 0", () => {
    const r = rig();
    expect([r.ask("*OPC?"), r.ask("*ESR?"), r.ask("*STB?")]).toEqual(["1", "0", "0"]);
  });
  it("setters give no reply", () => {
    expect(rig().send(":FREQuency:CENTer 1 GHz")).toEqual([]);
  });
  it("accepts short and long forms in any case and ignores the optional [:SENSe]", () => {
    const r = rig();
    r.send(":freq:cent 500 MHz");
    expect(r.ask(":SENSe:FREQuency:CENTer?")).toBe("5.000000e+08");
    expect(r.ask(":FREQUENCY:CENTER?")).toBe("5.000000e+08");
  });
});

describe("error queue", () => {
  it("starts empty", () => expect(rig().err()).toBe('0,"No error"'));
  it("an unknown command posts -113 immediately and is drained one error at a time", () => {
    const r = rig();
    r.send(":BOGUS:THING 1");
    expect(r.err()).toBe('-113,"Undefined header"');
    expect(r.err()).toBe('0,"No error"');
  });
  it("an invalid suffix gives -224 and -131 and changes nothing", () => {
    const r = rig();
    r.send(":FREQuency:CENTer 1 XYZ");
    expect([r.err(), r.err(), r.err()]).toEqual(['-224,"Illegal parameter value"', '-131,"Invalid suffix"', '0,"No error"']);
    expect(r.ask(":FREQuency:CENTer?")).toBe("1.805000e+09");
  });
  it("an invalid enum gives -224", () => {
    const r = rig();
    r.send(":UNIT:POWer BOGUS");
    expect(r.err()).toBe('-224,"Illegal parameter value"');
  });
  it("*CLS clears the queue", () => {
    const r = rig();
    r.send(":BOGUS 1");
    r.send("*CLS");
    expect(r.err()).toBe('0,"No error"');
  });
});

describe("unsupported queries", () => {
  it("get no reply, stall the instrument for about 2.15 s and post -113 about 4 s later, even after *CLS", () => {
    const r = rig();
    expect(r.send(":INPut:IMPedance?")).toEqual([]);
    r.advance(100);
    expect(r.send("*IDN?")).toEqual([]); // lost in the stall
    expect(r.model.dropped).toEqual(["*IDN?"]);
    r.advance(STALL_MS);
    expect(r.ask("*IDN?")).toMatch(/UTS3036B/);
    r.send("*CLS");
    expect(r.err()).toBe('0,"No error"');
    r.advance(LATE_ERROR_MS);
    expect(r.err()).toBe('-113,"Undefined header"');
  });
  it("trace math, :FORMat-less probes and marker 11 are unsupported", () => {
    for (const q of [":CALCulate:MATH?", ":CALCulate:MARKer11:MODE?", ":TRACe7:TYPE?", ":TRIGger:SEQuence:EXTernal:SLOPe?"]) {
      expect(rig().send(q), q).toEqual([]);
    }
  });
});

describe("setters clamp silently (no error queued)", () => {
  const cases: Array<[string, string, string]> = [
    [":FREQuency:CENTer 5 GHz", ":FREQuency:CENTer?", "3.60999995e+09"],
    [":FREQuency:SPAN 10 GHz", ":FREQuency:SPAN?", "3.610000e+09"],
    [":FREQuency:STOP 5 GHz", ":FREQuency:STOP?", "3.610000e+09"],
    [":DISPlay:WINDow:TRACe:Y:RLEVel 100", ":DISPlay:WINDow:TRACe:Y:RLEVel?", "3.000000e+01"],
    [":DISPlay:WINDow:TRACe:Y:RLEVel -500", ":DISPlay:WINDow:TRACe:Y:RLEVel?", "-1.000000e+02"],
    [":DISPlay:WINDow:TRACe:Y:RLEVel:OFFSet 1000", ":DISPlay:WINDow:TRACe:Y:RLEVel:OFFSet?", "3.276000e+02"],
    [":POWer:ATTenuation 7.6", ":POWer:ATTenuation?", "8"],
    [":SENSe:CORRection:IMPedance:INPut:MAGNitude 60", ":SENSe:CORRection:IMPedance:INPut:MAGNitude?", "5.000000e+01"],
    [":SENSe:BANDwidth:RESolution 50 kHz", ":SENSe:BANDwidth:RESolution?", "3.000000e+04"],
    [":SENSe:BANDwidth:RESolution 0", ":SENSe:BANDwidth:RESolution?", "1.000000e+00"],
    [":SENSe:BANDwidth:RESolution 1 GHz", ":SENSe:BANDwidth:RESolution?", "3.000000e+06"],
    [":SENSe:BANDwidth:VIDeo:RATio 1e-7", ":SENSe:BANDwidth:VIDeo:RATio?", "1.000000e-05"],
    [":SENSe:SWEep:POINts 1001.6", ":SENSe:SWEep:POINts?", "1001"],
    [":SENSe:SWEep:POINts 5", ":SENSe:SWEep:POINts?", "11"],
    [":TRIGger:SEQuence:VIDeo:LEVel 100", ":TRIGger:SEQuence:VIDeo:LEVel?", "3.000000e+01"],
    [":SOURce:POWer -120", ":SOURce:POWer?", "-4.000000e+01"],
    [":CALCulate:MARKer:FCOunt:GATetime 9", ":CALCulate:MARKer:FCOunt:GATetime?", "5.000000e-01"],
    [":CALCulate:MARKer1:BANDwidth:NDB 5", ":CALCulate:MARKer1:BANDwidth:NDB?", "-1.000000e-02"],
    [":CALCulate:LLINe1:MARGin 99", ":CALCulate:LLINe1:MARGin?", "4.000000e+01"],
    [":SENSe:AVERage:COUNt 1000", ":SENSe:AVERage:COUNt?", "1000"],
    [":SENSe:AVERage:COUNt 0", ":SENSe:AVERage:COUNt?", "1"],
  ];
  for (const [set, get, expected] of cases) {
    it(`${set} reads back ${expected}`, () => {
      const r = rig();
      r.send(set);
      expect(r.ask(get)).toBe(expected);
      expect(r.err()).toBe('0,"No error"');
    });
  }
  it("sweep time clamps to 1 ms and turns auto off", () => {
    const r = rig();
    r.send(":SENSe:SWEep:TIME 1 us");
    expect(r.ask(":SENSe:SWEep:TIME?")).toBe("1.000000e-03 ");
    expect(r.ask(":SENSe:SWEep:TIME:AUTO?")).toBe("0");
  });
});

describe("coupling and side effects", () => {
  it("defaults are the verified idle state", () => {
    const r = rig();
    expect([r.ask(":FREQuency:STARt?"), r.ask(":FREQuency:STOP?"), r.ask(":SENSe:SWEep:POINts?"), r.ask(":INITiate:CONTinuous?")])
      .toEqual(["1.000000e+07", "3.600000e+09", "1001", "1"]);
    expect(r.ask(":SENSe:SWEep:TIME?")).toBe("2.647500e-03 ");
    expect(r.ask(":FORMat?")).toBe("ASC8");
  });
  it("center and span move start and stop", () => {
    const r = rig();
    r.send(":FREQuency:CENTer 1 GHz");
    r.send(":FREQuency:SPAN 100 MHz");
    expect([r.ask(":FREQuency:STARt?"), r.ask(":FREQuency:STOP?")]).toEqual(["9.500000e+08", "1.050000e+09"]);
    r.send(":FREQuency:STARt 900 MHz");
    expect([r.ask(":FREQuency:CENTer?"), r.ask(":FREQuency:SPAN?")]).toEqual(["9.750000e+08", "1.500000e+08"]);
  });
  it("manual attenuation turns auto off; auto follows the reference level", () => {
    const r = rig();
    r.send(":POWer:ATTenuation 20");
    expect(r.ask(":POWer:ATTenuation:AUTO?")).toBe("0");
    r.send(":POWer:ATTenuation:AUTO ON");
    r.send(":DISPlay:WINDow:TRACe:Y:RLEVel -30");
    expect(r.ask(":POWer:ATTenuation?")).toBe("0");
  });
  it("the unit changes the reference level readback; the unit query is upper case", () => {
    const r = rig();
    r.send(":DISPlay:WINDow:TRACe:Y:RLEVel -10");
    r.send(":UNIT:POWer dBmV");
    expect(r.ask(":UNIT:POWer?")).toBe("DBMV");
    expect(Number(r.ask(":DISPlay:WINDow:TRACe:Y:RLEVel?"))).toBeCloseTo(36.9897, 3);
  });
  it("a manual RBW turns RBW auto off and VBW auto follows it", () => {
    const r = rig();
    r.send(":SENSe:BANDwidth:RESolution 100 kHz");
    expect(r.ask(":SENSe:BANDwidth:RESolution:AUTO?")).toBe("0");
    expect(r.ask(":SENSe:BANDwidth:VIDeo?")).toBe("1.000000e+05");
  });
  it("setting the video trigger level switches the source; EXTernal is rejected", () => {
    const r = rig();
    r.send(":TRIGger:SEQuence:VIDeo:LEVel -30");
    expect(r.ask(":TRIGger:SEQuence:SOURce?")).toBe("VIDeo");
    r.send(":TRIGger:SEQuence:SOURce EXTernal");
    expect(r.err()).toBe('-224,"Illegal parameter value"');
    expect(r.ask(":TRIGger:SEQuence:SOURce?")).toBe("VIDeo");
  });
  it("the tracking generator output makes the auto sweep time 2.15 s; the reference trace only takes with the output on", () => {
    const r = rig();
    r.send(":SOURce:TRACe:REFerence:STATe 1");
    expect(r.ask(":SOURce:TRACe:REFerence:STATe?")).toBe("0");
    r.send(":OUTPut:STATe 1");
    expect(r.model.sweepTimeS).toBeCloseTo(2.15, 6);
    r.send(":SOURce:TRACe:REFerence:STATe 1");
    expect(r.ask(":SOURce:TRACe:REFerence:STATe?")).toBe("1");
  });
  it("trace math switches the target trace on; trace types round-trip; trace 7 is rejected", () => {
    const r = rig();
    r.send(":CALCulate:MATH TRACE5,PSUM,TRACE1,TRACE2,0");
    expect([r.ask(":TRACe5:UPDate:STATe?"), r.ask(":TRACe5:DISPlay:STATe?")]).toEqual(["1", "1"]);
    r.send(":TRACe2:TYPE MAXHold");
    expect(r.ask(":TRACe2:TYPE?")).toBe("MAXHold");
    r.send(":TRACe:SELect 9");
    expect(r.err()).toBe('-224,"Illegal parameter value"');
    expect(r.ask(":TRACe:SELect?")).toBe("1");
  });
  it("markers: reference defaults to n+1, a search turns the marker on, X is not clamped", () => {
    const r = rig();
    expect([r.ask(":CALCulate:MARKer1:REFerence?"), r.ask(":CALCulate:MARKer10:REFerence?")]).toEqual(["2", "1"]);
    r.send(":CALCulate:MARKer1:MAXimum");
    expect(r.ask(":CALCulate:MARKer1:MODE?")).toBe("POSition");
    r.send(":CALCulate:MARKer2:X 5 GHz");
    expect(r.ask(":CALCulate:MARKer2:X?")).toBe("5.000000e+09");
    r.send(":CALCulate:MARKer:AOFF");
    expect(r.ask(":CALCulate:MARKer1:MODE?")).toBe("OFF");
  });
  it("limit lines: data sorted, first point connected, display turns on, empty line is silent, more than 10 points ignored", () => {
    const r = rig();
    expect(r.send(":CALCulate:LLINe1:DATA?")).toEqual([]);
    r.send(":CALCulate:LLINe1:DATA 5e8,-30,0,1e8,-50,0");
    expect(r.ask(":CALCulate:LLINe1:DISPlay?")).toBe("1");
    expect(r.ask(":CALCulate:LLINe1:DATA?")).toBe("1.000000e+08,-5.000000e+01,1.000000e+00,5.000000e+08,-3.000000e+01,0.000000e+00");
    r.send(":CALCulate:LLINe1:DATA " + Array.from({ length: 11 }, (_, i) => `${i + 1}e6,-40,1`).join(","));
    expect(r.ask(":CALCulate:LLINe1:DATA?")!.split(",")).toHaveLength(6);
    r.send(":CALCulate:LLINe1:DATA 1,2");
    expect(r.err()).toBe('-200,"Execution error"');
    r.send(":CALCulate:LLINe:ALL:DELete");
    expect(r.send(":CALCulate:LLINe1:DATA?")).toEqual([]);
  });
});

describe("sweeps", () => {
  it("single sweep over raw TCP: every line during the sweep is dropped, *OPC? answers afterwards", () => {
    const r = rig();
    r.send(":INITiate:CONTinuous OFF");
    r.send(":SENSe:SWEep:TIME 2");
    r.send(":INITiate:IMMediate");
    r.advance(500);
    expect(r.send("*OPC?")).toEqual([]);
    expect(r.model.dropped).toEqual(["*OPC?"]);
    r.advance(1600);
    expect(r.ask("*OPC?")).toBe("1");
  });
  it("continuous mode accepts :INITiate:IMMediate and keeps answering", () => {
    const r = rig();
    r.send(":SENSe:SWEep:TIME 2");
    r.send(":INITiate:IMMediate");
    expect(r.ask("*OPC?")).toBe("1");
  });
  it("over VXI-11 the lines are queued and answered when the sweep ends", () => {
    const r = rig({ transport: "vxi11" });
    r.send(":INITiate:CONTinuous OFF");
    r.send(":SENSe:SWEep:TIME 2");
    r.send(":INITiate:IMMediate");
    expect(r.send("*OPC?")).toEqual([]);
    expect(r.model.dropped).toEqual([]);
    expect(r.model.drainQueued()).toEqual([]);
    r.advance(2100);
    expect(r.model.drainQueued()).toEqual([{ text: "1" }]);
  });
});

describe("trace data and screenshot", () => {
  it("ASCII trace is the fixture: 1001 values, CRLF terminated", () => {
    const [o] = rig().send(":TRACe:DATA? TRACE1");
    const bytes = (o as { bytes: Buffer }).bytes;
    expect(bytes.subarray(-2).toString("latin1")).toBe("\r\n");
    expect(bytes.toString("latin1").trim().split(",")).toHaveLength(1001);
  });
  it("REAL32 and REAL64 are #4 blocks with CRLF (4004 and 8008 byte bodies)", () => {
    for (const [fmt, len] of [["REAL32", 4004], ["REAL64", 8008]] as const) {
      const r = rig();
      r.send(`:FORMat ${fmt}`);
      expect(r.ask(":FORMat?")).toBe("ASC8");
      const bytes = (r.send(":TRACe:DATA? TRACE1")[0] as { bytes: Buffer }).bytes;
      expect(bytes.subarray(0, 2).toString()).toBe("#4");
      expect(Number(bytes.subarray(2, 6).toString())).toBe(len);
      expect(bytes.length).toBe(6 + len + 2);
      expect(bytes.subarray(-2).toString("latin1")).toBe("\r\n");
    }
  });
  it("the number of values follows :SWEep:POINts", () => {
    const r = rig();
    r.send(":SENSe:SWEep:POINts 501");
    const bytes = (r.send(":TRACe:DATA? TRACE2")[0] as { bytes: Buffer }).bytes;
    expect(bytes.toString("latin1").trim().split(",")).toHaveLength(501);
  });
  it("the screenshot stops after exactly 144,800 bytes over raw TCP and starts with the captured header", () => {
    const [o] = rig().send(":DISPlay:DATA?");
    const bytes = (o as { bytes: Buffer }).bytes;
    expect(bytes.length).toBe(RAW_BLOCK_LIMIT);
    expect(bytes.subarray(0, 2).toString()).toBe("#7");
  });
});

describe("over a real socket", () => {
  async function talk(socket: Socket, line: string, wait = 60): Promise<string> {
    return new Promise((resolve) => {
      let got = "";
      const onData = (d: Buffer) => (got += d.toString("latin1"));
      socket.on("data", onData);
      socket.write(line + "\n");
      setTimeout(() => { socket.off("data", onData); resolve(got); }, wait);
    });
  }
  it("frames LF-terminated lines and replies with CRLF", async () => {
    const fake = await startFakeUts();
    const socket = connect(fake.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    try {
      expect(await talk(socket, "*IDN?")).toBe("UNI-TREND,UTS3036B,SN000000,V1.04.0040\r\n");
      expect(await talk(socket, ":FREQuency:CENTer 1 GHz")).toBe("");
      expect(await talk(socket, ":FREQuency:CENTer?")).toBe("1.000000e+09\r\n");
      expect(await talk(socket, ":INPut:IMPedance?")).toBe(""); // unsupported: silence
    } finally {
      socket.destroy();
      await fake.close();
    }
  });
});

describe("hostile input", () => {
  it("prototype property names are not commands or unit suffixes", () => {
    const r = rig();
    expect(r.send("constructor?")).toEqual([]);
    expect(r.send("__proto__?")).toEqual([]);
    r.advance(STALL_MS + 1); // the unsupported queries above stall the instrument
    r.send(":FREQuency:CENTer 1 constructor");
    expect(r.err()).toBe('-224,"Illegal parameter value"');
    expect(r.ask(":FREQuency:CENTer?")).toBe("1.805000e+09");
  });
});
