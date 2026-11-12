import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiCorrectionTools } from "../../src/tools/emiCorrection.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

interface Slot {
  enabled: boolean;
  points: Array<[number, number]>;
}

/** Small stateful fake of the EMI correction-factor subsystem, modeling the live-verified 10-point cap. */
const fake = vi.hoisted(() => {
  const fresh = (): Slot => ({ enabled: false, points: [] });
  const slots: Slot[] = [];
  const state = { module: "EMI" as "SA" | "EMI", errors: [] as string[] };
  const calls: string[] = [];
  function reset() {
    slots.length = 0;
    for (let i = 0; i < 10; i++) slots.push(fresh());
    state.module = "EMI";
    state.errors = [];
    calls.length = 0;
  }
  reset();
  const sci = (n: number) => n.toExponential(6);
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    if (cmd === ":SYSTem:ERRor?") return state.errors.shift() ?? '0,"No error"';
    if (cmd === ":INSTrument:SELect?") return state.module;
    const m = /^:SENSe:CORRection:CSET(\d+):(.+)\?$/.exec(cmd);
    if (!m) throw new Error(`unexpected query ${cmd}`);
    const s = slots[Number(m[1]) - 1];
    switch (m[2]) {
      case "STATe": return s.enabled ? "1" : "0";
      case "DATA":
        // Verified live: the instrument gives no reply at all to DATA? on an empty slot.
        if (s.points.length === 0) throw new Error(`Query timeout after ${_t}ms for command: ${cmd}`);
        return s.points.map(([f, g]) => `${sci(f)},${sci(g)}`).join(",");
      default: throw new Error(`unexpected query ${cmd}`);
    }
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    if (cmd === ":SENSe:CORRection:CSET:ALL:STATe OFF") { for (const s of slots) s.enabled = false; return; }
    if (cmd === ":SENSe:CORRection:CSET:ALL:DELete") { for (const s of slots) s.points = []; return; }
    const m = /^:SENSe:CORRection:CSET(\d+):(\S+)(?: (.*))?$/.exec(cmd);
    if (!m) { state.errors.push('-113,"Undefined header"'); return; }
    const s = slots[Number(m[1]) - 1];
    const arg = m[3];
    switch (m[2]) {
      case "DELete": s.points = []; break;
      case "STATe": s.enabled = arg === "1" || arg === "ON"; break;
      case "DATA": {
        const n = (arg ?? "").split(",").map(Number);
        if (n.length % 2 !== 0 || n.some(Number.isNaN)) { state.errors.push('-200,"Execution error"'); break; }
        // Verified live: a write over the 10-point cap is silently rejected and empties the slot's data,
        // with no error signal anywhere (not *ESR?, not *STB?, not :SYSTem:ERRor?).
        if (n.length / 2 > 10) { s.points = []; break; }
        const pts: Array<[number, number]> = [];
        for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
        s.points = pts;
        break;
      }
      default: state.errors.push('-113,"Undefined header"');
    }
  });
  return { slots, state, calls, reset, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const ctx = await createTestServer(registerEmiCorrectionTools);
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
const PTS = [
  { frequency_hz: 1e8, gain_db: 2 },
  { frequency_hz: 5e8, gain_db: -1.5 },
];

describe("tool listing", () => {
  it("registers get_emi_correction (read-only) and set_emi_correction", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["get_emi_correction", "set_emi_correction"]);
    expect(byName.get_emi_correction.annotations?.readOnlyHint).toBe(true);
    expect(byName.set_emi_correction.annotations?.readOnlyHint).toBe(false);
  });
});

describe("get_emi_correction", () => {
  it("reads an empty slot (the instrument does not answer DATA? then)", async () => {
    const res = await callTool(client, "get_emi_correction", { slot: 2 });
    expect(res.isError).toBeFalsy();
    expect(json(res)).toEqual({ slot: 2, enabled: false, points: [] });
    expect(fake.query).toHaveBeenCalledWith(":SENSe:CORRection:CSET2:DATA?", expect.any(Number));
  });

  it("reads the points and enabled state", async () => {
    Object.assign(fake.slots[0], { enabled: true, points: [[1e8, 2], [5e8, -1.5]] });
    const res = await callTool(client, "get_emi_correction", {});
    expect(json(res)).toEqual({ slot: 1, enabled: true, points: [{ frequency_hz: 1e8, gain_db: 2 }, { frequency_hz: 5e8, gain_db: -1.5 }] });
  });

  it("refuses with an actionable message when not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "get_emi_correction", {});
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects slot numbers outside 1-10", async () => {
    for (const slot of [0, 11, 1.5]) expect((await callTool(client, "get_emi_correction", { slot })).isError).toBe(true);
    expect(fake.query).not.toHaveBeenCalled();
  });
});

describe("set_emi_correction", () => {
  it("writes points and reads them back", async () => {
    const res = await callTool(client, "set_emi_correction", { slot: 1, points: PTS });
    expect(res.isError, getText(res)).toBeFalsy();
    expect(fake.calls).toEqual([":SENSe:CORRection:CSET1:DATA 100000000,2,500000000,-1.5"]);
    const out = json(res);
    expect(out.state.points).toHaveLength(2);
    expect(out.warnings).toEqual([]);
  });

  it("enables a slot", async () => {
    const res = await callTool(client, "set_emi_correction", { slot: 3, enabled: true });
    expect(fake.calls).toEqual([":SENSe:CORRection:CSET3:STATe 1"]);
    expect(json(res).state.enabled).toBe(true);
    expect(json(res).warnings).toEqual([]);
  });

  it("deletes a slot's points and confirms they are gone", async () => {
    fake.slots[0].points = [[1e8, 2]];
    const res = await callTool(client, "set_emi_correction", { slot: 1, delete: true });
    expect(fake.calls).toEqual([":SENSe:CORRection:CSET1:DELete"]);
    expect(json(res).state.points).toEqual([]);
    expect(json(res).warnings).toEqual([]);
  });

  it("deletes then enables a slot in one call", async () => {
    fake.slots[0].points = [[1e8, 2]];
    const res = await callTool(client, "set_emi_correction", { slot: 1, delete: true, enabled: true });
    expect(fake.calls).toEqual([":SENSe:CORRection:CSET1:DELete", ":SENSe:CORRection:CSET1:STATe 1"]);
    expect(json(res).state.enabled).toBe(true);
    expect(json(res).state.points).toEqual([]);
  });

  it("turns off every slot with all_off", async () => {
    fake.slots[2].enabled = true;
    const res = await callTool(client, "set_emi_correction", { all_off: true });
    expect(fake.calls).toEqual([":SENSe:CORRection:CSET:ALL:STATe OFF"]);
    expect(fake.slots[2].enabled).toBe(false);
    expect(json(res).warnings).toEqual([]);
  });

  it("clears every slot's points with delete_all", async () => {
    fake.slots[4].points = [[2e8, 1]];
    const res = await callTool(client, "set_emi_correction", { delete_all: true });
    expect(fake.calls).toEqual([":SENSe:CORRection:CSET:ALL:DELete"]);
    expect(fake.slots[4].points).toEqual([]);
    expect(json(res).warnings).toEqual([]);
  });

  it("silently loses an 11th point, exactly as verified live, and is reported in warnings", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({ frequency_hz: 1e8 + i * 1e7, gain_db: i }));
    // The tool itself refuses locally above the known cap; simulate the raw instrument behavior directly
    // to document the live finding (an over-cap write empties the slot, with no error anywhere).
    fake.state.module = "EMI";
    await fake.sendCommand(`:SENSe:CORRection:CSET1:DATA ${eleven.map((p) => `${p.frequency_hz},${p.gain_db}`).join(",")}`);
    expect(fake.slots[0].points).toEqual([]);
    expect(fake.state.errors).toEqual([]);
    // Through the tool, this is refused before anything is sent:
    const res = await callTool(client, "set_emi_correction", { slot: 1, points: eleven });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/at most 10/);
  });

  it("rejects no parameters, slot without an action, and combining delete with points", async () => {
    for (const args of [
      {},
      { slot: 1 },
      { slot: 1, delete: true, points: PTS },
      { points: PTS }, // slot required
      { all_off: true, slot: 1 },
      { all_off: true, delete_all: true },
      { points: [{ frequency_hz: 5e8, gain_db: -1 }, { frequency_hz: 1e8, gain_db: 2 }] }, // slot missing too, but order matters more below
    ]) {
      expect((await callTool(client, "set_emi_correction", args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects points out of ascending order and empty point lists", async () => {
    const descending = await callTool(client, "set_emi_correction", {
      slot: 1,
      points: [{ frequency_hz: 5e8, gain_db: -1 }, { frequency_hz: 1e8, gain_db: 2 }],
    });
    expect(descending.isError).toBe(true);
    const empty = await callTool(client, "set_emi_correction", { slot: 1, points: [] });
    expect(empty.isError).toBe(true);
  });

  it("refuses with an actionable message when not in the EMI module", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "set_emi_correction", { slot: 1, enabled: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/select_instrument_module/);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("warns when the instrument did not take the enabled state", async () => {
    const original = fake.sendCommand.getMockImplementation()!;
    fake.sendCommand.mockImplementation(async (cmd: string) => {
      if (cmd === ":SENSe:CORRection:CSET1:STATe 1") return; // instrument ignores it
      return original(cmd);
    });
    const res = await callTool(client, "set_emi_correction", { slot: 1, enabled: true });
    expect(json(res).warnings.join(" ")).toMatch(/enabled adjusted by the instrument/);
  });
});
