import { describe, it, expect } from "vitest";
import {
  formatNumber,
  formatWithUnit,
  onOff,
  parseNumber,
  parseNumberList,
  parseBool,
  checkCommand,
  assertAllowed,
  DangerousCommandError,
} from "../../src/scpi.js";

describe("formatNumber / formatWithUnit", () => {
  it("formats integers and decimals plainly", () => {
    expect(formatNumber(1500000000)).toBe("1500000000");
    expect(formatNumber(-20.5)).toBe("-20.5");
    expect(formatNumber(0)).toBe("0");
  });

  it("uses exponent form for very large and very small values", () => {
    expect(formatNumber(1.5e21)).toBe("1.5E21");
    expect(formatNumber(2.5e-9)).toBe("2.5E-9");
  });

  it("rejects NaN and infinities", () => {
    expect(() => formatNumber(NaN)).toThrow();
    expect(() => formatNumber(Infinity)).toThrow();
  });

  it("appends a unit with a space", () => {
    expect(formatWithUnit(100, "MHz")).toBe("100 MHz");
    expect(formatWithUnit(-10, "dBm")).toBe("-10 dBm");
  });

  it("onOff maps booleans", () => {
    expect(onOff(true)).toBe("ON");
    expect(onOff(false)).toBe("OFF");
  });
});

describe("parseNumber / parseNumberList", () => {
  it("parses plain, signed and exponent notation with whitespace", () => {
    expect(parseNumber("1.500000E+09\n")).toBe(1.5e9);
    expect(parseNumber(" -40.25 ")).toBe(-40.25);
    expect(parseNumber("10")).toBe(10);
  });

  it("throws on non-numeric or empty replies", () => {
    expect(() => parseNumber("")).toThrow();
    expect(() => parseNumber("abc")).toThrow();
    expect(() => parseNumber("1.2.3")).toThrow();
  });

  it("parses comma separated lists", () => {
    expect(parseNumberList("1,2.5, -3E1\n")).toEqual([1, 2.5, -30]);
    expect(parseNumberList("")).toEqual([]);
  });

  it("throws if any list entry is not numeric", () => {
    expect(() => parseNumberList("1,x,3")).toThrow();
  });
});

describe("parseBool", () => {
  it.each(["1", "ON", "on", "TRUE", " 1\n"])("%j is true", (v) => {
    expect(parseBool(v)).toBe(true);
  });
  it.each(["0", "OFF", "off", "FALSE"])("%j is false", (v) => {
    expect(parseBool(v)).toBe(false);
  });
  it("throws on anything else", () => {
    expect(() => parseBool("maybe")).toThrow();
    expect(() => parseBool("")).toThrow();
  });
});

describe("checkCommand denylist", () => {
  const blocked = [
    "*RST",
    "*rst",
    ":SYSTem:DEFault",
    ":syst:def",
    "SYST:DEF",
    ":SYSTem:LOCK ON",
    ":KEY:POWer:LOCK ON",
    ":KEY:ALL:LOCK 1",
    ":SYSTem:COMMunicate:LAN:IPADdress 192.168.1.100",
    ":syst:comm:lan:ipad 192.168.1.100",
    ":SYSTem:COMMunicate:LAN:SMASk 255.255.255.0",
    ":SYSTem:CONFigure:SOMething 1",
    ':MMEMory:STORe:STATe "A"',
    ":mmem:stor:stat 1",
  ];
  it.each(blocked)("blocks %s", (cmd) => {
    const r = checkCommand(cmd);
    expect(r.allowed).toBe(false);
  });

  const allowed = [
    "*IDN?",
    "*OPC?",
    ":FREQuency:CENTer 1 GHz",
    ":FREQ:CENT?",
    ":SYSTem:COMMunicate:LAN:IPADdress?",
    ":SYST:COMM:LAN:IPAD?",
    ":SYSTem:DEFault?",
    ":MMEMory:LOAD:STATe 1",
    ":DISPlay:ZBmp?",
  ];
  it.each(allowed)("allows %s", (cmd) => {
    expect(checkCommand(cmd)).toEqual({ allowed: true });
  });

  it("checks every command in a compound line", () => {
    expect(checkCommand(":FREQ:CENT 1 GHz;:SYST:DEF").allowed).toBe(false);
    expect(checkCommand(":FREQ:CENT 1 GHz;*RST").allowed).toBe(false);
    expect(checkCommand(":FREQ:CENT 1 GHz;:FREQ:SPAN 1 MHz").allowed).toBe(true);
  });

  it("resolves relative paths after a semicolon", () => {
    expect(checkCommand(":SYSTem:COMMunicate:LAN:DHCP?;IPAD 1.2.3.4").allowed).toBe(false);
  });

  it("does not split on semicolons inside quoted strings", () => {
    expect(checkCommand(':MMEMory:CATalog? "a;*RST"').allowed).toBe(true);
  });

  it("gives a reason when blocked", () => {
    const r = checkCommand("*RST");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/confirm/i);
  });
});

describe("assertAllowed", () => {
  it("throws DangerousCommandError without confirm", () => {
    expect(() => assertAllowed("*RST")).toThrow(DangerousCommandError);
    expect(() => assertAllowed("*RST", false)).toThrow(DangerousCommandError);
  });
  it("passes with confirm=true and for safe commands", () => {
    expect(() => assertAllowed("*RST", true)).not.toThrow();
    expect(() => assertAllowed("*IDN?")).not.toThrow();
  });
});

describe("checkCommand hardening (#31)", () => {
  it.each([
    ":FREQ:CENT 1 GHz\n:SYST:DEF",
    ":FREQ:CENT 1 GHz\r*RST",
    ":FREQ:CENT 1 GHz\r\n:SYST:COMM:LAN:IPAD 1.2.3.4",
    "*IDN?\nSYST:DEF",
  ])("blocks a denylisted command after an embedded terminator: %j", (cmd) => {
    expect(checkCommand(cmd).allowed).toBe(false);
  });

  it("a newline starts a new program message (path resets)", () => {
    // After a newline, "IPAD ..." has no parent path, so it is not a LAN setter.
    expect(checkCommand(":SYST:COMM:LAN:DHCP?\nIPAD 1.2.3.4").allowed).toBe(true);
    // ...whereas after ';' it is relative to the previous path.
    expect(checkCommand(":SYST:COMM:LAN:DHCP?;IPAD 1.2.3.4").allowed).toBe(false);
  });

  it("allows a harmless trailing newline", () => {
    expect(checkCommand("*IDN?\n").allowed).toBe(true);
    expect(checkCommand(":FREQ:CENT?\r\n").allowed).toBe(true);
  });

  it.each(["\u0000", "\u001b", "\u007f"])("blocks control character %j", (ch) => {
    expect(checkCommand(`:FREQ:CENT?${ch}`).allowed).toBe(false);
  });

  it.each(["*SAV 1", "*sav 2", "*SAV"])("blocks %s", (cmd) => {
    expect(checkCommand(cmd).allowed).toBe(false);
  });

  it("does not block unrelated common commands", () => {
    for (const cmd of ["*RCL 1", "*IDN?", "*OPC?", "*CLS", "*ESR?"]) {
      expect(checkCommand(cmd).allowed).toBe(true);
    }
  });

  it.each([':MMEMory:CATalog? "abc', ":MMEMory:CATalog? 'abc", ':FOO "a";*RST "'])(
    "fails closed on an unterminated quote: %s",
    (cmd) => {
      expect(checkCommand(cmd).allowed).toBe(false);
    }
  );

  it("skips # blocks by declared length (content with ; quotes and newlines is data)", () => {
    // 9 bytes of data: a;"b'\nc*R  (contains ; quote apostrophe newline)
    const data = "a;\"b'\nc*R";
    expect(data.length).toBe(9);
    expect(checkCommand(`:FOO:DATA #19${data}`).allowed).toBe(true);
  });

  it("still catches a denylisted command that follows a # block", () => {
    const data = "a;b";
    expect(checkCommand(`:FOO:DATA #13${data};*RST`).allowed).toBe(false);
    expect(checkCommand(`:FOO:DATA #13${data}\n:SYST:DEF`).allowed).toBe(false);
  });

  it("fails closed on a malformed or truncated # block", () => {
    expect(checkCommand(":FOO:DATA #1").allowed).toBe(false);
    expect(checkCommand(":FOO:DATA #3ab").allowed).toBe(false);
    expect(checkCommand(":FOO:DATA #2xx12").allowed).toBe(false);
    expect(checkCommand(":FOO:DATA #5001000123").allowed).toBe(false);
  });

  it("fails closed on non-ASCII input (block lengths are counted in bytes)", () => {
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes: a #<len> block could be misjudged.
    expect(checkCommand(":FOO:DATA #12é;*RST").allowed).toBe(false);
    expect(checkCommand(":DISP:TEXT \"café\"").allowed).toBe(false);
    expect(checkCommand(":FREQ:CENT? \u2028").allowed).toBe(false);
  });

  it("blocks Unicode whitespace that could fake a header end or # block", () => {
    expect(checkCommand(":FOO\u00a0#13a;b;*RST").allowed).toBe(false);
    expect(checkCommand(":FOO\u0085:SYST:DEF").allowed).toBe(false);
  });

  it("fails closed on a lone CR (the instrument may not treat it as a terminator)", () => {
    expect(checkCommand(":SYST:COMM:LAN:DHCP?\rIPAD 1.2.3.4").allowed).toBe(false);
    expect(checkCommand(":FREQ:CENT?\r").allowed).toBe(false);
  });

  it("still accepts CRLF and LF terminators", () => {
    expect(checkCommand(":FREQ:CENT?\r\n").allowed).toBe(true);
    expect(checkCommand(":FREQ:CENT?\n").allowed).toBe(true);
  });
});
