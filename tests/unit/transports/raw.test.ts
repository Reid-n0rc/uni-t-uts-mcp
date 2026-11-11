import * as net from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { RawTransport, RAW_CAPABILITIES } from "../../../src/transports/raw.js";
import { UtsConnection } from "../../../src/connection.js";
import { startFakeScpi } from "../../fakeScpiServer.js";
import { runTransportContract, type FakeHandler } from "../../transportContract.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

runTransportContract({
  name: "raw TCP",
  createTransport: () => new RawTransport(),
  expectedCapabilities: {
    syncsCommands: true,
    dropsInputDuringSweep: true,
    holdOffAfterTimeout: true,
    completeLargeBlocks: false,
  },
  async startFake(handler: FakeHandler) {
    const fake = await startFakeScpi((line, socket) => {
      void handler(line, {
        reply: (text) => socket.write(text + "\r\n"),
        replyBlock: (data) =>
          socket.write(
            Buffer.concat([
              Buffer.from(`#${String(data.length).length}${data.length}`),
              data,
              Buffer.from("\r\n"),
            ])
          ),
      });
    });
    return {
      host: "127.0.0.1",
      port: fake.port,
      received: fake.received,
      dropLink: () => {
        for (const s of fake.sockets) s.destroy();
      },
      close: fake.close,
    };
  },
});

describe("raw transport specifics", () => {
  let server: Awaited<ReturnType<typeof startFakeScpi>> | undefined;
  let transport: RawTransport | undefined;
  afterEach(async () => {
    transport?.close();
    await server?.close();
    server = transport = undefined;
  });

  it("exports the capability flags the raw transport advertises", () => {
    expect(RAW_CAPABILITIES).toEqual({
      syncsCommands: true,
      dropsInputDuringSweep: true,
      holdOffAfterTimeout: true,
      completeLargeBlocks: false,
    });
    expect(new RawTransport().capabilities).toBe(RAW_CAPABILITIES);
    expect(new UtsConnection().capabilities).toEqual(RAW_CAPABILITIES);
  });

  it("swallows a block terminator that arrives late, split CR then LF", async () => {
    server = await startFakeScpi((line, socket: net.Socket) => {
      if (line === "B?") {
        socket.write(Buffer.from("#13abc"));
        setTimeout(() => socket.write("\r"), 20);
        setTimeout(() => socket.write("\n"), 40);
      }
      if (line === "T?") socket.write("text\r\n");
    });
    transport = new RawTransport();
    await transport.open({ host: "127.0.0.1", port: server.port, connectTimeoutMs: 2000 });
    await transport.write("B?");
    expect((await transport.readBlock(2000)).toString()).toBe("abc");
    await sleep(100);
    transport.discardInput();
    await transport.write("T?");
    expect(await transport.readLine(2000)).toBe("text");
  });
});

describe("RawTransport edge cases", () => {
  let fake: Awaited<ReturnType<typeof startFakeScpi>> | undefined;
  let t: RawTransport | undefined;
  afterEach(async () => {
    t?.close();
    t = undefined;
    await fake?.close();
    fake = undefined;
  });
  async function open(handler: (line: string, socket: net.Socket) => void): Promise<RawTransport> {
    fake = await startFakeScpi(handler);
    t = new RawTransport();
    await t.open({ host: "127.0.0.1", port: fake.port, connectTimeoutMs: 1000 });
    return t;
  }
  const block = (payload: string) => Buffer.from(`#1${payload.length}${payload}`);

  it("rejects a write on a transport that was never opened or is closed", async () => {
    const closed = new RawTransport();
    await expect(closed.write("*IDN?")).rejects.toThrow(/closed/i);
    expect(closed.isOpen()).toBe(false);
    closed.close(); // closing twice is harmless
  });

  it("fails a pending read with 'Connection closed' when closed locally", async () => {
    const tr = await open(() => {});
    const pending = tr.readLine(5000);
    tr.close();
    await expect(pending).rejects.toThrow("Connection closed");
  });

  it("reports a refused connection and a connect timeout", async () => {
    const probe = await startFakeScpi(() => {});
    const port = probe.port;
    await probe.close();
    await expect(new RawTransport().open({ host: "127.0.0.1", port, connectTimeoutMs: 500 })).rejects.toThrow(/Connection failed/);
    // 192.0.2.0/24 is TEST-NET-1 and never routes; a tiny timeout makes the timer fire first (or the network errors out).
    await expect(new RawTransport().open({ host: "192.0.2.1", port: 5025, connectTimeoutMs: 1 })).rejects.toThrow(/Connection failed/);
  });

  it("calls the lost callback when the instrument closes the connection, and the transport is then closed", async () => {
    const tr = await open((_line, socket) => socket.destroy());
    const lost = new Promise<string>((resolve) => tr.onLost(resolve));
    await tr.write("*IDN?");
    expect(await lost).toMatch(/closed/);
    expect(tr.isOpen()).toBe(false);
  });

  it.each([
    ["CRLF arriving in one chunk after the payload", ["\r\n"]],
    ["CR and LF arriving in separate chunks", ["\r", "\n"]],
    ["a bare LF", ["\n"]],
  ])("does not read the terminator of a binary block as a reply (%s)", async (_name, tail) => {
    const tr = await open((line, socket) => {
      if (line === "BLK?") socket.write(block("abc"));
      else if (line === "TAIL") for (const [i, c] of tail.entries()) setTimeout(() => socket.write(c), i * 30);
      else if (line === "NEXT?") socket.write("next\r\n");
    });
    await tr.write("BLK?");
    expect([...(await tr.readBlock(1000))]).toEqual([...Buffer.from("abc")]);
    tr.discardInput(); // the connection clears the buffer between replies; the terminator is still pending
    await tr.write("TAIL");
    await sleep(100);
    await tr.write("NEXT?");
    expect(await tr.readLine(1000)).toBe("next");
  });

  it("handles a block whose CR is followed by a non-LF byte", async () => {
    const tr = await open((line, socket) => {
      if (line === "BLK?") socket.write(Buffer.concat([block("abc"), Buffer.from("\r")]));
      else if (line === "NEXT?") socket.write("x\r\n");
    });
    await tr.write("BLK?");
    await tr.readBlock(1000);
    tr.discardInput();
    await tr.write("NEXT?");
    expect(await tr.readLine(1000)).toBe("x");
  });

  it("rejects a reply that is not a binary block, and discardInput drops buffered data", async () => {
    const tr = await open((line, socket) => {
      if (line === "BAD?") socket.write("hello\r\n");
      else if (line === "JUNK") socket.write("junk\r\n");
    });
    await tr.write("BAD?");
    await expect(tr.readBlock(1000)).rejects.toThrow(/Expected a binary block reply/);
    await tr.write("JUNK");
    await sleep(60);
    tr.discardInput();
    await expect(tr.readLine(100)).rejects.toThrow();
  });
});
