import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdownHandlers, type ShutdownProcess } from "../../src/shutdown.js";

function fakeProc(withStdin = true) {
  const handlers = new Map<string, () => void>();
  const proc: ShutdownProcess = {
    on: (event, listener) => void handlers.set(event, listener),
    stdin: withStdin ? { on: (event, listener) => void handlers.set(`stdin:${event}`, listener) } : undefined,
  };
  return { proc, handlers };
}

afterEach(() => vi.useRealTimers());

describe("installShutdownHandlers", () => {
  it("shuts the connection down once and exits 0 for any of the four triggers", async () => {
    const { proc, handlers } = fakeProc();
    const conn = { shutdown: vi.fn(async () => {}) };
    const exit = vi.fn();
    installShutdownHandlers(proc, conn, exit);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM", "stdin:close", "stdin:end"]);
    handlers.get("SIGTERM")!();
    handlers.get("stdin:end")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(conn.shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still exits 0 when the shutdown fails, and works without stdin", async () => {
    const { proc, handlers } = fakeProc(false);
    const exit = vi.fn();
    installShutdownHandlers(proc, { shutdown: () => Promise.reject(new Error("link gone")) }, exit);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGINT")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits after the grace period when the teardown hangs", async () => {
    vi.useFakeTimers();
    const { proc, handlers } = fakeProc();
    const exit = vi.fn();
    installShutdownHandlers(proc, { shutdown: () => new Promise<void>(() => {}) }, exit, { graceMs: 500 });
    handlers.get("SIGINT")!();
    await vi.advanceTimersByTimeAsync(499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("uses a 3 s grace period by default", async () => {
    vi.useFakeTimers();
    const { proc, handlers } = fakeProc();
    const exit = vi.fn();
    installShutdownHandlers(proc, { shutdown: () => new Promise<void>(() => {}) }, exit);
    handlers.get("SIGINT")!();
    await vi.advanceTimersByTimeAsync(2999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
