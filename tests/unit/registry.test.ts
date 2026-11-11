import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_INSTRUMENT,
  InstrumentRegistry,
  InstrumentSelectionError,
  instrumentTargetsFromEnv,
  isValidInstrumentName,
  parseInstrumentsEnv,
} from "../../src/registry.js";

describe("isValidInstrumentName", () => {
  it.each(["default", "scope1", "SA-2", "bench_a", "a"])("accepts %s", (n) => expect(isValidInstrumentName(n)).toBe(true));
  it.each(["", " a", "a b", "a=b", "a,b", "-a", "a/b", "x".repeat(33), "a\n", "é"])("rejects %j", (n) => expect(isValidInstrumentName(n)).toBe(false));
});

describe("parseInstrumentsEnv: name=host:port list", () => {
  it("parses entries with and without a port", () => {
    const t = parseInstrumentsEnv("sa1=192.168.1.101:5026, sa2=analyzer.local");
    expect([...t]).toEqual([
      ["sa1", { host: "192.168.1.101", port: 5026 }],
      ["sa2", { host: "analyzer.local", port: undefined }],
    ]);
  });
  it("takes IPv6 only in brackets", () => {
    expect(parseInstrumentsEnv("a=[fd00::1]:5030").get("a")).toEqual({ host: "fd00::1", port: 5030 });
    expect(parseInstrumentsEnv("a=[fd00::1]").get("a")).toEqual({ host: "fd00::1", port: undefined });
    expect(() => parseInstrumentsEnv("a=fd00::1")).toThrow(/brackets/);
  });
  it("is empty for unset or blank", () => {
    expect(parseInstrumentsEnv(undefined).size).toBe(0);
    expect(parseInstrumentsEnv("  ").size).toBe(0);
  });
  it.each([
    ["a", /name=host/],
    ["=1.2.3.4", /name/],
    ["bad name=1.2.3.4", /name/],
    ["a=", /host/],
    ["a=1.2.3.4:0", /port/],
    ["a=1.2.3.4:70000", /port/],
    ["a=1.2.3.4:abc", /port/],
    ["a=bad/host", /host/],
    ["a=1.2.3.4,a=1.2.3.5", /duplicate/i],
    ["a=1.2.3.4,,b=1.2.3.5", /empty/i],
  ])("rejects %j with a message naming UTS_INSTRUMENTS", (spec, re) => {
    expect(() => parseInstrumentsEnv(spec)).toThrow(/UTS_INSTRUMENTS/);
    expect(() => parseInstrumentsEnv(spec)).toThrow(re);
  });
});

describe("parseInstrumentsEnv: JSON", () => {
  it("accepts an object of strings and objects", () => {
    const t = parseInstrumentsEnv('{"sa1":"192.168.1.101:5026","sa2":{"host":"192.168.1.102","port":5027},"sa3":{"host":"h"}}');
    expect(t.get("sa1")).toEqual({ host: "192.168.1.101", port: 5026 });
    expect(t.get("sa2")).toEqual({ host: "192.168.1.102", port: 5027 });
    expect(t.get("sa3")).toEqual({ host: "h", port: undefined });
  });
  it("accepts an array of {name, host, port}", () => {
    const t = parseInstrumentsEnv('[{"name":"a","host":"192.168.1.101"},{"name":"b","host":"192.168.1.102","port":5026}]');
    expect([...t.keys()]).toEqual(["a", "b"]);
    expect(t.get("b")).toEqual({ host: "192.168.1.102", port: 5026 });
  });
  it.each([
    ["{", /JSON/],
    ["[1]", /object/],
    ['{"a":5}', /host/],
    ['{"a":{"host":"h","extra":1}}', /extra/],
    ['{"a":{"port":5025}}', /host/],
    ['{"a":{"host":"h","port":"5025"}}', /port/],
    ['{"a":{"host":"h","port":99999}}', /port/],
    ['{"bad name":"h"}', /name/],
    ['[{"name":"a","host":"h"},{"name":"a","host":"i"}]', /duplicate/i],
    ['[{"host":"h"}]', /name/],
  ])("rejects %j", (spec, re) => {
    expect(() => parseInstrumentsEnv(spec)).toThrow(/UTS_INSTRUMENTS/);
    expect(() => parseInstrumentsEnv(spec)).toThrow(re);
  });
});

describe("instrumentTargetsFromEnv", () => {
  it("returns the UTS_INSTRUMENTS entries", () => {
    expect([...instrumentTargetsFromEnv({ UTS_INSTRUMENTS: "a=1.2.3.4" }).keys()]).toEqual(["a"]);
  });
  it("refuses a default entry together with UTS_IP", () => {
    expect(() => instrumentTargetsFromEnv({ UTS_IP: "1.2.3.4", UTS_INSTRUMENTS: "default=1.2.3.5" })).toThrow(/UTS_IP.*default|default.*UTS_IP/);
  });
  it("allows a default entry without UTS_IP", () => {
    expect(instrumentTargetsFromEnv({ UTS_INSTRUMENTS: "default=1.2.3.5" }).has(DEFAULT_INSTRUMENT)).toBe(true);
  });
});

describe("InstrumentRegistry", () => {
  const make = () => new InstrumentRegistry<{ id: string }>((name) => ({ id: name }));

  it("creates the default instrument on first use when nothing is declared", () => {
    const r = make();
    expect(r.resolve()).toEqual({ id: "default" });
    expect(r.names()).toEqual(["default"]);
  });
  it("returns the same object for the same name", () => {
    const r = make();
    expect(r.declare("a")).toBe(r.declare("a"));
    expect(r.resolve("a")).toBe(r.get("a"));
  });
  it("omitting the name picks the only instrument, whatever it is called", () => {
    const r = make();
    r.declare("scope");
    expect(r.resolve()).toBe(r.get("scope"));
  });
  it("omitting the name picks `default` when several are declared", () => {
    const r = make();
    r.declare("a");
    r.declare("default");
    expect(r.resolve()).toBe(r.get("default"));
  });
  it("omitting the name is an actionable error when several are declared and none is `default`", () => {
    const r = make();
    r.declare("a");
    r.declare("b");
    expect(() => r.resolve()).toThrow(InstrumentSelectionError);
    expect(() => r.resolve()).toThrow(/a, b.*instrument/s);
  });
  it("an unknown name lists the configured ones and does not create it", () => {
    const r = make();
    r.declare("a");
    expect(() => r.resolve("nope")).toThrow(/Unknown instrument "nope".*a/s);
    expect(r.names()).toEqual(["a"]);
  });
  it("rejects invalid names", () => {
    const r = make();
    expect(() => r.declare("bad name")).toThrow(/name/);
    expect(() => r.resolve("bad name")).toThrow(InstrumentSelectionError);
  });
  it("remembers a declared target", () => {
    const r = make();
    r.declare("a", { host: "h", port: 1 });
    expect(r.target("a")).toEqual({ host: "h", port: 1 });
    expect(r.target("zzz")).toBeUndefined();
  });
  it("list() reports name, target and the connection's state through a callback", () => {
    const r = make();
    r.declare("a", { host: "h", port: 1 });
    r.declare("b");
    expect(r.list()).toEqual([
      { name: "a", target: { host: "h", port: 1 } },
      { name: "b", target: undefined },
    ]);
  });
  it("current() follows runWith, also across awaits, and falls back to resolve()", async () => {
    const r = make();
    const a = r.declare("a");
    const b = r.declare("b");
    r.declare("default");
    expect(r.current()).toBe(r.get("default"));
    const seen: unknown[] = [];
    await Promise.all([
      r.runWith(a, async () => { await new Promise((x) => setTimeout(x, 10)); seen.push(r.current()); }),
      r.runWith(b, async () => { seen.push(r.current()); await new Promise((x) => setTimeout(x, 20)); seen.push(r.current()); }),
    ]);
    expect(seen).toEqual([b, a, b]);
  });
  it("remove() forgets an instrument and its target", () => {
    const r = make();
    r.declare("a", { host: "h" });
    r.declare("b");
    expect(r.remove("a")).toBe(true);
    expect(r.remove("a")).toBe(false);
    expect(r.names()).toEqual(["b"]);
    expect(r.target("a")).toBeUndefined();
  });
  it("shutdown() shuts every connection down even when one fails", async () => {
    const calls: string[] = [];
    const r = new InstrumentRegistry<{ shutdown(): Promise<void> }>((name) => ({
      shutdown: async () => { calls.push(name); if (name === "a") throw new Error("boom"); },
    }));
    r.declare("a");
    r.declare("b");
    await r.shutdown();
    expect(calls.sort()).toEqual(["a", "b"]);
  });
  it("shutdown() with nothing declared does not create the default instrument", async () => {
    const factory = vi.fn(() => ({ shutdown: async () => {} }));
    const r = new InstrumentRegistry(factory);
    await r.shutdown();
    expect(factory).not.toHaveBeenCalled();
  });
});
