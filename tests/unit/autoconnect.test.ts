import { describe, it, expect, vi } from "vitest";
import { autoConnectAll, autoConnectFromEnv } from "../../src/autoconnect.js";

function fakeConnection(impl?: () => Promise<string>) {
  return { connect: vi.fn(impl ?? (async (_h: string, _p: number, _o?: unknown) => "UNI-TREND,UTS0000X,<serial>,V0.0.0")) };
}

describe("autoConnectFromEnv", () => {
  it("does nothing when UTS_IP is unset", async () => {
    const conn = fakeConnection();
    const log = vi.fn();
    expect(await autoConnectFromEnv({}, conn, log)).toBe(false);
    expect(conn.connect).not.toHaveBeenCalled();
  });

  it("connects with UTS_IP, the default port and the auto transport", async () => {
    const conn = fakeConnection();
    const log = vi.fn();
    expect(await autoConnectFromEnv({ UTS_IP: "192.168.1.100" }, conn, log)).toBe(true);
    expect(conn.connect).toHaveBeenCalledWith("192.168.1.100", 5025, expect.objectContaining({ transport: "auto", vxi11Device: "inst0" }));
    expect(log.mock.calls.join(" ")).toContain("UTS0000X");
  });

  it("a UTS_TRANSPORT of auto or vxi11 is used even when UTS_PORT is set", async () => {
    const conn = fakeConnection();
    await autoConnectFromEnv({ UTS_IP: "192.168.1.100", UTS_PORT: "5555", UTS_TRANSPORT: "auto" }, conn, vi.fn());
    expect(conn.connect).toHaveBeenCalledWith("192.168.1.100", 5555, expect.objectContaining({ transport: "auto" }));
  });

  it("honors UTS_PORT (and then means the raw transport unless UTS_TRANSPORT says otherwise)", async () => {
    const conn = fakeConnection();
    await autoConnectFromEnv({ UTS_IP: "192.168.1.100", UTS_PORT: "5555" }, conn, vi.fn());
    expect(conn.connect).toHaveBeenCalledWith("192.168.1.100", 5555, expect.objectContaining({ transport: "raw" }));
  });

  it("never throws: logs a failed connection and returns false", async () => {
    const conn = fakeConnection(async () => {
      throw new Error("Connection failed: ECONNREFUSED");
    });
    const log = vi.fn();
    expect(await autoConnectFromEnv({ UTS_IP: "192.168.1.100" }, conn, log)).toBe(false);
    expect(log.mock.calls.join(" ")).toContain("ECONNREFUSED");
    expect(log.mock.calls.join(" ")).toContain("connect");
  });

  it("logs and skips connecting for an invalid UTS_PORT or UTS_IP", async () => {
    const conn = fakeConnection();
    const log = vi.fn();
    expect(await autoConnectFromEnv({ UTS_IP: "192.168.1.100", UTS_PORT: "99999" }, conn, log)).toBe(false);
    expect(await autoConnectFromEnv({ UTS_IP: "bad host" }, conn, log)).toBe(false);
    expect(conn.connect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("never rejects even when the logger itself throws (the caller fires and forgets it)", async () => {
    const throwingLog = vi.fn(() => {
      throw new Error("EPIPE");
    });
    const failing = fakeConnection(async () => {
      throw new Error("Connection failed: ECONNREFUSED");
    });
    await expect(autoConnectFromEnv({ UTS_IP: "192.168.1.100" }, failing, throwingLog)).resolves.toBe(false);
    await expect(autoConnectFromEnv({ UTS_IP: "192.168.1.100" }, fakeConnection(), throwingLog)).resolves.toBe(true);
  });
});

describe("autoConnectFromEnv transport selection (#74)", () => {
  it("passes UTS_TRANSPORT and UTS_VXI11_DEVICE through and logs the log function for fallbacks", async () => {
    const conn = fakeConnection();
    await autoConnectFromEnv(
      { UTS_IP: "192.168.1.100", UTS_TRANSPORT: "auto", UTS_VXI11_DEVICE: "inst1" },
      conn,
      vi.fn()
    );
    expect(conn.connect).toHaveBeenCalledWith(
      "192.168.1.100",
      5025,
      expect.objectContaining({ transport: "auto", vxi11Device: "inst1", log: expect.any(Function) })
    );
  });

  it("logs and skips connecting for an invalid UTS_TRANSPORT or UTS_VXI11_DEVICE", async () => {
    for (const env of [{ UTS_TRANSPORT: "serial" }, { UTS_VXI11_DEVICE: "bad dev" }]) {
      const conn = fakeConnection();
      const log = vi.fn();
      expect(await autoConnectFromEnv({ UTS_IP: "192.168.1.100", ...env }, conn, log)).toBe(false);
      expect(conn.connect).not.toHaveBeenCalled();
      expect(log.mock.calls.join(" ")).toMatch(/UTS_TRANSPORT|UTS_VXI11_DEVICE/);
    }
  });

  it("logs which transport was used", async () => {
    const conn = fakeConnection();
    const log = vi.fn();
    await autoConnectFromEnv({ UTS_IP: "192.168.1.100", UTS_TRANSPORT: "raw" }, conn, log);
    expect(log.mock.calls.join(" ")).toMatch(/raw/i);
  });

  it("UTS_IP=auto discovers the analyzer and connects to the only one found", async () => {
    const conn = fakeConnection();
    const discover = vi.fn(async () => ({
      instruments: [{ host: "192.168.1.100", vxi11: true, vxi11Port: 1, raw: true, idn: { manufacturer: "UNI-T", model: "UTS3036B", firmware: "V1" }, analyzer: true }],
      notes: [],
    }));
    expect(await autoConnectFromEnv({ UTS_IP: "auto" }, conn, vi.fn(), discover)).toBe(true);
    expect(conn.connect).toHaveBeenCalledWith("192.168.1.100", 5025, expect.objectContaining({ transport: "auto" }));
  });

  it("UTS_IP=auto logs that the host was auto-selected, with the quoted model", async () => {
    const conn = fakeConnection();
    const log = vi.fn();
    await autoConnectFromEnv({ UTS_IP: "auto" }, conn, log, async () => ({
      instruments: [{ host: "192.168.1.100", vxi11: true, vxi11Port: 1, raw: true, idn: { manufacturer: "UNI-T", model: "UTS3036B", firmware: "V1" }, analyzer: true }],
      notes: [],
    }));
    expect(log.mock.calls.join(" ")).toMatch(/auto-selected/i);
    expect(log.mock.calls.join(" ")).toContain('"UTS3036B"');
  });

  it("UTS_IP=auto logs the problem and does not connect when none or several are found", async () => {
    const conn = fakeConnection();
    const log = vi.fn();
    expect(await autoConnectFromEnv({ UTS_IP: "auto" }, conn, log, async () => ({ instruments: [], notes: [] }))).toBe(false);
    expect(conn.connect).not.toHaveBeenCalled();
    expect(log.mock.calls.join(" ")).toMatch(/no .*analyzer/i);
  });
});

describe("autoConnectAll (UTS_INSTRUMENTS)", () => {
  const registry = () => {
    const conns = new Map<string, ReturnType<typeof fakeConnection>>();
    return {
      conns,
      declare: (name: string) => {
        if (!conns.has(name)) conns.set(name, fakeConnection());
        return conns.get(name)!;
      },
    };
  };

  it("connects the default from UTS_IP and every UTS_INSTRUMENTS entry, each on its own connection", async () => {
    const r = registry();
    const ok = await autoConnectAll({ UTS_IP: "192.168.1.100", UTS_INSTRUMENTS: "sa1=192.168.1.101:5026,sa2=192.168.1.102" }, r, vi.fn());
    expect(ok).toEqual({ default: true, sa1: true, sa2: true });
    expect(r.conns.get("default")!.connect).toHaveBeenCalledWith("192.168.1.100", 5025, expect.objectContaining({ transport: "auto" }));
    expect(r.conns.get("sa1")!.connect).toHaveBeenCalledWith("192.168.1.101", 5026, expect.objectContaining({ transport: "raw" }));
    expect(r.conns.get("sa2")!.connect).toHaveBeenCalledWith("192.168.1.102", 5025, expect.objectContaining({ transport: "auto" }));
  });

  it("one failing instrument does not stop the others, and the failure names it", async () => {
    const conns = new Map<string, ReturnType<typeof fakeConnection>>();
    const reg = {
      declare: (name: string) => {
        if (!conns.has(name)) conns.set(name, name === "bad" ? fakeConnection(async () => { throw new Error("ECONNREFUSED"); }) : fakeConnection());
        return conns.get(name)!;
      },
    };
    const log = vi.fn();
    const ok = await autoConnectAll({ UTS_INSTRUMENTS: "bad=192.168.1.101,good=192.168.1.102" }, reg, log);
    expect(ok).toEqual({ bad: false, good: true });
    expect(log.mock.calls.join(" ")).toMatch(/\[bad\].*ECONNREFUSED/s);
  });

  it("an invalid UTS_INSTRUMENTS is logged, declares nothing and still connects UTS_IP", async () => {
    const r = registry();
    const log = vi.fn();
    const ok = await autoConnectAll({ UTS_IP: "192.168.1.100", UTS_INSTRUMENTS: "oops" }, r, log);
    expect(ok).toEqual({ default: true });
    expect(log.mock.calls.join(" ")).toContain("UTS_INSTRUMENTS");
    expect([...r.conns.keys()]).toEqual(["default"]);
  });

  it("with neither variable set nothing is connected or declared", async () => {
    const r = registry();
    expect(await autoConnectAll({}, r, vi.fn())).toEqual({});
    expect(r.conns.size).toBe(0);
  });
});
