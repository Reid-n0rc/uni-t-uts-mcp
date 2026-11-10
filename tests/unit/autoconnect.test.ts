import { describe, it, expect, vi } from "vitest";
import { autoConnectFromEnv } from "../../src/autoconnect.js";

function fakeConnection(impl?: () => Promise<string>) {
  return { connect: vi.fn(impl ?? (async () => "UNI-TREND,UTS0000X,<serial>,V0.0.0")) };
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
    expect(conn.connect).toHaveBeenCalledWith("192.168.1.100", 5025);
    expect(log.mock.calls.join(" ")).toContain("UTS0000X");
  });

  it("honors UTS_PORT", async () => {
    const conn = fakeConnection();
    await autoConnectFromEnv({ UTS_IP: "192.168.1.100", UTS_PORT: "5555" }, conn, vi.fn());
    expect(conn.connect).toHaveBeenCalledWith("192.168.1.100", 5555);
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
