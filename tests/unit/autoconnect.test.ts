import { describe, it, expect, vi } from "vitest";
import { autoConnectFromEnv } from "../../src/autoconnect.js";

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

  it("connects with UTS_IP and the default port", async () => {
    const conn = fakeConnection();
    const log = vi.fn();
    expect(await autoConnectFromEnv({ UTS_IP: "192.168.1.100" }, conn, log)).toBe(true);
    expect(conn.connect).toHaveBeenCalledWith("192.168.1.100", 5025, expect.objectContaining({ transport: "raw", vxi11Device: "inst0" }));
    expect(log.mock.calls.join(" ")).toContain("UTS0000X");
  });

  it("honors UTS_PORT", async () => {
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
    await autoConnectFromEnv({ UTS_IP: "192.168.1.100" }, conn, log);
    expect(log.mock.calls.join(" ")).toMatch(/raw/i);
  });
});
