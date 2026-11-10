import { describe, it, expect, afterEach } from "vitest";
import { connection } from "../../src/connection.js";
import { waitForSweepComplete, startSweep, SweepTimeoutError } from "../../src/acquisition.js";
import { startFakeScpi, idnHandler, type FakeScpi } from "../fakeScpiServer.js";

/**
 * Fake of the behaviour verified on the UTS3036B: while a single sweep runs the instrument ignores
 * every line (nothing is queued, *OPC? never answers), afterwards it answers normally.
 */
let server: FakeScpi | undefined;
let sweepingUntil = 0;
let sweepTime = "3.000000e-01";
let neverFinish = false;

async function setup() {
  sweepingUntil = 0;
  neverFinish = false;
  server = await startFakeScpi((line, socket) => {
    if (neverFinish || Date.now() < sweepingUntil) return; // dropped
    idnHandler((l, s) => {
      if (l === ":INITiate:IMMediate" || l === ":INITiate:RESTart") sweepingUntil = Date.now() + Number(sweepTime) * 1000;
      else if (l === ":SENSe:SWEep:TIME?") s.write(sweepTime + " \r\n");
    })(line, socket);
  });
  await connection.connect("127.0.0.1", server.port, { recoveryMs: 100 });
}

afterEach(async () => {
  connection.disconnect();
  await server?.close();
  server = undefined;
});

const opts = { pollTimeoutMs: 100, settleMs: 20 };

describe("startSweep + waitForSweepComplete against a slow single sweep", () => {
  it("sends *CLS, reads the sweep time, starts unsynced, sends nothing during the sweep, then returns once the sweep ended", async () => {
    await setup();
    const t0 = Date.now();
    const started = await startSweep("immediate");
    expect(started.sweepTimeS).toBeCloseTo(0.3);
    const res = await waitForSweepComplete(opts);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(res.waitedMs).toBeGreaterThan(0);
    const rec = server!.received;
    expect(rec.slice(rec.indexOf("*CLS"), rec.indexOf(":INITiate:IMMediate") + 1)).toEqual([
      "*CLS", "*OPC?", ":SENSe:SWEep:TIME?", ":INITiate:IMMediate",
    ]);
    // Nothing was written during the sweep except (possibly) a final poll right at its end.
    const immAt = server!.receivedAt[rec.indexOf(":INITiate:IMMediate")];
    const after = server!.receivedAt.slice(rec.indexOf(":INITiate:IMMediate") + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0] - immAt).toBeGreaterThanOrEqual(230);
  });

  it("uses :INITiate:RESTart when asked", async () => {
    await setup();
    await startSweep("restart");
    await waitForSweepComplete(opts);
    expect(server!.received).toContain(":INITiate:RESTart");
    expect(server!.received).not.toContain(":INITiate:IMMediate");
  });

  it("handles an unknown sweep time by polling until the instrument answers", async () => {
    await setup();
    sweepingUntil = Date.now() + 300;
    const t0 = Date.now();
    const res = await waitForSweepComplete({ ...opts });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(res.waitedMs).toBeGreaterThan(0);
    // the connection is still usable afterwards
    expect(await connection.query("*OPC?")).toBe("1");
  });

  it("returns at once for a short sweep", async () => {
    await setup();
    sweepTime = "2.6475e-03";
    await startSweep("immediate");
    const t0 = Date.now();
    await waitForSweepComplete(opts);
    expect(Date.now() - t0).toBeLessThan(400);
    sweepTime = "3.000000e-01";
  });

  it("times out cleanly with SweepTimeoutError and leaves the connection usable", async () => {
    await setup();
    await startSweep("immediate");
    neverFinish = true;
    await expect(waitForSweepComplete({ ...opts, timeoutMs: 400 })).rejects.toBeInstanceOf(SweepTimeoutError);
    neverFinish = false;
    sweepingUntil = 0;
    expect(await connection.query("*OPC?")).toBe("1");
  });
});
