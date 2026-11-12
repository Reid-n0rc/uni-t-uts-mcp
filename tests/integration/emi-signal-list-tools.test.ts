import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerEmiSignalListTools } from "../../src/tools/emiSignalList.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Small stateful fake of the EMI signal-list subsystem: only sort type/order is actually queryable. */
const fake = vi.hoisted(() => {
  const state = { module: "EMI" as "SA" | "EMI", sortType: "FREQuency", sortOrder: "ASCending", errors: [] as string[], ignoreOrderSet: false };
  const calls: string[] = [];
  function reset() {
    state.module = "EMI";
    state.sortType = "FREQuency";
    state.sortOrder = "ASCending";
    state.errors = [];
    state.ignoreOrderSet = false;
    calls.length = 0;
  }
  reset();
  const query = vi.fn(async (cmd: string, _t?: number): Promise<string> => {
    if (cmd === ":SYSTem:ERRor?") return state.errors.shift() ?? '0,"No error"';
    if (cmd === ":INSTrument:SELect?") return state.module;
    if (cmd === ":CALCulate:FSCan:SLISt:SORT:TYPE?") return state.sortType;
    if (cmd === ":CALCulate:FSCan:SLISt:SORT:ORDer?") return state.sortOrder;
    throw new Error(`unexpected query ${cmd}`);
  });
  const sendCommand = vi.fn(async (cmd: string) => {
    if (cmd === "*CLS") { state.errors.length = 0; return; }
    calls.push(cmd);
    if (cmd === ":CALCulate:FSCan:SLISt:SORT:TYPE FREQuency") { state.sortType = "FREQuency"; return; }
    if (cmd === ":CALCulate:FSCan:SLISt:SORT:TYPE DAMPlitude1") { state.sortType = "DAMPlitude1"; return; }
    if (cmd === ":CALCulate:FSCan:SLISt:SORT:ORDer ASCending") { if (!state.ignoreOrderSet) state.sortOrder = "ASCending"; return; }
    if (cmd === ":CALCulate:FSCan:SLISt:SORT:ORDer DESCending") { if (!state.ignoreOrderSet) state.sortOrder = "DESCending"; return; }
    // Every signal-list action command: accepted, no state to model, no read-back exists.
    if (/^:CALCulate:FSCan:(MARKer\d:SET:SLISt|MAMarker:SET:SLISt|SLISt:)/.test(cmd)) return;
    state.errors.push('-113,"Undefined header"');
  });
  return { state, calls, reset, query, sendCommand };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const ctx = await createTestServer(registerEmiSignalListTools);
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

describe("tool listing", () => {
  it("registers all three signal-list tools with the right read-only hints", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["emi_signal_list", "get_emi_signal_list_sort", "set_emi_signal_list_sort"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.get_emi_signal_list_sort.annotations?.readOnlyHint).toBe(true);
    expect(byName.emi_signal_list.annotations?.readOnlyHint).toBe(false);
  });
});

describe("emi_signal_list", () => {
  it("accepts a no-argument action and says there is no read-back", async () => {
    const res = await callTool(client, "emi_signal_list", { action: "mark_all" });
    expect(res.isError).toBeUndefined();
    const out = json(res);
    expect(out.action).toBe("mark_all");
    expect(out.accepted).toBe(true);
    expect(out.note).toMatch(/No read-back/);
    expect(fake.calls).toEqual([":CALCulate:FSCan:SLISt:MARK:ALL"]);
  });

  it("sends the signal number for delete", async () => {
    await callTool(client, "emi_signal_list", { action: "delete", signal: 5 });
    expect(fake.calls).toEqual([":CALCulate:FSCan:SLISt:DELete:SIGNal 5"]);
  });

  it("sends the meter number for replace_with_meter", async () => {
    await callTool(client, "emi_signal_list", { action: "replace_with_meter", meter: 2 });
    expect(fake.calls).toEqual([":CALCulate:FSCan:SLISt:REPLace:METer 2"]);
  });

  it("sends the marker number for add_marker", async () => {
    await callTool(client, "emi_signal_list", { action: "add_marker", marker: 3 });
    expect(fake.calls).toEqual([":CALCulate:FSCan:MARKer3:SET:SLISt"]);
  });

  it("zoom_in/zoom_out omit the signal argument when not given", async () => {
    await callTool(client, "emi_signal_list", { action: "zoom_in" });
    expect(fake.calls).toEqual([":CALCulate:FSCan:SLISt:ZOOM"]);
    fake.calls.length = 0;
    await callTool(client, "emi_signal_list", { action: "zoom_out", signal: 7 });
    expect(fake.calls).toEqual([":CALCulate:FSCan:SLISt:ZOOM:OUT 7"]);
  });

  it("rejects an unknown action and an action missing its required argument", async () => {
    expect((await callTool(client, "emi_signal_list", { action: "bogus" })).isError).toBe(true);
    expect((await callTool(client, "emi_signal_list", { action: "delete" })).isError).toBe(true);
    expect((await callTool(client, "emi_signal_list", { action: "replace_with_meter" })).isError).toBe(true);
    expect((await callTool(client, "emi_signal_list", { action: "add_marker" })).isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });
});

describe("get_emi_signal_list_sort / set_emi_signal_list_sort", () => {
  it("reads the baseline sort", async () => {
    const out = json(await callTool(client, "get_emi_signal_list_sort", {}));
    expect(out).toEqual({ sort_type: "frequency", sort_order: "ascending" });
  });

  it("sets the sort type, round-tripping it", async () => {
    const out = json(await callTool(client, "set_emi_signal_list_sort", { sort_type: "amplitude1" }));
    expect(out.sort_type).toBe("amplitude1");
    expect(out.warnings).toEqual([]);
  });

  it("warns when the instrument did not take the requested order", async () => {
    fake.state.ignoreOrderSet = true; // models the instrument silently refusing the order change
    const out = json(await callTool(client, "set_emi_signal_list_sort", { sort_order: "descending" }));
    expect(out.warnings).toEqual(["sort_order adjusted by the instrument: requested descending, now ascending"]);
  });

  it("rejects no parameters", async () => {
    expect((await callTool(client, "set_emi_signal_list_sort", {})).isError).toBe(true);
  });
});

describe("wrong module", () => {
  it("refuses before sending anything when the instrument is not in EMI", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "emi_signal_list", { action: "mark_all" });
    expect(res.isError).toBe(true);
    expect(fake.query).toHaveBeenCalledTimes(1);
    expect(fake.calls).toEqual([]);
  });
});
