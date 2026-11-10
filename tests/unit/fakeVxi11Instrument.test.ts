import { afterEach, describe, expect, it } from "vitest";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";

let fake: FakeVxi11Instrument | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe("fake VXI-11 instrument", () => {
  it("listens on a loopback port and serves the portmapper on the same port", async () => {
    fake = await startFakeVxi11Instrument();
    expect(fake.port).toBeGreaterThan(0);
    expect(fake.rpc.port).toBe(fake.port);
  });

  it("closes without leaving sockets or timers behind, even mid-sweep", async () => {
    fake = await startFakeVxi11Instrument({ sweepMs: 60_000 });
    await fake.close();
    expect(fake.rpc.sockets.size).toBe(0);
    fake = undefined;
  });
});
