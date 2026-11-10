import { describe, it, expect, afterEach } from "vitest";
import { UtsConnection } from "../src/connection.js";
import {
  TransportTimeout,
  type Transport,
  type TransportCapabilities,
} from "../src/transports/transport.js";

/**
 * Behavioral contract every `Transport` must satisfy. A transport's own test file calls
 * `runTransportContract(...)` with a factory and a fake instrument for its wire, e.g.
 * tests/unit/transports/raw.test.ts for raw TCP; the VXI-11 transport (issues #72 to #75) runs
 * the very same tests against its fake RPC server by supplying its own harness.
 *
 * The fake instrument is described wire-independently: `FakeHandler` is called for every SCPI
 * line the transport writes and answers through `FakeIo`, so the harness decides how a reply is
 * framed on its wire.
 */

export interface FakeIo {
  /** Reply with one line of text (the harness adds the wire's terminator). */
  reply(text: string): void;
  /** Reply with an IEEE 488.2 definite-length block holding `data`. */
  replyBlock(data: Buffer): void;
}

export type FakeHandler = (line: string, io: FakeIo) => void | Promise<void>;

export interface FakeInstrument {
  host: string;
  port: number;
  /** Every SCPI line received, in order (terminators stripped). */
  received: string[];
  /** Drop the link from the instrument's side (as a power cycle or network failure would). */
  dropLink(): void;
  close(): Promise<void>;
}

export interface TransportHarness {
  name: string;
  createTransport(): Transport;
  /** Start a fake instrument that answers `*IDN?`, `*OPC?` and (via `handler`) everything else. */
  startFake(handler: FakeHandler): Promise<FakeInstrument>;
  /** The capability flags this transport must advertise. */
  expectedCapabilities: TransportCapabilities;
}

export const FAKE_IDN = "UNI-TREND,UTS0000X,<serial>,V0.0.0";

export function runTransportContract(harness: TransportHarness): void {
  describe(`transport contract: ${harness.name}`, () => {
    let fake: FakeInstrument | undefined;
    let transport: Transport | undefined;
    let conn: UtsConnection | undefined;

    const base: FakeHandler = (line, io) => {
      if (line === "*IDN?") io.reply(FAKE_IDN);
      else if (line === "*OPC?") io.reply("1");
    };
    const start = async (handler: FakeHandler = () => {}): Promise<FakeInstrument> => {
      fake = await harness.startFake(async (line, io) => {
        base(line, io);
        await handler(line, io);
      });
      return fake;
    };
    const open = async (handler?: FakeHandler): Promise<Transport> => {
      const f = await start(handler);
      transport = harness.createTransport();
      await transport.open({ host: f.host, port: f.port, connectTimeoutMs: 2000 });
      return transport;
    };

    afterEach(async () => {
      conn?.disconnect();
      transport?.close();
      await fake?.close();
      conn = transport = fake = undefined;
    });

    it("advertises the expected capability flags", () => {
      expect(harness.createTransport().capabilities).toEqual(harness.expectedCapabilities);
      const flags = harness.createTransport().capabilities;
      for (const key of ["syncsCommands", "dropsInputDuringSweep", "holdOffAfterTimeout"] as const) {
        expect(typeof flags[key]).toBe("boolean");
      }
    });

    it("opens, reports isOpen, and close is idempotent", async () => {
      const t = await open();
      expect(t.isOpen()).toBe(true);
      t.close();
      expect(t.isOpen()).toBe(false);
      expect(() => t.close()).not.toThrow();
    });

    it("open fails with a 'Connection failed' message when nothing is listening", async () => {
      const f = await start();
      const { host, port } = f;
      await f.close();
      fake = undefined;
      const t = harness.createTransport();
      await expect(t.open({ host, port, connectTimeoutMs: 1000 })).rejects.toThrow(/Connection failed/);
      expect(t.isOpen()).toBe(false);
    });

    it("writes a line and reads one trimmed text reply", async () => {
      const t = await open((line, io) => {
        if (line === ":SWEep:TIME?") io.reply("2.647500e-03");
      });
      await t.write(":SWEep:TIME?");
      expect(await t.readLine(2000)).toBe("2.647500e-03");
    });

    it("keeps writes in order", async () => {
      const t = await open();
      await t.write("*CLS");
      await t.write(":FREQuency:CENTer 1e9");
      await t.write("*IDN?");
      expect(await t.readLine(2000)).toBe(FAKE_IDN);
      expect(fake!.received.slice(0, 3)).toEqual(["*CLS", ":FREQuency:CENTer 1e9", "*IDN?"]);
    });

    it("reads a binary block payload, including a large one", async () => {
      const payload = Buffer.alloc(5000);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      const t = await open((line, io) => {
        if (line === ":TRACe:DATA?") io.replyBlock(payload);
      });
      await t.write(":TRACe:DATA?");
      expect(Buffer.compare(await t.readBlock(2000), payload)).toBe(0);
    });

    it("reads the next reply correctly after a binary block", async () => {
      const t = await open((line, io) => {
        if (line === ":TRACe:DATA?") io.replyBlock(Buffer.from([1, 2, 3, 4]));
        if (line === ":FORMat?") io.reply("ASC8");
      });
      await t.write(":TRACe:DATA?");
      expect([...(await t.readBlock(2000))]).toEqual([1, 2, 3, 4]);
      t.discardInput();
      await t.write(":FORMat?");
      expect(await t.readLine(2000)).toBe("ASC8");
    });

    it("rejects a non-block reply to readBlock with a clear error", async () => {
      const t = await open((line, io) => {
        if (line === ":DISP:ZBmp?") io.reply("not a block");
      });
      await t.write(":DISP:ZBmp?");
      await expect(t.readBlock(2000)).rejects.toThrow(/binary block/i);
    });

    it("rejects with TransportTimeout when the instrument stays silent, and stays usable", async () => {
      const t = await open((line, io) => {
        if (line === ":FORMat?") io.reply("ASC8");
      });
      await t.write(":UNSUPPORTED?");
      await expect(t.readLine(100)).rejects.toBeInstanceOf(TransportTimeout);
      expect(t.isOpen()).toBe(true);
      t.discardInput();
      await t.write(":FORMat?");
      expect(await t.readLine(2000)).toBe("ASC8");
    });

    it("discardInput drops a stale reply", async () => {
      const t = await open((line, io) => {
        if (line === "A?") io.reply("stale");
        if (line === "B?") io.reply("fresh");
      });
      await t.write("A?");
      await new Promise((r) => setTimeout(r, 100));
      t.discardInput();
      await t.write("B?");
      expect(await t.readLine(2000)).toBe("fresh");
    });

    it("signals loss of the link once and rejects a pending read", async () => {
      const t = await open();
      const lost: string[] = [];
      t.onLost((reason) => lost.push(reason));
      await t.write(":SILENT?");
      await new Promise((r) => setTimeout(r, 20));
      const pending = t.readLine(5000).then(
        () => "reply",
        (e: Error) => e
      );
      fake!.dropLink();
      expect(await pending).toBeInstanceOf(Error);
      await new Promise((r) => setTimeout(r, 50));
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatch(/\S/);
      expect(t.isOpen()).toBe(false);
    });

    it("does not signal loss for an explicit close", async () => {
      const t = await open();
      const lost: string[] = [];
      t.onLost((reason) => lost.push(reason));
      t.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(lost).toEqual([]);
    });

    describe("under UtsConnection", () => {
      const connect = async (handler?: FakeHandler) => {
        const f = await start(handler);
        conn = new UtsConnection(harness.createTransport);
        const idn = await conn.connect(f.host, f.port, { recoveryMs: 100 });
        return { f, idn };
      };

      it("connects and answers *IDN?", async () => {
        const { idn } = await connect();
        expect(idn).toBe(FAKE_IDN);
        expect(conn!.isConnected()).toBe(true);
        expect(conn!.capabilities).toEqual(harness.expectedCapabilities);
      });

      it("paces commands with *OPC? exactly when the transport asks for it", async () => {
        const { f } = await connect();
        const before = f.received.length;
        await conn!.sendCommand(":FREQuency:CENTer 1e9");
        const sent = f.received.slice(before);
        expect(sent[0]).toBe(":FREQuency:CENTer 1e9");
        expect(sent.includes("*OPC?")).toBe(harness.expectedCapabilities.syncsCommands);
        const n = f.received.length;
        await conn!.sendCommand(":FREQuency:CENTer 2e9", { sync: false });
        await new Promise((r) => setTimeout(r, 50));
        expect(f.received.slice(n)).toEqual([":FREQuency:CENTer 2e9"]);
      });

      it("returns binary blocks and text replies through the queue", async () => {
        await connect((line, io) => {
          if (line === ":TRACe:DATA?") io.replyBlock(Buffer.from([9, 8, 7]));
        });
        expect([...(await conn!.queryBinary(":TRACe:DATA?", 2000))]).toEqual([9, 8, 7]);
        expect(await conn!.query("*IDN?")).toBe(FAKE_IDN);
      });

      it("times out a silent query, records it, and holds off only if the transport says so", async () => {
        const { f } = await connect();
        expect(conn!.msSinceQueryTimeout()).toBe(Infinity);
        await expect(conn!.query(":NOPE?", 50)).rejects.toThrow(/Query timeout after 50ms.*:NOPE\?/);
        expect(conn!.msSinceQueryTimeout()).toBeLessThan(1000);
        const t0 = Date.now();
        expect(await conn!.query("*IDN?", 1000)).toBe(FAKE_IDN);
        const waited = Date.now() - t0;
        if (harness.expectedCapabilities.holdOffAfterTimeout) {
          expect(waited).toBeGreaterThanOrEqual(30);
        } else {
          expect(waited).toBeLessThan(40);
        }
        expect(f.received).toContain(":NOPE?");
      });

      it("expectSilence timeouts neither hold off nor count as failed queries", async () => {
        await connect();
        await expect(conn!.query(":NOPE?", 50, { expectSilence: true })).rejects.toThrow(/timeout/i);
        expect(conn!.msSinceQueryTimeout()).toBe(Infinity);
        const t0 = Date.now();
        await conn!.query("*IDN?", 1000);
        expect(Date.now() - t0).toBeLessThan(40);
      });

      it("reports a lost link with the command in flight, then 'lost' on later calls", async () => {
        const { f } = await connect();
        const pending = conn!.query(":SILENT?", 5000);
        const settled = pending.then(
          () => "reply",
          (e: Error) => e.message
        );
        await new Promise((r) => setTimeout(r, 50));
        f.dropLink();
        expect(await settled).toMatch(/was lost.*:SILENT\?/);
        expect(conn!.isConnected()).toBe(false);
        await expect(conn!.query("*IDN?")).rejects.toThrow(/was lost.*reconnect/i);
      });

      it("says to connect first when not connected", async () => {
        const c = new UtsConnection(harness.createTransport);
        await expect(c.query("*IDN?")).rejects.toThrow(/Use the 'connect' tool first/);
      });
    });
  });
}
