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
