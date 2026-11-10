import { describe, it, expect } from "vitest";
import { InstrumentBusyError, SessionLock } from "../../src/sessionLock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SessionLock", () => {
  it("runs sessions one at a time in FIFO order", async () => {
    const lock = new SessionLock();
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      lock.run(async () => {
        log.push(`start ${name}`);
        await sleep(ms);
        log.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([job("a", 30), job("b", 1), job("c", 1)]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("releases the lock after a thrown error and after a synchronous throw", async () => {
    const lock = new SessionLock();
    await expect(lock.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(lock.run(() => { throw new Error("sync"); })).rejects.toThrow("sync");
    expect(await lock.run(async () => "ok")).toBe("ok");
    expect(lock.held).toBe(false);
  });

  it("lets nested calls in the same session through (no deadlock), also across awaits and timers", async () => {
    const lock = new SessionLock();
    const nested = async () => lock.run(async () => { await sleep(1); return "inner"; });
    const out = await lock.run(async () => {
      const a = await nested();
      const b = await new Promise<string>((resolve) => setTimeout(() => void nested().then(resolve), 1));
      return `${a}/${b}`;
    });
    expect(out).toBe("inner/inner");
  });

  it("a session on one lock does not bypass another lock", async () => {
    const one = new SessionLock();
    const two = new SessionLock();
    const t0 = Date.now();
    let waiterStart = 0;
    const holder = one.run(async () => { await two.run(async () => { await sleep(40); }); });
    const waiter = two.run(async () => { waiterStart = Date.now() - t0; });
    await Promise.all([holder, waiter]);
    // `waiter` is outside any session, so it queues behind the holder's session on `two`.
    expect(waiterStart).toBeGreaterThanOrEqual(35);
  });

  it("rejects a waiter with a clear busy error after the wait timeout, naming the holder, and keeps the queue intact", async () => {
    const lock = new SessionLock();
    const long = lock.run(async () => { await sleep(120); return "long"; }, { label: "single_sweep" });
    const impatient = lock.run(async () => "never", { timeoutMs: 30, label: "get_frequency" });
    const patient = lock.run(async () => "patient", { label: "get_amplitude" });
    const err = await impatient.catch((e) => e);
    expect(err).toBeInstanceOf(InstrumentBusyError);
    expect(err.message).toMatch(/instrument busy/i);
    expect(err.message).toMatch(/single_sweep/);
    expect(err.message).toMatch(/UTS_BUSY_TIMEOUT_S/);
    expect(await long).toBe("long");
    expect(await patient).toBe("patient");
    expect(lock.waiting).toBe(0);
  });

  it("rejectWaiters fails queued sessions but not the running one", async () => {
    const lock = new SessionLock();
    const running = lock.run(async () => { await sleep(30); return "done"; });
    const w1 = lock.run(async () => "w1");
    const w2 = lock.run(async () => "w2");
    expect(lock.waiting).toBe(2);
    lock.rejectWaiters(new Error("Connection closed"));
    await expect(w1).rejects.toThrow("Connection closed");
    await expect(w2).rejects.toThrow("Connection closed");
    expect(await running).toBe("done");
    expect(await lock.run(async () => "after")).toBe("after");
  });
});
