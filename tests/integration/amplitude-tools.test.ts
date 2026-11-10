import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerAmplitudeTools } from "../../src/tools/amplitude.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Tiny stateful fake of the analyzer's amplitude subsystem (behavior verified on the UTS3036B). */
const fake = vi.hoisted(() => {
  const initial = () => ({
    rlevelDbm: 0, // always kept in dBm; reads are converted to the current unit
    pdiv: 10,
    spacing: "LOGarithmic",
    offset: 0,
    unit: "DBM",
    att: 10,
    attAuto: true,
    preamp: false,
    imp: 50,
    errors: [] as string[],
  });
  const state = initial();
  const calls: string[] = [];
  const sci = (n: number) => n.toExponential(6);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  function readLevel(): number {
    const dbm = state.rlevelDbm;
    switch (state.unit) {
      case "DBMV": return dbm + 47;
      case "DBUV": return dbm + 107;
      case "V": return Math.sqrt(0.05 * 10 ** (dbm / 10) * 1);
      case "W": return 10 ** (dbm / 10) / 1000;
      default: return dbm;
    }
  }
  function writeLevel(v: number) {
    switch (state.unit) {
      case "DBMV": state.rlevelDbm = v - 47; break;
      case "DBUV": state.rlevelDbm = v - 107; break;
      case "V": state.rlevelDbm = 10 * Math.log10((v * v) / 0.05); break;
      case "W": state.rlevelDbm = 10 * Math.log10(v * 1000); break;
      default: state.rlevelDbm = v;
    }
    state.rlevelDbm = clamp(state.rlevelDbm, -100, 30);
  }
  function reset() {
    Object.assign(state, initial());
    calls.length = 0;
  }
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    switch (cmd) {
      case ":DISPlay:WINDow:TRACe:Y:RLEVel?": return sci(readLevel());
      case ":DISPlay:WINDow:TRACe:Y:PDIVision?": return sci(state.pdiv);
      case ":DISPlay:WINDow:TRACe:Y:SPACing?": return state.spacing;
      case ":DISPlay:WINDow:TRACe:Y:RLEVel:OFFSet?": return sci(state.offset);
      case ":UNIT:POWer?": return state.unit;
      case ":POWer:ATTenuation?": return String(state.att);
      case ":POWer:ATTenuation:AUTO?": return state.attAuto ? "1" : "0";
      case ":POWer:GAIN:STATe?": return state.preamp ? "1" : "0";
      case ":SENSe:CORRection:IMPedance:INPut:MAGNitude?": return String(state.imp);
      case ":SYSTem:ERRor?": return state.errors.shift() ?? '0,"No error"';
      default: throw new Error(`unexpected query ${cmd}`);
    }
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    const m = /^(\S+) (\S+)(?: (dBm|dB))?$/.exec(cmd);
    if (!m) { state.errors.push('-101,"Invalid character"'); return; }
    const [, head, arg] = m;
    switch (head) {
      case ":DISPlay:WINDow:TRACe:Y:RLEVel": writeLevel(Number(arg)); return;
      case ":DISPlay:WINDow:TRACe:Y:PDIVision": state.pdiv = clamp(Number(arg), 0.1, 20); return;
      case ":DISPlay:WINDow:TRACe:Y:SPACing":
        if (arg === "LOGarithmic" || arg === "LINear") state.spacing = arg;
        else state.errors.push('-224,"Illegal parameter value"');
        return;
      case ":DISPlay:WINDow:TRACe:Y:RLEVel:OFFSet": state.offset = clamp(Number(arg), -327.6, 327.6); return;
      case ":UNIT:POWer":
        if (["DBM", "DBMV", "DBUV", "V", "W"].includes(arg)) state.unit = arg;
        else state.errors.push('-224,"Illegal parameter value"');
        return;
      case ":POWer:ATTenuation": state.att = clamp(Math.round(Number(arg)), 0, 51); state.attAuto = false; return;
      case ":POWer:ATTenuation:AUTO": state.attAuto = arg === "ON" || arg === "1"; return;
      case ":POWer:GAIN:STATe": state.preamp = arg === "ON" || arg === "1"; return;
      case ":SENSe:CORRection:IMPedance:INPut:MAGNitude": state.imp = Number(arg) === 75 ? 75 : 50; return;
      default: state.errors.push('-113,"Undefined header"');
    }
  });
  return { state, reset, calls, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerAmplitudeTools);
  client = ctx.client;
  cleanup = ctx.cleanup;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
});

const json = (res: Awaited<ReturnType<typeof callTool>>) => JSON.parse(getText(res));
const Y = ":DISPlay:WINDow:TRACe:Y";

describe("tool listing", () => {
  it("registers get_amplitude (read-only) and set_amplitude", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_amplitude", "set_amplitude"]);
    expect(byName.get_amplitude.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_amplitude.annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_amplitude", () => {
  it("returns the full amplitude state", async () => {
    const res = await callTool(client, "get_amplitude", {});
    expect(res.isError).toBeFalsy();
    expect(json(res)).toEqual({
      reference_level: 0,
      power_unit: "dBm",
      scale_per_div_db: 10,
      scale_type: "logarithmic",
      reference_level_offset_db: 0,
      attenuation_db: 10,
      attenuation_auto: true,
      preamp: false,
      input_impedance_ohm: 50,
    });
  });

  it("reads the input impedance through the :SENSe:CORRection alias (the :INPut form gives no reply)", async () => {
    await callTool(client, "get_amplitude", {});
    const asked = fake.query.mock.calls.map((c) => c[0]);
    expect(asked).toContain(":SENSe:CORRection:IMPedance:INPut:MAGNitude?");
    expect(asked).not.toContain(":INPut:IMPedance?");
  });

  it("reports the reference level in the current power unit", async () => {
    fake.state.unit = "DBMV";
    const out = json(await callTool(client, "get_amplitude", {}));
    expect(out.power_unit).toBe("dBmV");
    expect(out.reference_level).toBeCloseTo(47, 3);
  });

  it("maps linear scale and every unit name", async () => {
    fake.state.spacing = "LINear";
    for (const [raw, name] of [["DBM", "dBm"], ["DBMV", "dBmV"], ["DBUV", "dBuV"], ["V", "V"], ["W", "W"]]) {
      fake.state.unit = raw;
      const out = json(await callTool(client, "get_amplitude", {}));
      expect(out.power_unit).toBe(name);
      expect(out.scale_type).toBe("linear");
    }
  });

  it("surfaces connection errors", async () => {
    fake.query.mockRejectedValueOnce(new Error("Not connected. Use the 'connect' tool first."));
    const res = await callTool(client, "get_amplitude", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("connect");
  });

  it("returns an error result for an unparseable reply", async () => {
    fake.query.mockResolvedValueOnce("garbage");
    const res = await callTool(client, "get_amplitude", {});
    expect(res.isError).toBe(true);
  });
});

describe("set_amplitude", () => {
  it("sets the reference level as a bare number and returns the re-read state", async () => {
    const res = await callTool(client, "set_amplitude", { reference_level: -10 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([`${Y}:RLEVel -10`]);
    const out = json(res);
    expect(out.state.reference_level).toBe(-10);
    expect(out.warnings).toEqual([]);
  });

  it("sets scale per division, scale type and offset", async () => {
    const res = await callTool(client, "set_amplitude", {
      scale_per_div_db: 5, scale_type: "linear", reference_level_offset_db: 3,
    });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([`${Y}:PDIVision 5`, `${Y}:SPACing LINear`, `${Y}:RLEVel:OFFSet 3`]);
    expect(json(res).state.scale_type).toBe("linear");
    fake.calls.length = 0;
    await callTool(client, "set_amplitude", { scale_type: "logarithmic" });
    expect(fake.calls).toEqual([`${Y}:SPACing LOGarithmic`]);
  });

  it("sets the power unit before the reference level, so the level is read in the new unit", async () => {
    const res = await callTool(client, "set_amplitude", { reference_level: 40, power_unit: "dBmV" });
    expect(fake.calls).toEqual([":UNIT:POWer DBMV", `${Y}:RLEVel 40`]);
    const out = json(res);
    expect(out.state.power_unit).toBe("dBmV");
    expect(out.state.reference_level).toBeCloseTo(40, 3);
    expect(out.warnings).toEqual([]);
  });

  it.each([["dBm", "DBM"], ["dBmV", "DBMV"], ["dBuV", "DBUV"], ["V", "V"], ["W", "W"]])(
    "power unit %s",
    async (unit, raw) => {
      await callTool(client, "set_amplitude", { power_unit: unit });
      expect(fake.calls).toEqual([`:UNIT:POWer ${raw}`]);
      expect(fake.state.unit).toBe(raw);
    }
  );

  it("sets a manual attenuation integer (turns auto off)", async () => {
    const res = await callTool(client, "set_amplitude", { attenuation_db: 20 });
    expect(fake.calls).toEqual([":POWer:ATTenuation 20"]);
    const out = json(res);
    expect(out.state.attenuation_db).toBe(20);
    expect(out.state.attenuation_auto).toBe(false);
    expect(out.warnings).toEqual([]);
  });

  it("accepts the attenuation bounds 0 and 51", async () => {
    expect((await callTool(client, "set_amplitude", { attenuation_db: 0 })).isError).toBeFalsy();
    expect((await callTool(client, "set_amplitude", { attenuation_db: 51 })).isError).toBeFalsy();
    expect(fake.state.att).toBe(51);
  });

  it("toggles automatic attenuation on and off", async () => {
    fake.state.attAuto = false;
    await callTool(client, "set_amplitude", { attenuation_auto: true });
    expect(fake.calls).toEqual([":POWer:ATTenuation:AUTO ON"]);
    expect(fake.state.attAuto).toBe(true);
    fake.calls.length = 0;
    await callTool(client, "set_amplitude", { attenuation_auto: false });
    expect(fake.calls).toEqual([":POWer:ATTenuation:AUTO OFF"]);
    expect(fake.state.attAuto).toBe(false);
  });

  it("does not warn about attenuation when it is automatic (it follows the reference level)", async () => {
    const res = await callTool(client, "set_amplitude", { attenuation_auto: true });
    expect(json(res).warnings).toEqual([]);
  });

  it("switches the preamp, before attenuation changes", async () => {
    await callTool(client, "set_amplitude", { attenuation_db: 5, preamp: true });
    expect(fake.calls).toEqual([":POWer:GAIN:STATe ON", ":POWer:ATTenuation 5"]);
    expect(fake.state.preamp).toBe(true);
    fake.calls.length = 0;
    await callTool(client, "set_amplitude", { preamp: false });
    expect(fake.calls).toEqual([":POWer:GAIN:STATe OFF"]);
  });

  it("sets the input impedance through the :SENSe:CORRection alias (the :INPut setter is undefined)", async () => {
    const res = await callTool(client, "set_amplitude", { input_impedance_ohm: 75 });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([":SENSe:CORRection:IMPedance:INPut:MAGNitude 75"]);
    expect(json(res).state.input_impedance_ohm).toBe(75);
  });

  it("warns when the instrument clamps a requested value", async () => {
    const res = await callTool(client, "set_amplitude", {
      reference_level: 100, reference_level_offset_db: 5000,
    });
    expect(res.isError).toBeFalsy();
    const w = json(res).warnings.join(" ");
    expect(w).toMatch(/reference_level/);
    expect(w).toMatch(/reference_level_offset_db/);
    expect(w).toMatch(/adjusted/i);
  });

  it("warns when the instrument ignores the requested impedance", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (!cmd.includes("IMPedance")) await original(cmd);
      else fake.calls.push(cmd);
    });
    try {
      const res = await callTool(client, "set_amplitude", { input_impedance_ohm: 75 });
      expect(json(res).warnings.join(" ")).toMatch(/input_impedance_ohm/);
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });

  it("applies preamp/attenuation and the offset before the reference level (the level is coupled to them)", async () => {
    await callTool(client, "set_amplitude", {
      reference_level: 0, reference_level_offset_db: 2, preamp: false, attenuation_auto: true,
    });
    const idx = (c: string) => fake.calls.findIndex((x) => x.startsWith(c));
    const level = idx(`${Y}:RLEVel `);
    expect(level).toBe(fake.calls.length - 1);
    for (const c of [":POWer:GAIN:STATe", ":POWer:ATTenuation:AUTO", `${Y}:RLEVel:OFFSet`]) {
      expect(idx(c)).toBeGreaterThanOrEqual(0);
      expect(idx(c)).toBeLessThan(level);
    }
  });

  it("combines several settings in one call", async () => {
    const res = await callTool(client, "set_amplitude", {
      power_unit: "dBm", reference_level: -20, scale_per_div_db: 5, preamp: true, attenuation_auto: true,
    });
    expect(res.isError).toBeFalsy();
    expect(fake.calls).toEqual([
      ":UNIT:POWer DBM",
      ":POWer:GAIN:STATe ON",
      ":POWer:ATTenuation:AUTO ON",
      `${Y}:PDIVision 5`,
      `${Y}:RLEVel -20`,
    ]);
  });

  it("reports instrument errors from the error queue", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      await original(cmd);
      if (cmd.startsWith(":UNIT:POWer")) fake.state.errors.push('-224,"Illegal parameter value"');
    });
    try {
      const res = await callTool(client, "set_amplitude", { power_unit: "W" });
      expect(res.isError).toBe(true);
      expect(getText(res)).toContain("Illegal parameter value");
    } finally {
      fake.sendCommand.mockImplementation(original);
    }
  });

  it("clears stale errors with *CLS first", async () => {
    fake.state.errors.push('-113,"Undefined header"');
    const res = await callTool(client, "set_amplitude", { preamp: true });
    expect(res.isError).toBeFalsy();
    expect(fake.sendCommand.mock.calls[0][0]).toBe("*CLS");
  });

  describe("validation (nothing is sent)", () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["no parameters", {}],
      ["non-finite reference level", { reference_level: Infinity }],
      ["scale below 0.1 dB", { scale_per_div_db: 0.05 }],
      ["scale above 20 dB", { scale_per_div_db: 21 }],
      ["zero scale", { scale_per_div_db: 0 }],
      ["non-finite offset", { reference_level_offset_db: Infinity }],
      ["attenuation below 0", { attenuation_db: -1 }],
      ["attenuation above 51", { attenuation_db: 52 }],
      ["non-integer attenuation", { attenuation_db: 7.5 }],
      ["attenuation with auto=true", { attenuation_db: 10, attenuation_auto: true }],
      ["impedance 60", { input_impedance_ohm: 60 }],
      ["unknown unit", { power_unit: "dBW" }],
      ["unknown scale type", { scale_type: "log10" }],
    ];
    it.each(invalid)("rejects %s", async (_name, args) => {
      const res = await callTool(client, "set_amplitude", args);
      expect(res.isError).toBe(true);
      expect(fake.sendCommand).not.toHaveBeenCalled();
    });
  });
});
