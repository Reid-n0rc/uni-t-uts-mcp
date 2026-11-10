import { describe, it, expect, afterEach } from "vitest";
import { connection } from "../../src/connection.js";
import { startSweep, waitForSweepComplete, SweepTimeoutError, hasPendingSweep } from "../../src/acquisition.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";

/**
 * Sweep wait over VXI-11 (selected by the dropsInputDuringSweep capability flag): `:INITiate:IMMediate`,
 * then ONE blocking `*OPC?` read that returns when the sweep ends. No silent period, no polling.
 */
let fake: FakeVxi11Instrument | undefined;

async function setup(sweepMs: number, sweepTime = "3.000000e-01") {
  fake = await startFakeVxi11Instrument({
    sweepMs,
    scpi: (c) => (/^\*IDN\?$/i.test(c) ? "UNI-T,UTS3036B,FAKE,1.0" : c === ":SENSe:SWEep:TIME?" ? sweepTime + " " : undefined),
  });
  await connection.connect("127.0.0.1", 5025, { transport: "vxi11", vxi11PortmapperPort: fake.port });
}

afterEach(async () => {
  connection.disconnect();
  await fake?.close();
  fake = undefined;
});

describe("sweep wait over VXI-11", () => {
  it("writes the start command, then uses a single blocking *OPC? read that ends with the sweep", async () => {
    await setup(300);
    const t0 = Date.now();
    const started = await startSweep("immediate");
    expect(started.sweepTimeS).toBeCloseTo(0.3);
    expect(hasPendingSweep()).toBe(true);
    const readsBefore = fake!.readRequests.length;
    const res = await waitForSweepComplete();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1500);
    expect(res.waitedMs).toBeGreaterThan(0);
    expect(hasPendingSweep()).toBe(false);
    // exactly one *OPC? in the whole sequence, written after the start command
    const opc = fake!.received.filter((c) => c === "*OPC?");
    expect(opc).toHaveLength(1);
    expect(fake!.received.indexOf("*OPC?")).toBeGreaterThan(fake!.received.indexOf(":INITiate:IMMediate"));
    // and one blocking device_read for it (no polling)
    expect(fake!.readRequests.length - readsBefore).toBe(1);
    expect(fake!.sweepsCompleted).toBe(1);
  });

  it("does not sync the start command or pace commands with *OPC?", async () => {
    await setup(100);
    await startSweep("restart");
    await waitForSweepComplete();
    expect(fake!.received.filter((c) => c === "*OPC?")).toHaveLength(1);
  });

  it("the connection is usable after the sweep", async () => {
    await setup(100);
    await startSweep("immediate");
    await waitForSweepComplete();
    expect(await connection.query("*IDN?")).toMatch(/UTS3036B/);
  });

  it("times out with a SweepTimeoutError naming VXI-11 and the blocking *OPC? read, and stays usable", async () => {
    await setup(5000, "5.000000e+00");
    await startSweep("immediate");
    const err = await waitForSweepComplete({ timeoutMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SweepTimeoutError);
    expect((err as Error).message).toMatch(/VXI-11/);
    expect((err as Error).message).toMatch(/\*OPC\?/);
    expect((err as Error).message).toMatch(/0\.3 s/);
    expect(hasPendingSweep()).toBe(false);
  });

  it("waiting without a started sweep returns as soon as the instrument answers *OPC?", async () => {
    await setup(0);
    const res = await waitForSweepComplete();
    expect(res.waitedMs).toBeLessThan(500);
  });
});
