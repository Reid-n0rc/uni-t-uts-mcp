import { XdrReader, XdrWriter } from "../src/vxi11/xdr.js";
import { portKey, startFakeRpcServer, type FakeRpcCall, type FakeRpcResult, type FakeRpcServer } from "./fakeRpcServer.js";

/**
 * In-process fake VXI-11 core-channel instrument on top of the fake RPC server (which also serves
 * the portmapper on the same port). Models what was measured on the UTS3036B:
 *  - writes are accepted at once; commands issued during a simulated sweep are QUEUED (not dropped)
 *    and executed in order when the sweep ends, so a blocking `*OPC?` read returns `1` only then;
 *  - the serial poll answers immediately with a status byte that stays 0 (see `stb`).
 * With `firmware: true` it also reproduces what the real analyzer does with reads (issue #75):
 *  - a device_read with io_timeout 0 always answers error 15, even when a reply is waiting;
 *  - a device_read with a non-zero io_timeout and nothing to deliver is NEVER answered with error 15: the
 *    instrument waits 5.4 x io_timeout and then drops the request silently, and later calls on the
 *    link (device_write) wait until it has given up;
 *  - the output buffer has one slot: starting any statement discards an unread older reply (also one
 *    produced earlier by a statement that was queued behind a sweep), and readers are only woken after
 *    the statements that run back to back have finished.
 * Scriptable SCPI handler, simulated I/O timeouts (error 15: a read with nothing to deliver waits
 * the io_timeout), injected errors (invalid link, locked, any code) and dropped connections.
 */

const CORE_PROGRAM = 395183;
const PROC = { createLink: 10, write: 11, read: 12, readStb: 13, clear: 15, destroyLink: 23 } as const;
const FLAG_END = 8;
const REASON_REQCNT = 1;
const REASON_END = 4;
/** Real firmware: a blocked read lasts this many times its io_timeout before the instrument gives up (measured 5.37). */
export const FIRMWARE_READ_WAIT_FACTOR = 5.4;
/** Real firmware: `:INITiate:IMMediate` starts a single sweep. */
const SWEEP_START = /^:?INIT(iate)?(:IMM(ediate)?)?$/i;

/** Return the reply (a trailing LF is added to strings), or undefined for no reply. */
export type ScpiHandler = (command: string, instrument: FakeVxi11Instrument) => string | Buffer | undefined | Promise<string | Buffer | undefined>;

export interface FakeVxi11Options {
  /** Device name create_link accepts (default "inst0"). */
  device?: string;
  /** maxRecvSize reported by create_link; larger writes are rejected with error 5 (default 1 MiB). */
  maxRecvSize?: number;
  /** Deliver at most this many bytes per device_read even if more are requested (reason REQCNT). */
  maxReadChunk?: number;
  /** Duration of a simulated sweep started by `:INITiate:IMMediate`; 0 = no sweep simulation. */
  sweepMs?: number;
  /** Accept at most this many bytes per device_write (partial writes). */
  writeAcceptLimit?: number;
  /** Mimic the real firmware's silent read timeouts and single output slot (see above). */
  firmware?: boolean;
  /**
   * The first `n` links created are "stale": the instrument accepts create_link but never answers any later
   * call on them except destroy_link (the symptom of issue #127, a link left over from a previous process).
   */
  staleFirstLinks?: number;
  scpi?: ScpiHandler;
}

interface LinkState {
  input: Buffer;
  output: Buffer[];
  waiters: Set<() => void>;
  /** firmware mode: a blocked read that later calls on this link wait for. */
  busy?: Promise<void>;
}

export interface FakeVxi11Instrument {
  /** TCP port of both the portmapper and the core channel. */
  port: number;
  rpc: FakeRpcServer;
  /** Open link ids. Clearing it simulates the instrument forgetting links. */
  links: Set<number>;
  createLinkDevices: string[];
  /** Every device_write received. */
  writes: { linkId: number; data: Buffer; flags: number }[];
  /** SCPI statements executed, in order (queued sweep statements appear when they run). */
  received: string[];
  /** requestSize of every device_read. */
  readRequests: number[];
  /** io_timeout (ms) of every device_read. */
  readIoTimeouts: number[];
  clears: number;
  destroyedLinks: number;
  /** Status byte returned by device_readstb (the real instrument keeps 0). */
  stb: number;
  readonly sweeping: boolean;
  sweepsCompleted: number;
  setScpiHandler(handler: ScpiHandler): void;
  /** Link ids that stopped answering (see `staleFirstLinks`); `staleLinks.add(id)` makes an open link stall. */
  staleLinks: Set<number>;
  /** Make the next `count` calls of `procedure` fail with VXI-11 error `code`. */
  injectError(procedure: number, code: number, count?: number): void;
  /** Destroy the TCP connection when the next call of `procedure` arrives. */
  dropConnectionOnNext(procedure: number): void;
  close(): Promise<void>;
}

const defaultScpi: ScpiHandler = (c) => (/^\*IDN\?$/i.test(c) ? "UNI-T,UTS3036B,FAKE,1.0" : undefined);

export async function startFakeVxi11Instrument(options: FakeVxi11Options = {}): Promise<FakeVxi11Instrument> {
  const device = options.device ?? "inst0";
  const maxRecvSize = options.maxRecvSize ?? 1024 * 1024;
  const rpc = await startFakeRpcServer();
  let scpi: ScpiHandler = options.scpi ?? defaultScpi;
  let nextLink = 1000;
  let closed = false;
  let sweeping = false;
  let sweepTimer: NodeJS.Timeout | undefined;
  const timers = new Set<NodeJS.Timeout>();
  const linkState = new Map<number, LinkState>();
  const queued: { linkId: number; statement: string }[] = [];
  const injected = new Map<number, { code: number; count: number }>();
  const drops = new Set<number>();
  let chain: Promise<void> = Promise.resolve();

  const fake: FakeVxi11Instrument = {
    port: rpc.port,
    rpc,
    links: new Set(),
    createLinkDevices: [],
    writes: [],
    received: [],
    readRequests: [],
    readIoTimeouts: [],
    clears: 0,
    destroyedLinks: 0,
    stb: 0,
    staleLinks: new Set(),
    get sweeping() {
      return sweeping;
    },
    sweepsCompleted: 0,
    setScpiHandler(h) {
      scpi = h;
    },
    injectError(procedure, code, count = 1) {
      injected.set(procedure, { code, count });
    },
    dropConnectionOnNext(procedure) {
      drops.add(procedure);
    },
    async close() {
      closed = true;
      if (sweepTimer) clearTimeout(sweepTimer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of linkState.values()) for (const w of [...s.waiters]) w();
      await rpc.close();
    },
  };

  const pushOutput = (linkId: number, message: Buffer): void => {
    const s = linkState.get(linkId);
    if (!s) return;
    if (options.firmware) {
      s.output = [message];
      setTimeout(() => {
        for (const w of [...s.waiters]) w();
      }, 0);
      return;
    }
    s.output.push(message);
    for (const w of [...s.waiters]) w();
  };

  const runStatement = async (linkId: number, statement: string): Promise<void> => {
    if (sweeping) {
      queued.push({ linkId, statement });
      return;
    }
    fake.received.push(statement);
    if (options.firmware) {
      const link = linkState.get(linkId);
      if (link) link.output = [];
    }
    if ((options.sweepMs ?? 0) > 0 && SWEEP_START.test(statement)) {
      sweeping = true;
      sweepTimer = setTimeout(() => {
        sweeping = false;
        fake.sweepsCompleted++;
        // Drain what was queued during the sweep, in order, until another sweep starts.
        chain = chain.then(async () => {
          while (queued.length > 0 && !sweeping && !closed) {
            const next = queued.shift()!;
            await runStatement(next.linkId, next.statement);
          }
        });
      }, options.sweepMs);
      return;
    }
    if (/^\*OPC\?$/i.test(statement)) {
      pushOutput(linkId, Buffer.from("1\n", "latin1"));
      return;
    }
    const reply = await scpi(statement, fake);
    if (reply === undefined) return;
    pushOutput(linkId, typeof reply === "string" ? Buffer.from(reply + "\n", "latin1") : Buffer.concat([reply, Buffer.from("\n")]));
  };

  const execute = (linkId: number, text: string): void => {
    const statements = text
      .split("\n")
      .flatMap((line) => line.split(";"))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    chain = chain.then(async () => {
      for (const s of statements) if (!closed) await runStatement(linkId, s);
    });
  };

  /** Wrap a procedure: connection drop, error injection and link validation. */
  const register = (
    procedure: number,
    errorReply: (code: number) => XdrWriter,
    body: (args: XdrReader, linkId: number, link: LinkState, call: FakeRpcCall) => FakeRpcResult | Promise<FakeRpcResult>
  ): void => {
    rpc.register(CORE_PROGRAM, 1, procedure, (args, call) => {
      if (drops.delete(procedure)) {
        call.socket.destroy();
        return undefined;
      }
      const inj = injected.get(procedure);
      if (inj && inj.count > 0) {
        inj.count--;
        return errorReply(inj.code);
      }
      const linkId = args.u32();
      const link = linkState.get(linkId);
      if (!link || !fake.links.has(linkId)) return errorReply(4);
      if (fake.staleLinks.has(linkId) && procedure !== PROC.destroyLink) return undefined;
      return body(args, linkId, link, call);
    });
  };

  rpc.registerPortmapper(new Map([[portKey(CORE_PROGRAM, 1), rpc.port]]));

  // create_link: (clientId, lockDevice, lock_timeout, device) -> (error, linkId, abortPort, maxRecvSize)
  rpc.register(CORE_PROGRAM, 1, PROC.createLink, (args, call) => {
    if (drops.delete(PROC.createLink)) {
      call.socket.destroy();
      return undefined;
    }
    args.u32();
    args.bool();
    args.u32();
    const name = args.string(256);
    fake.createLinkDevices.push(name);
    const inj = injected.get(PROC.createLink);
    if (inj && inj.count > 0) {
      inj.count--;
      return new XdrWriter().u32(inj.code).u32(0).u32(0).u32(0);
    }
    if (name !== device) return new XdrWriter().u32(3).u32(0).u32(0).u32(0);
    const id = nextLink++;
    fake.links.add(id);
    if (fake.createLinkDevices.length <= (options.staleFirstLinks ?? 0)) fake.staleLinks.add(id);
    linkState.set(id, { input: Buffer.alloc(0), output: [], waiters: new Set() });
    return new XdrWriter().u32(0).u32(id).u32(111).u32(maxRecvSize);
  });

  // device_write: (link, io_timeout, lock_timeout, flags, data) -> (error, size)
  register(PROC.write, (c) => new XdrWriter().u32(c).u32(0), async (args, linkId, link) => {
    if (link.busy) await link.busy;
    args.u32();
    args.u32();
    const flags = args.u32();
    const data = args.opaque();
    if (data.length > maxRecvSize) return new XdrWriter().u32(5).u32(0);
    const accepted = Math.min(data.length, options.writeAcceptLimit ?? data.length);
    fake.writes.push({ linkId, data: Buffer.from(data), flags });
    link.input = Buffer.concat([link.input, data.subarray(0, accepted)]);
    if (accepted === data.length && (flags & FLAG_END) !== 0) {
      const text = link.input.toString("latin1");
      link.input = Buffer.alloc(0);
      execute(linkId, text);
    }
    return new XdrWriter().u32(0).u32(accepted);
  });

  // device_read: (link, requestSize, io_timeout, lock_timeout, flags, termChar) -> (error, reason, data)
  register(PROC.read, (c) => new XdrWriter().u32(c).u32(0).opaque(Buffer.alloc(0)), async (args, linkId, link) => {
    const requestSize = args.u32();
    const ioTimeout = args.u32();
    fake.readRequests.push(requestSize);
    fake.readIoTimeouts.push(ioTimeout);
    const timeoutReply = new XdrWriter().u32(15).u32(0).opaque(Buffer.alloc(0));
    if (options.firmware && ioTimeout === 0) return timeoutReply;
    if (link.output.length === 0) {
      if (ioTimeout === 0) return timeoutReply;
      let release: () => void = () => {};
      if (options.firmware) link.busy = new Promise<void>((resolve) => (release = resolve));
      const waitMs = options.firmware ? ioTimeout * FIRMWARE_READ_WAIT_FACTOR : ioTimeout;
      const delivered = await new Promise<boolean>((resolve) => {
        const finish = (ok: boolean): void => {
          clearTimeout(timer);
          timers.delete(timer);
          link.waiters.delete(wake);
          resolve(ok);
        };
        const wake = (): void => {
          // A deferred wake-up for an older reply can arrive while nothing is there: keep waiting.
          if (link.output.length > 0 || closed || !linkState.has(linkId)) finish(link.output.length > 0);
        };
        const timer = setTimeout(() => finish(false), waitMs);
        timers.add(timer);
        link.waiters.add(wake);
      });
      release();
      if (closed) return undefined;
      // The real firmware stays silent instead of answering error 15.
      if (!delivered && options.firmware) return undefined;
      if (!delivered || !linkState.has(linkId)) return timeoutReply;
    }
    const message = link.output[0];
    const limit = Math.min(requestSize, options.maxReadChunk ?? Number.MAX_SAFE_INTEGER);
    const part = message.subarray(0, limit);
    const rest = message.subarray(part.length);
    if (rest.length > 0) link.output[0] = rest;
    else link.output.shift();
    return new XdrWriter().u32(0).u32(rest.length > 0 ? REASON_REQCNT : REASON_END).opaque(part);
  });

  // device_readstb: (link, flags, lock_timeout, io_timeout) -> (error, stb)
  register(PROC.readStb, (c) => new XdrWriter().u32(c).u32(0), () => new XdrWriter().u32(0).u32(fake.stb));

  // device_clear: (link, flags, lock_timeout, io_timeout) -> error
  register(PROC.clear, (c) => new XdrWriter().u32(c), (_args, linkId, link) => {
    fake.clears++;
    link.output = [];
    link.input = Buffer.alloc(0);
    for (let i = queued.length - 1; i >= 0; i--) if (queued[i].linkId === linkId) queued.splice(i, 1);
    return new XdrWriter().u32(0);
  });

  // destroy_link: (link) -> error
  register(PROC.destroyLink, (c) => new XdrWriter().u32(c), (_args, linkId, link) => {
    fake.links.delete(linkId);
    linkState.delete(linkId);
    for (const w of [...link.waiters]) w();
    fake.destroyedLinks++;
    return new XdrWriter().u32(0);
  });

  return fake;
}
