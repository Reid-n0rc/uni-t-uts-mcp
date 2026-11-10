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
    expect(await resolveAutoHost(found(inst("192.168.1.100")))).toEqual({ host: "192.168.1.100", model: "UTS3036B" });
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
});
