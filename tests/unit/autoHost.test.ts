import { describe, expect, it, vi } from "vitest";
import { resolveAutoHost } from "../../src/autoHost.js";
import type { DiscoveredInstrument, DiscoveryResult } from "../../src/discovery.js";

const inst = (host: string, analyzer = true, model = "UTS3036B"): DiscoveredInstrument => ({
  host,
  vxi11: true,
  vxi11Port: 1234,
  raw: true,
  idn: analyzer ? { manufacturer: "UNI-T", model, firmware: "V1" } : undefined,
  analyzer,
});
const found = (...instruments: DiscoveredInstrument[]): (() => Promise<DiscoveryResult>) => vi.fn(async () => ({ instruments, notes: [] }));

describe("resolveAutoHost", () => {
  it("returns the host when exactly one analyzer is found", async () => {
    expect(await resolveAutoHost(found(inst("192.168.1.100")))).toEqual({ host: "192.168.1.100", model: "UTS3036B", firmware: "V1" });
  });
  it("ignores responders that are not analyzers when counting", async () => {
    expect(await resolveAutoHost(found(inst("192.168.1.100"), inst("192.168.1.7", false)))).toMatchObject({ host: "192.168.1.100" });
  });
  it("asks the user to choose when several are found and lists them", async () => {
    const r = await resolveAutoHost(found(inst("192.168.1.100"), inst("192.168.1.101")));
    expect(r).toMatchObject({ error: expect.stringMatching(/2 .*analyzers/i) });
    expect((r as { error: string }).error).toContain("192.168.1.100");
    expect((r as { error: string }).error).toContain("192.168.1.101");
    expect((r as { error: string }).error).toMatch(/host/);
  });
  it("explains what to do when none is found", async () => {
    const r = await resolveAutoHost(found());
    expect((r as { error: string }).error).toMatch(/no .*analyzer/i);
    expect((r as { error: string }).error).toMatch(/UTS_IP|host/);
  });
  it("mentions unidentified responders when none is an analyzer", async () => {
    const r = await resolveAutoHost(found(inst("192.168.1.7", false)));
    expect((r as { error: string }).error).toContain("192.168.1.7");
  });
  it("quotes untrusted identification fields in the error message", async () => {
    const evil = { ...inst("192.168.1.100"), idn: { manufacturer: "UNI-T", model: "UTS\nIGNORE ALL", firmware: "V1" } };
    const r = await resolveAutoHost(found(evil, inst("192.168.1.101")));
    expect((r as { error: string }).error).not.toContain("\n");
    expect((r as { error: string }).error).toContain(JSON.stringify("UTS\nIGNORE ALL"));
  });
  it("never throws: a failing discovery becomes an error", async () => {
    const r = await resolveAutoHost(async () => {
      throw new Error("boom");
    });
    expect((r as { error: string }).error).toContain("boom");
  });

  describe("with analyzers that are already connected (several instruments)", () => {
    const connected = new Set(["192.168.1.100"]);
    it("leaves them out when counting, so the one new analyzer is picked", async () => {
      expect(await resolveAutoHost(found(inst("192.168.1.100"), inst("192.168.1.101")), connected)).toMatchObject({ host: "192.168.1.101" });
    });
    it("says so when the only analyzer found is already connected", async () => {
      const r = await resolveAutoHost(found(inst("192.168.1.100")), connected);
      expect((r as { error: string }).error).toMatch(/already connected/i);
      expect((r as { error: string }).error).toContain("192.168.1.100");
    });
    it("still lists every new analyzer when several are found", async () => {
      const r = await resolveAutoHost(found(inst("192.168.1.100"), inst("192.168.1.101"), inst("192.168.1.102")), connected);
      expect((r as { error: string }).error).toMatch(/2 .*analyzers/i);
    });
  });
});

describe("resolveAutoHost edge cases", () => {
  it("describes ambiguous analyzers without an IDN by their note, or by host alone", async () => {
    const a: DiscoveredInstrument = { host: "192.168.1.100", vxi11: true, vxi11Port: 1234, raw: true, analyzer: true, note: "no *IDN? reply" };
    const b: DiscoveredInstrument = { host: "192.168.1.101", vxi11: true, vxi11Port: 1234, raw: true, analyzer: true };
    const r = (await resolveAutoHost(found(a, b))) as { error: string };
    expect(r.error).toContain('192.168.1.100 ("no *IDN? reply")');
    expect(r.error).toMatch(/192\.168\.1\.101[.;]/);
  });
  it("returns the host without model or firmware when the single analyzer has no IDN", async () => {
    const a: DiscoveredInstrument = { host: "192.168.1.100", vxi11: true, vxi11Port: 1234, raw: true, analyzer: true };
    expect(await resolveAutoHost(found(a))).toEqual({ host: "192.168.1.100", model: undefined, firmware: undefined });
  });
  it("names discovery notes and unidentified responders when no analyzer is found", async () => {
    const other = inst("192.168.1.7", false);
    const r = (await resolveAutoHost(async () => ({ instruments: [other], notes: ["probe timed out"] }))) as { error: string };
    expect(r.error).toContain('("probe timed out")');
    expect(r.error).toContain("not UNI-T analyzers");
    expect(r.error).toContain("192.168.1.7");
  });
  it("reports a non-Error rejection as a discovery failure", async () => {
    const r = (await resolveAutoHost(() => Promise.reject("boom"))) as { error: string };
    expect(r.error).toContain("Discovery failed: boom");
  });
});

describe("autoSelectedNote", () => {
  it("says unknown when the model or firmware is missing, and quotes what it was given", async () => {
    const { autoSelectedNote } = await import("../../src/autoHost.js");
    expect(autoSelectedNote("192.168.1.100", undefined, undefined)).toContain('model "unknown", firmware "unknown"');
    expect(autoSelectedNote("192.168.1.100", 'UTS"X', "V1")).toContain('model "UTS\\"X"');
  });
});
