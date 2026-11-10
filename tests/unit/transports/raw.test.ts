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
