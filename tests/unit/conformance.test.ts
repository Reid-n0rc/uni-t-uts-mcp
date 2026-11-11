import { describe, it, expect } from "vitest";
import {
  redact,
  formatTranscript,
  parseTranscript,
  diffTranscripts,
  runExchange,
  EXCHANGE,
  RESTORE_PLAN,
  refuseReason,
} from "../../scripts/conformance-lib.mjs";

describe("redact", () => {
  it("blanks the serial in an *IDN? reply", () => {
    expect(redact("UNI-TREND,UTS3036B,SN123456789,V1.04.0040")).toBe("UNI-TREND,UTS3036B,<serial>,V1.04.0040");
  });
  it("blanks IPv4 addresses and MAC addresses anywhere in a line", () => {
    expect(redact("host 10.26.0.14 gw 192.168.1.1")).toBe("host <ip> gw <ip>");
    expect(redact("mac AA:bb:CC:01:02:03 and 00-11-22-33-44-55")).toBe("mac <mac> and <mac>");
  });
  it("blanks the serial of an *IDN? reply embedded in other text", () => {
    expect(redact("Device: UNI-TREND,UTS3036B,ASA0000000000,V1.04.0040 Note")).toBe("Device: UNI-TREND,UTS3036B,<serial>,V1.04.0040 Note");
  });
  it("leaves ordinary replies alone", () => {
    for (const s of ['0,"No error"', "1.000000000000e+09", "ASC8", "3.0.0.1x"]) expect(redact(s)).toBe(s);
  });
  it("also redacts a serial given on its own line of a known IDN shape in other casings", () => {
    expect(redact("uni-trend,uts3036b,abc,v1")).toBe("uni-trend,uts3036b,<serial>,v1");
  });
});

describe("transcript format", () => {
  const entries = [
    { cmd: "*IDN?", reply: "UNI-TREND,UTS3036B,<serial>,V1.04.0040" },
    { cmd: ":FREQuency:CENTer 1 GHz" },
    { cmd: ":INPut:IMPedance?", reply: null },
  ];
  it("formats commands, replies and silence", () => {
    expect(formatTranscript(entries)).toBe(
      "> *IDN?\n< UNI-TREND,UTS3036B,<serial>,V1.04.0040\n> :FREQuency:CENTer 1 GHz\n> :INPut:IMPedance?\n< <no reply>\n",
    );
  });
  it("round-trips through parse and ignores # comments and blank lines", () => {
    expect(parseTranscript("# note\n" + formatTranscript(entries) + "\n")).toEqual(entries);
  });
  it("rejects a reply line without a command", () => {
    expect(() => parseTranscript("< orphan\n")).toThrow(/line 1/);
  });
});

describe("diffTranscripts", () => {
  const a = [{ cmd: "A?", reply: "1" }, { cmd: "B?", reply: "2" }];
  it("reports identical transcripts", () => {
    expect(diffTranscripts(a, a)).toMatchObject({ identical: true, differences: [], unexplained: 0 });
  });
  it("reports a changed reply with its position and both values", () => {
    const d = diffTranscripts(a, [a[0]!, { cmd: "B?", reply: "3" }]);
    expect(d.identical).toBe(false);
    expect(d.unexplained).toBe(1);
    expect(d.differences).toEqual([{ index: 1, cmd: "B?", expected: "2", actual: "3", known: null }]);
  });
  it("reports missing and extra entries", () => {
    const d = diffTranscripts(a, [a[0]!]);
    expect(d.differences).toEqual([{ index: 1, cmd: "B?", expected: "2", actual: "<missing>", known: null }]);
    const e = diffTranscripts([a[0]!], a);
    expect(e.differences).toEqual([{ index: 1, cmd: "B?", expected: "<missing>", actual: "2", known: null }]);
  });
  it("reports a different command at the same position", () => {
    const d = diffTranscripts(a, [a[0]!, { cmd: "C?", reply: "2" }]);
    expect(d.unexplained).toBe(1);
    expect(d.differences[0]).toMatchObject({ index: 1, cmd: "B?", actual: "C? -> 2" });
  });
  it("marks a difference that matches a documented divergence as known, not unexplained", () => {
    const d = diffTranscripts(a, [a[0]!, { cmd: "B?", reply: "3" }], [{ cmd: "B?", actual: "^3$", note: "doc" }]);
    expect(d.identical).toBe(false);
    expect(d.unexplained).toBe(0);
    expect(d.differences[0]!.known).toBe("doc");
  });
  it("a known divergence whose actual value does not match stays unexplained", () => {
    const d = diffTranscripts(a, [a[0]!, { cmd: "B?", reply: "4" }], [{ cmd: "B?", actual: "^3$", note: "doc" }]);
    expect(d.unexplained).toBe(1);
  });
});

describe("the exchange script", () => {
  it("never uses a forbidden command", () => {
    const all = [...EXCHANGE.map((s: any) => s.cmd ?? ""), ...RESTORE_PLAN.map((r: any) => r.set ?? "")].join("\n");
    expect(all).not.toMatch(/\*RST|:SYSTem:DEFault|:SYST(em)?:LOCK|:KEY|:MMEMory|:LAN|:SYSTem:COMMunicate/i);
  });
  it("every step is a command or a wait", () => {
    for (const s of EXCHANGE as any[]) expect(typeof s.cmd === "string" || typeof s.wait === "number").toBe(true);
  });
});

describe("runExchange", () => {
  /** A scripted client: records what is sent and answers queries from a table. */
  function fakeClient(answers: Record<string, string | null>) {
    const sent: string[] = [];
    return {
      sent,
      async query(cmd: string) { sent.push(cmd); return cmd in answers ? answers[cmd]! : "0"; },
      async send(cmd: string) { sent.push(cmd); },
      async sleep() {},
    };
  }
  it("snapshots first, records the steps, and restores last", async () => {
    const c = fakeClient({});
    const out = await runExchange(c, { steps: [{ cmd: "X?" }, { cmd: "Y 1" }], plan: [{ get: "G?", set: "S" }] });
    expect(c.sent[0]).toBe("G?");
    expect(out.entries).toEqual([{ cmd: "X?", reply: "0" }, { cmd: "Y 1" }]);
    expect(c.sent.at(-1)).toMatch(/^S 0$|\*OPC\?$|:SYSTem:ERRor\?$/);
    expect(c.sent.filter((s) => s === "S 0")).toHaveLength(1);
    expect(out.restoreProblems).toEqual([]);
  });
  it("records a silent query as no reply", async () => {
    const c = fakeClient({ "X?": null });
    const out = await runExchange(c, { steps: [{ cmd: "X?" }], plan: [] });
    expect(out.entries).toEqual([{ cmd: "X?", reply: null }]);
  });
  it("still restores when a step throws, and reports the failure", async () => {
    const c = fakeClient({});
    c.query = async (cmd: string) => { c.sent.push(cmd); if (cmd === "X?") throw new Error("boom"); return "0"; };
    await expect(runExchange(c, { steps: [{ cmd: "X?" }], plan: [{ get: "G?", set: "S" }] })).rejects.toThrow(/boom/);
    expect(c.sent).toContain("S 0");
  });
  it("flags a setting that did not read back as it was", async () => {
    const answers: Record<string, string> = { "G?": "5" };
    const c = fakeClient(answers);
    const real = c.query;
    let n = 0;
    c.query = async (cmd: string) => (cmd === "G?" && ++n === 2 ? "6" : real(cmd));
    const out = await runExchange(c, { steps: [], plan: [{ get: "G?", set: "S" }] });
    expect(out.restoreProblems).toHaveLength(1);
    expect(out.restoreProblems[0]).toMatch(/G\?/);
  });
});

describe("refuseReason (the live run is opt-in and never in CI)", () => {
  it("refuses without UTS_IP, without the flag, and in CI", () => {
    expect(refuseReason({})).toMatch(/UTS_IP/);
    expect(refuseReason({ UTS_IP: "192.168.1.100" })).toMatch(/UTS_CONFORMANCE_LIVE/);
    expect(refuseReason({ UTS_IP: "192.168.1.100", UTS_CONFORMANCE_LIVE: "1", CI: "true" })).toMatch(/CI/);
    expect(refuseReason({ UTS_IP: "192.168.1.100", UTS_CONFORMANCE_LIVE: "1" })).toBeNull();
  });
});
