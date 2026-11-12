import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import { registerAdAudioTools } from "../../src/tools/adAudio.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Stateful fake: AD module filter/speaker/volume settings, errors and *CLS/*OPC? bookkeeping. */
const fake = vi.hoisted(() => {
  const defaults = {
    module: "AD" as "SA" | "EMI" | "AD",
    demodType: "AM" as "AM" | "FM",
    lowPassFilter: "OFF",
    highPassFilter: "OFF",
    bandPassFilter: "OFF",
    speaker: false,
    volumePct: 30,
  };
  const state = { ...defaults, errors: [] as string[] };
  const calls: string[] = [];

  function reply(cmd: string): string {
    if (/^:INSTrument(:SELect)?\?$/.test(cmd)) return state.module;
    if (/^\*OPC\?$/.test(cmd)) return "1";
    if (/^:SYSTem:ERRor\?$/.test(cmd)) {
      if (state.errors.length === 0) return `0,"No error"`;
      return state.errors.shift()!;
    }
    if (/^:CONFigure\?$/.test(cmd)) return state.demodType;
    if (/^:(AM|FM):LPFilter\?$/.test(cmd)) return state.lowPassFilter;
    if (/^:(AM|FM):HPFilter\?$/.test(cmd)) return state.highPassFilter;
    if (/^:(AM|FM):BPFilter\?$/.test(cmd)) return state.bandPassFilter;
    if (/^:SPEaker:STATe\?$/.test(cmd)) return state.speaker ? "1" : "0";
    if (/^:SYSTem:VOLume\?$/.test(cmd)) return String(state.volumePct);
    throw new Error(`fake: no reply for ${cmd}`);
  }

  function apply(cmd: string): void {
    if (cmd === "*CLS") {
      state.errors.length = 0;
      return;
    }
    let m = /^:(AM|FM):LPFilter (\S+)$/.exec(cmd);
    if (m) {
      state.lowPassFilter = m[2];
      if (m[2] !== "OFF") state.bandPassFilter = "OFF";
      return;
    }
    m = /^:(AM|FM):HPFilter (\S+)$/.exec(cmd);
    if (m) {
      state.highPassFilter = m[2];
      if (m[2] !== "OFF") state.bandPassFilter = "OFF";
      return;
    }
    m = /^:(AM|FM):BPFilter (\S+)$/.exec(cmd);
    if (m) {
      state.bandPassFilter = m[2];
      if (m[2] !== "OFF") {
        state.lowPassFilter = "OFF";
        state.highPassFilter = "OFF";
      }
      return;
    }
    m = /^:SPEaker:STATe (ON|OFF)$/.exec(cmd);
    if (m) {
      state.speaker = m[1] === "ON";
      return;
    }
    m = /^:SYSTem:VOLume (\d+)$/.exec(cmd);
    if (m) {
      state.volumePct = Number(m[1]);
      return;
    }
    throw new Error(`fake: no handler for command ${cmd}`);
  }

  const query = vi.fn(async (cmd: string) => reply(cmd));
  const sendCommand = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    apply(cmd);
  });
  function reset() {
    Object.assign(state, defaults, { errors: [] });
    calls.length = 0;
  }
  return { state, calls, query, sendCommand, reset };
});

vi.mock("../../src/connection.js", () => ({
  connection: { query: fake.query, sendCommand: fake.sendCommand, msSinceQueryTimeout: () => Infinity, runExclusive: (fn: () => unknown) => fn() },
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer(registerAdAudioTools);
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

describe("set_ad_filters", () => {
  it("sets the low-pass filter and reports no warnings when nothing else was on", async () => {
    const res = await callTool(client, "set_ad_filters", { low_pass_filter: "LPF3K" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.low_pass_filter).toBe("LPF3K");
    expect(data.high_pass_filter).toBe("OFF");
    expect(data.band_pass_filter).toBe("OFF");
    expect(data.warnings).toEqual([]);
  });

  it("warns that the band-pass filter was turned off when a low-pass filter is set", async () => {
    fake.state.bandPassFilter = "AWEighting";
    const res = await callTool(client, "set_ad_filters", { low_pass_filter: "LPF300" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.band_pass_filter).toBe("OFF");
    expect(data.warnings).toEqual([expect.stringContaining("band_pass_filter turned off by the instrument")]);
  });

  it("warns that low- and high-pass were turned off when a band-pass filter is set", async () => {
    fake.state.lowPassFilter = "LPF300";
    fake.state.highPassFilter = "HPF20";
    const res = await callTool(client, "set_ad_filters", { band_pass_filter: "CCIR2k" });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.low_pass_filter).toBe("OFF");
    expect(data.high_pass_filter).toBe("OFF");
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("low_pass_filter turned off by the instrument"),
        expect.stringContaining("high_pass_filter turned off by the instrument"),
      ])
    );
  });

  it("rejects more than one filter family in one call", async () => {
    const res = await callTool(client, "set_ad_filters", { low_pass_filter: "LPF300", high_pass_filter: "HPF20" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/at most one filter family/i);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects an empty call", async () => {
    const res = await callTool(client, "set_ad_filters", {});
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("uses the FM prefix when :CONFigure? reports FM", async () => {
    fake.state.demodType = "FM";
    const res = await callTool(client, "set_ad_filters", { high_pass_filter: "HPF50" });
    expect(res.isError).toBeUndefined();
    expect(fake.calls).toContain(":FM:HPFilter HPF50");
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "SA";
    const res = await callTool(client, "set_ad_filters", { low_pass_filter: "LPF300" });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});

describe("set_ad_audio", () => {
  it("rejects an empty call", async () => {
    const res = await callTool(client, "set_ad_audio", {});
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects turning the speaker on without confirm", async () => {
    const res = await callTool(client, "set_ad_audio", { speaker: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/confirm/i);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("turns the speaker on with confirm, then restores it off by default", async () => {
    const res = await callTool(client, "set_ad_audio", { speaker: true, confirm: true });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.speaker).toBe(false); // restored
    expect(data.restored).toBe(true);
    expect(data.warnings).toEqual([]);
    expect(fake.calls).toEqual(["*CLS", ":SPEaker:STATe ON", "*CLS", ":SPEaker:STATe OFF"]);
    expect(fake.state.speaker).toBe(false);
  });

  it("keeps the speaker on when keep=true", async () => {
    const res = await callTool(client, "set_ad_audio", { speaker: true, confirm: true, keep: true });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.speaker).toBe(true);
    expect(data.restored).toBe(false);
    expect(fake.state.speaker).toBe(true);
  });

  it("sets volume without confirm when the speaker is off, then restores it", async () => {
    const res = await callTool(client, "set_ad_audio", { volume_pct: 60 });
    expect(res.isError).toBeUndefined();
    const data = json(res);
    expect(data.volume_pct).toBe(30); // restored to the default
    expect(data.restored).toBe(true);
    expect(fake.state.volumePct).toBe(30);
  });

  it("rejects raising the volume without confirm while the speaker is already on", async () => {
    fake.state.speaker = true;
    fake.state.volumePct = 20;
    const res = await callTool(client, "set_ad_audio", { volume_pct: 50 });
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/confirm/i);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });

  it("allows raising the volume with confirm while the speaker is on", async () => {
    fake.state.speaker = true;
    fake.state.volumePct = 20;
    const res = await callTool(client, "set_ad_audio", { volume_pct: 50, confirm: true, keep: true });
    expect(res.isError).toBeUndefined();
    expect(json(res).volume_pct).toBe(50);
  });

  it("allows lowering the volume while the speaker is on without confirm", async () => {
    fake.state.speaker = true;
    fake.state.volumePct = 50;
    const res = await callTool(client, "set_ad_audio", { volume_pct: 20, keep: true });
    expect(res.isError).toBeUndefined();
    expect(json(res).volume_pct).toBe(20);
  });

  it("refuses when the module is not AD", async () => {
    fake.state.module = "EMI";
    const res = await callTool(client, "set_ad_audio", { volume_pct: 10 });
    expect(res.isError).toBe(true);
    expect(fake.sendCommand).not.toHaveBeenCalled();
  });
});
