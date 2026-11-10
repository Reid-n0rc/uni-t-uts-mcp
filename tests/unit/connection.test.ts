import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { UtsConnection } from "../../src/connection.js";
import { startFakeScpi, idnHandler, IDN, type FakeScpi } from "../fakeScpiServer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: FakeScpi | undefined;
let conn: UtsConnection;

async function setup(
  extra?: Parameters<typeof idnHandler>[0],
  handlerOptions?: Parameters<typeof idnHandler>[1],
  connectOptions: Parameters<UtsConnection["connect"]>[2] = { recoveryMs: 150 }
) {
  server = await startFakeScpi(idnHandler(extra, handlerOptions));
  conn = new UtsConnection();
  await conn.connect("127.0.0.1", server.port, connectOptions);
}

afterEach(async () => {
  conn?.disconnect();
  await server?.close();
  server = undefined;
});

describe("connect", () => {
  it("returns the *IDN? reply and reports connection info", async () => {
    server = await startFakeScpi(idnHandler());
    conn = new UtsConnection();
    const idn = await conn.connect("127.0.0.1", server.port);
    expect(idn).toBe(IDN);
    expect(conn.isConnected()).toBe(true);
    expect(conn.getConnectionInfo()).toBe(`127.0.0.1:${server.port}`);
  });

  it("rejects with a clear error when nothing is listening", async () => {
    const probe = await startFakeScpi(idnHandler());
    const { port } = probe;
    await probe.close();
    conn = new UtsConnection();
    await expect(conn.connect("127.0.0.1", port)).rejects.toThrow(/Connection failed/);
    expect(conn.isConnected()).toBe(false);
  });

  it("rejects when the instrument does not answer *IDN?", async () => {
    server = await startFakeScpi(() => {});
    conn = new UtsConnection();
    await expect(conn.connect("127.0.0.1", server.port, { identTimeoutMs: 100 })).rejects.toThrow(
      /failed to initialize/i
    );
    expect(conn.isConnected()).toBe(false);
  });
});

describe("not connected", () => {
  it("tells the user to call connect", async () => {
    conn = new UtsConnection();
    await expect(conn.query("*IDN?")).rejects.toThrow(/connect/i);
    await expect(conn.sendCommand("*CLS")).rejects.toThrow(/connect/i);
    await expect(conn.queryBinary(":DISP:ZBmp?")).rejects.toThrow(/connect/i);
  });
});

describe("query", () => {
  it("round trips and trims the reply", async () => {
    await setup((line, s) => {
      if (line === ":SWEep:TIME?") s.write("2.647500e-03 \n");
    });
    expect(await conn.query(":SWEep:TIME?")).toBe("2.647500e-03");
  });

  it("assembles a reply split across chunks", async () => {
    await setup(async (line, s) => {
      if (line === ":FORMat?") {
        s.write("AS");
        await sleep(20);
        s.write("C8\n");
      }
    });
    expect(await conn.query(":FORMat?")).toBe("ASC8");
  });

  it("serializes queued queries (second is sent only after first is answered)", async () => {
    await setup((line, s) => {
      if (line === "Q1?") setTimeout(() => s.write("one\n"), 60);
      if (line === "Q2?") s.write("two\n");
    });
    const before = server!.received.length;
    const p1 = conn.query("Q1?");
    const p2 = conn.query("Q2?");
    await sleep(20);
    expect(server!.received.slice(before)).toEqual(["Q1?"]); // Q2 not sent yet
    expect(await p1).toBe("one");
    expect(await p2).toBe("two");
    expect(server!.received.slice(before)).toEqual(["Q1?", "Q2?"]);
  });

  it("times out when the instrument stays silent and keeps working afterwards", async () => {
    await setup((line, s) => {
      if (line === "OK?") s.write("1\n");
    });
    await expect(conn.query(":NOT:SUPPORTED?", 80)).rejects.toThrow(/timeout.*:NOT:SUPPORTED\?/i);
    expect(await conn.query("OK?")).toBe("1");
  });
});

describe("sendCommand", () => {
  it("writes the command with an LF and resolves", async () => {
    await setup();
    await conn.sendCommand(":FREQ:CENT 1 GHz");
    await sleep(30);
    expect(server!.received).toContain(":FREQ:CENT 1 GHz");
  });

  it("is ordered after a pending query", async () => {
    await setup((line, s) => {
      if (line === "Q?") setTimeout(() => s.write("a\n"), 60);
    });
    const before = server!.received.length;
    const q = conn.query("Q?");
    const c = conn.sendCommand("CMD");
    await sleep(20);
    expect(server!.received.slice(before)).toEqual(["Q?"]);
    await q;
    await c;
    await sleep(30);
    expect(server!.received.slice(before)).toEqual(["Q?", "CMD", "*OPC?"]);
  });
});

describe("command pacing (the UTS3036B mis-parses bursts of lines)", () => {
  it("syncs each command with *OPC? before anything else is written", async () => {
    await setup((line, s) => {
      if (line === "*OPC?") setTimeout(() => s.write("1\r\n"), 80);
    }, { opc: false });
    const before = server!.received.length;
    const started = Date.now();
    await conn.sendCommand("CMD1");
    expect(Date.now() - started).toBeGreaterThanOrEqual(70); // waited for the *OPC? reply
    await conn.sendCommand("CMD2");
    expect(server!.received.slice(before)).toEqual(["CMD1", "*OPC?", "CMD2", "*OPC?"]);
  });

  it("queued commands and queries are never written back-to-back without the sync", async () => {
    await setup((line, s) => {
      if (line === "Q?") s.write("a\r\n");
    });
    const before = server!.received.length;
    await Promise.all([conn.sendCommand("C1"), conn.sendCommand("C2"), conn.query("Q?")]);
    expect(server!.received.slice(before)).toEqual(["C1", "*OPC?", "C2", "*OPC?", "Q?"]);
  });

  it("can skip the sync explicitly", async () => {
    await setup();
    const before = server!.received.length;
    await conn.sendCommand("CMD", { sync: false });
    await sleep(30);
    expect(server!.received.slice(before)).toEqual(["CMD"]);
  });

  it("fails clearly when *OPC? is never answered, and the queue keeps working", async () => {
    await setup((line, s) => {
      if (line === "Q?") s.write("a\r\n");
    }, { opc: false }, { opcTimeoutMs: 80, recoveryMs: 0 });
    await expect(conn.sendCommand("CMD")).rejects.toThrow(/finish|\*OPC\?|timeout/i);
    expect(await conn.query("Q?")).toBe("a");
  });
});

describe("hold-off after a query timeout (the instrument stalls after an unsupported query)", () => {
  /** Fake instrument: after the unsupported query "BAD?" it ignores all lines for 200 ms. */
  function stallingHandler() {
    let stalledUntil = 0;
    return (line: string, s: import("node:net").Socket) => {
      if (Date.now() < stalledUntil) return; // dropped during the stall
      if (line === "BAD?") stalledUntil = Date.now() + 200;
      else if (line === "Q?") s.write("ok\r\n");
    };
  }

  it("waits out the stall so the next query is not lost", async () => {
    await setup(stallingHandler(), undefined, { recoveryMs: 300 });
    await expect(conn.query("BAD?", 50)).rejects.toThrow(/timeout/i);
    expect(await conn.query("Q?", 1000)).toBe("ok");
    const badAt = server!.receivedAt[server!.received.indexOf("BAD?")];
    const qAt = server!.receivedAt[server!.received.indexOf("Q?")];
    expect(qAt - badAt).toBeGreaterThanOrEqual(280);
  });

  it("holds off queued commands as well", async () => {
    await setup(stallingHandler(), undefined, { recoveryMs: 300 });
    const bad = expect(conn.query("BAD?", 50)).rejects.toThrow(/timeout/i);
    const cmd = conn.sendCommand("CMD");
    await bad;
    await cmd;
    const badAt = server!.receivedAt[server!.received.indexOf("BAD?")];
    const cmdAt = server!.receivedAt[server!.received.indexOf("CMD")];
    expect(cmdAt - badAt).toBeGreaterThanOrEqual(280);
  });

  it("needs no extra hold when the timeout already exceeded the recovery time", async () => {
    await setup(stallingHandler(), undefined, { recoveryMs: 100 });
    await expect(conn.query("BAD?", 150)).rejects.toThrow(/timeout/i);
    const after = Date.now();
    await conn.query("Q?", 1000).catch(() => {});
    const qAt = server!.receivedAt[server!.received.indexOf("Q?")];
    expect(qAt - after).toBeLessThan(60);
  });

  it("disconnect cancels a pending hold-off", async () => {
    await setup(stallingHandler(), undefined, { recoveryMs: 2000 });
    await expect(conn.query("BAD?", 50)).rejects.toThrow(/timeout/i);
    const pending = expect(conn.query("Q?", 1000)).rejects.toThrow(/closed/i);
    conn.disconnect();
    await pending;
  });
});

describe("queryBinary", () => {
  const payload = Buffer.from([0x23, 0x0a, 0x00, 0xff, 0x0a, 0x41]);

  it("returns the payload of a block assembled across chunks (binary safe)", async () => {
    await setup(async (line, s) => {
      if (line === "BIN?") {
        const head = Buffer.from("#16");
        s.write(head);
        await sleep(20);
        s.write(payload.subarray(0, 3));
        await sleep(20);
        s.write(Buffer.concat([payload.subarray(3), Buffer.from("\n")]));
      }
    });
    expect(await conn.queryBinary("BIN?")).toEqual(payload);
  });

  it("does not leak the trailing LF into the next query", async () => {
    await setup((line, s) => {
      if (line === "BIN?") s.write(Buffer.concat([Buffer.from("#16"), payload, Buffer.from("\n")]));
      if (line === "Q?") s.write("next\n");
    });
    await conn.queryBinary("BIN?");
    expect(await conn.query("Q?")).toBe("next");
  });

  it("drops a trailing LF that arrives after the payload", async () => {
    await setup(async (line, s) => {
      if (line === "BIN?") {
        s.write(Buffer.concat([Buffer.from("#16"), payload]));
        await sleep(30);
        s.write("\n");
      }
      if (line === "Q?") s.write("next\n");
    });
    expect(await conn.queryBinary("BIN?")).toEqual(payload);
    expect(await conn.query("Q?")).toBe("next");
  });

  describe("CRLF terminated replies (as sent by the UTS3036B)", () => {
    const real32 = readFileSync(new URL("../fixtures/p2/trace1-real32.bin", import.meta.url));

    it("reads the real REAL32 trace capture and leaves nothing behind for the next query", async () => {
      await setup((line, s) => {
        if (line === "TRACE?") s.write(real32);
        if (line === "Q?") s.write("next\r\n");
      });
      const data = await conn.queryBinary("TRACE?");
      expect(data.length).toBe(4004);
      expect(data.readFloatBE(0)).toBeLessThan(0);
      expect(await conn.query("Q?")).toBe("next");
    });

    it("swallows CR and LF that arrive in separate later chunks", async () => {
      await setup(async (line, s) => {
        if (line === "BIN?") {
          s.write(Buffer.concat([Buffer.from("#16"), payload]));
          await sleep(25);
          s.write("\r");
          await sleep(25);
          s.write("\n");
        }
        if (line === "Q?") s.write("next\r\n");
      });
      expect(await conn.queryBinary("BIN?")).toEqual(payload);
      await sleep(10); // next query is issued while the terminator is still in flight
      const q = conn.query("Q?");
      expect(await q).toBe("next");
    });

    it("swallows a whole CRLF that arrives after the payload", async () => {
      await setup(async (line, s) => {
        if (line === "BIN?") {
          s.write(Buffer.concat([Buffer.from("#16"), payload]));
          await sleep(25);
          s.write("\r\n");
        }
        if (line === "Q?") s.write("next\r\n");
      });
      expect(await conn.queryBinary("BIN?")).toEqual(payload);
      expect(await conn.query("Q?")).toBe("next");
    });

    it("trims CRLF terminated text replies", async () => {
      await setup((line, s) => {
        if (line === "Q?") s.write("-6.1e+01,-9.1e+01\r\n");
      });
      expect(await conn.query("Q?")).toBe("-6.1e+01,-9.1e+01");
    });
  });

  it("rejects when the reply is not a block", async () => {
    await setup((line, s) => {
      if (line === "BIN?") s.write("not a block\n");
    });
    await expect(conn.queryBinary("BIN?", 500)).rejects.toThrow(/block/i);
  });

  it("times out", async () => {
    await setup();
    await expect(conn.queryBinary("BIN?", 80)).rejects.toThrow(/timeout/i);
  });
});

describe("closing", () => {
  it("disconnect rejects pending and queued queries", async () => {
    await setup();
    const p1 = conn.query("A?", 5000);
    const p2 = conn.query("B?", 5000);
    const r1 = expect(p1).rejects.toThrow(/closed/i);
    const r2 = expect(p2).rejects.toThrow(/closed/i);
    conn.disconnect();
    await r1;
    await r2;
    expect(conn.isConnected()).toBe(false);
  });

  it("rejects pending queries when the server closes the socket", async () => {
    await setup();
    const p = conn.query("A?", 5000);
    const r = expect(p).rejects.toThrow(/closed/i);
    await sleep(20);
    for (const s of server!.sockets) s.destroy();
    await r;
    await sleep(20);
    expect(conn.isConnected()).toBe(false);
    await expect(conn.query("B?")).rejects.toThrow(/connect/i);
  });
});

describe("command validation", () => {
  it.each([
    ["embedded LF", "*IDN?\n*RST"],
    ["embedded CR", "*IDN?\r*RST"],
    ["embedded CRLF", "A\r\nB"],
    ["NUL", "A\u0000B"],
    ["trailing newline", "*IDN?\n"],
  ])("rejects %s without sending anything", async (_name, cmd) => {
    await setup();
    const before = server!.received.length;
    await expect(conn.query(cmd)).rejects.toThrow(/control character|terminator/i);
    await expect(conn.sendCommand(cmd)).rejects.toThrow(/control character|terminator/i);
    await expect(conn.queryBinary(cmd)).rejects.toThrow(/control character|terminator/i);
    await sleep(30);
    expect(server!.received.length).toBe(before);
  });
});
