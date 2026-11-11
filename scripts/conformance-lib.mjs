// Simulator conformance suite (issue #147): the scripted SCPI exchange, the transcript recorder/redactor/differ and
// a minimal raw TCP client. Used by scripts/conformance.mjs (a real analyzer, on demand) and by
// tests/e2e/conformance.test.ts (the simulator, in CI). See docs/releasing.md, "Simulator conformance".
//
// A transcript is text: "> <command>" for every line sent and "< <reply>" for the reply to a query
// ("< <no reply>" when the instrument stays silent). Setters have no reply line.
import net from "node:net";

// ------------------------------------------------------------------ redaction

/** Removes what must never be committed: the serial in *IDN? replies, IPv4 and MAC addresses. */
export function redact(text) {
  return text
    .replace(/^([^,\r\n]*,[^,\r\n]*,)[^,\r\n]*(,[^\r\n]*)$/, "$1<serial>$2")
    .replace(/\b([A-Za-z][A-Za-z-]*,UTS[0-9A-Za-z]+,)[^,\s]+/g, "$1<serial>") // an *IDN? reply inside other text
    .replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, "<mac>")
    .replace(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, "<ip>");
}

// ------------------------------------------------------------------ transcript

const NO_REPLY = "<no reply>";

/** entries: [{cmd, reply?}] where reply is a string, null (silence) or absent (a setter). */
export function formatTranscript(entries) {
  let out = "";
  for (const e of entries) {
    out += `> ${e.cmd}\n`;
    if (e.reply === null) out += `< ${NO_REPLY}\n`;
    else if (e.reply !== undefined) out += `< ${e.reply}\n`;
  }
  return out;
}

export function parseTranscript(text) {
  const entries = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) return;
    if (line.startsWith("> ")) entries.push({ cmd: line.slice(2) });
    else if (line.startsWith("< ")) {
      const last = entries.at(-1);
      if (!last || "reply" in last) throw new Error(`transcript line ${i + 1}: reply without a command`);
      last.reply = line.slice(2) === NO_REPLY ? null : line.slice(2);
    } else throw new Error(`transcript line ${i + 1}: expected "> " or "< "`);
  });
  return entries;
}

const show = (e) => (e === undefined ? "<missing>" : e.reply === undefined ? `${e.cmd}` : `${e.reply === null ? NO_REPLY : e.reply}`);

/**
 * Compares two transcripts entry by entry. `known` lists documented divergences of the real analyzer from the
 * simulator: {cmd, actual: <regex source the real reply must match>, note}. A difference that matches one is
 * reported with `known: note` and does not count as unexplained.
 */
export function diffTranscripts(expected, actual, known = []) {
  const differences = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const a = actual[i];
    if (e && a && e.cmd === a.cmd && e.reply === a.reply) continue;
    const sameCmd = e && a && e.cmd === a.cmd;
    const d = {
      index: i,
      cmd: (e ?? a).cmd,
      expected: show(e),
      actual: sameCmd || !a || !e ? show(a) : `${a.cmd} -> ${show(a)}`,
      known: null,
    };
    if (sameCmd) {
      const k = known.find((x) => x.cmd === a.cmd && new RegExp(x.actual).test(show(a)));
      if (k) d.known = k.note;
    }
    differences.push(d);
  }
  return {
    identical: differences.length === 0,
    differences,
    unexplained: differences.filter((d) => d.known === null).length,
  };
}

/** Where the real analyzer differs from the simulator on purpose; each entry needs a note (docs/verified-hardware.md). */
export const KNOWN_DIVERGENCES = [];

// ------------------------------------------------------------------ the exchange

/**
 * Settings the exchange touches. Each is read first and written back at the end (a value, then its AUTO flag where
 * there is one). `get` is a query, `set` the setter that takes the reply as its argument.
 */
export const RESTORE_PLAN = [
  { get: ":SENSe:FREQuency:CENTer?", set: ":SENSe:FREQuency:CENTer" },
  { get: ":SENSe:FREQuency:SPAN?", set: ":SENSe:FREQuency:SPAN" },
  { get: ":UNIT:POWer?", set: ":UNIT:POWer" },
  { get: ":DISPlay:WINDow:TRACe:Y:SCALe:RLEVel?", set: ":DISPlay:WINDow:TRACe:Y:SCALe:RLEVel" },
  { get: ":POWer:ATTenuation?", set: ":POWer:ATTenuation" },
  { get: ":POWer:ATTenuation:AUTO?", set: ":POWer:ATTenuation:AUTO" },
  { get: ":SENSe:BANDwidth:RESolution?", set: ":SENSe:BANDwidth:RESolution" },
  { get: ":SENSe:BANDwidth:RESolution:AUTO?", set: ":SENSe:BANDwidth:RESolution:AUTO" },
  { get: ":SENSe:BANDwidth:VIDeo?", set: ":SENSe:BANDwidth:VIDeo" },
  { get: ":SENSe:BANDwidth:VIDeo:AUTO?", set: ":SENSe:BANDwidth:VIDeo:AUTO" },
  { get: ":SENSe:DETector:TRACe1?", set: ":SENSe:DETector:TRACe1" },
  { get: ":SENSe:DETector:TRACe1:AUTO?", set: ":SENSe:DETector:TRACe1:AUTO" },
  { get: ":TRACe2:TYPE?", set: ":TRACe2:TYPE" },
  { get: ":CALCulate:MARKer1:MODE?", set: ":CALCulate:MARKer1:MODE" },
  { get: ":CALCulate:MARKer1:X?", set: ":CALCulate:MARKer1:X" },
  { get: ":SOURce:POWer?", set: ":SOURce:POWer" },
];

/** The scripted exchange: {cmd} (sent; a "?" makes it a query) or {wait: ms}. Read-only apart from RESTORE_PLAN. */
export const EXCHANGE = [
  { cmd: "*IDN?" },
  { cmd: "*CLS" },
  { cmd: ":SYSTem:ERRor?" },
  // frequency: set, read back, clamping
  { cmd: ":SENSe:FREQuency:CENTer 1 GHz" },
  { cmd: ":SENSe:FREQuency:CENTer?" },
  { cmd: ":SENSe:FREQuency:SPAN 100 MHz" },
  { cmd: ":SENSe:FREQuency:SPAN?" },
  { cmd: ":SENSe:FREQuency:STARt?" },
  { cmd: ":SENSe:FREQuency:STOP?" },
  { cmd: ":SENSe:FREQuency:SPAN 10 GHz" },
  { cmd: ":SENSe:FREQuency:SPAN?" },
  { cmd: ":SENSe:FREQuency:CENTer?" },
  { cmd: ":SENSe:FREQuency:STARt?" },
  { cmd: ":SENSe:FREQuency:STOP?" },
  { cmd: ":SENSe:FREQuency:CENTer 1 GHz" },
  { cmd: ":SENSe:FREQuency:SPAN 3 GHz" },
  { cmd: ":SENSe:FREQuency:SPAN?" },
  { cmd: ":SENSe:FREQuency:CENTer?" },
  { cmd: ":SENSe:FREQuency:CENTer 100 kHz" },
  { cmd: ":SENSe:FREQuency:SPAN?" },
  { cmd: ":SENSe:FREQuency:STARt?" },
  { cmd: ":SENSe:FREQuency:CENTer 1 GHz" },
  { cmd: ":SENSe:FREQuency:SPAN 100 MHz" },
  // amplitude
  { cmd: ":DISPlay:WINDow:TRACe:Y:SCALe:RLEVel -10 dBm" },
  { cmd: ":DISPlay:WINDow:TRACe:Y:SCALe:RLEVel?" },
  { cmd: ":POWer:ATTenuation:AUTO?" },
  { cmd: ":POWer:ATTenuation 20" },
  { cmd: ":POWer:ATTenuation?" },
  { cmd: ":POWer:ATTenuation:AUTO?" },
  { cmd: ":UNIT:POWer DBMV" },
  { cmd: ":UNIT:POWer?" },
  { cmd: ":DISPlay:WINDow:TRACe:Y:SCALe:RLEVel?" },
  { cmd: ":UNIT:POWer DBM" },
  // bandwidth
  { cmd: ":SENSe:BANDwidth:RESolution 50 kHz" },
  { cmd: ":SENSe:BANDwidth:RESolution?" },
  { cmd: ":SENSe:BANDwidth:RESolution:AUTO?" },
  { cmd: ":SENSe:BANDwidth:VIDeo 1 kHz" },
  { cmd: ":SENSe:BANDwidth:VIDeo?" },
  { cmd: ":SENSe:BANDwidth:VIDeo:AUTO?" },
  { cmd: ":SENSe:BANDwidth:RESolution:AUTO ON" },
  { cmd: ":SENSe:BANDwidth:RESolution:AUTO?" },
  // detector, trace type, markers, tracking generator, formats
  { cmd: ":SENSe:DETector:TRACe1 POSitive" },
  { cmd: ":SENSe:DETector:TRACe1?" },
  { cmd: ":SENSe:DETector:TRACe1:AUTO?" },
  { cmd: ":TRACe2:TYPE MAXHold" },
  { cmd: ":TRACe2:TYPE?" },
  { cmd: ":CALCulate:MARKer1:MODE POSition" },
  { cmd: ":CALCulate:MARKer1:MODE?" },
  { cmd: ":CALCulate:MARKer1:X 1 GHz" },
  { cmd: ":CALCulate:MARKer1:X?" },
  { cmd: ":CALCulate:MARKer1:MODE OFF" },
  { cmd: ":CALCulate:MARKer1:MODE?" },
  { cmd: ":OUTPut:STATe?" },
  { cmd: ":SOURce:POWer -20 dBm" },
  { cmd: ":SOURce:POWer?" },
  { cmd: ":FORMat?" },
  { cmd: ":SYSTem:PICture:FORMat?" },
  // error handling: a bad suffix (two errors), a bad enum value, then an empty queue
  { cmd: ":SENSe:FREQuency:CENTer 1 XYZ" },
  { cmd: ":SYSTem:ERRor?" },
  { cmd: ":SYSTem:ERRor?" },
  { cmd: ":SYSTem:ERRor?" },
  { cmd: ":CALCulate:MARKer1:MODE BOGUS" },
  { cmd: ":SYSTem:ERRor?" },
  { cmd: ":SYSTem:ERRor?" },
  // an unsupported query: no reply, then (after the stall) the -113 that lands about 4 s later
  { cmd: ":INPut:IMPedance?" },
  { wait: 2000 },
  { cmd: ":SYSTem:ERRor?" },
  { cmd: ":SYSTem:ERRor?" },
];

// ------------------------------------------------------------------ running

/** Why a live run must not start now (null = allowed). It is opt-in and never runs in CI. */
export function refuseReason(env) {
  if (!env.UTS_IP) return "UTS_IP is not set (the analyzer's address; it is never stored in the repo)";
  if (env.UTS_CONFORMANCE_LIVE !== "1") return "UTS_CONFORMANCE_LIVE=1 is not set (the live run is opt-in)";
  if (env.CI) return "CI is set: the live run needs a real analyzer and never runs in CI";
  return null;
}

/**
 * Runs the exchange through `client` ({query, send, sleep}): snapshot, steps (recorded), restore (always, even when a
 * step throws), then *CLS and a check that the error queue is empty. Returns {entries, restoreProblems}.
 */
export async function runExchange(client, { steps = EXCHANGE, plan = RESTORE_PLAN } = {}) {
  const sync = () => client.query("*OPC?");
  const saved = [];
  const restoreProblems = [];
  for (const item of plan) {
    const v = await client.query(item.get);
    if (v === null) restoreProblems.push(`${item.get} got no reply: ${item.set} will not be restored`);
    else saved.push({ ...item, value: v.trim() });
  }
  const entries = [];
  let failure;
  try {
    for (const s of steps) {
      if (s.wait !== undefined) {
        await client.sleep(s.wait);
        continue;
      }
      if (s.cmd.includes("?")) {
        entries.push({ cmd: s.cmd, reply: await client.query(s.cmd) });
      } else {
        entries.push({ cmd: s.cmd });
        await client.send(s.cmd);
        if (s.cmd !== "*CLS") await sync();
      }
    }
  } catch (e) {
    failure = e;
  }
  for (const item of saved) {
    await client.send(`${item.set} ${item.value}`);
    await sync();
  }
  for (const item of saved) {
    const v = await client.query(item.get);
    if (v === null || v.trim() !== item.value) restoreProblems.push(`${item.get} read ${v === null ? "no reply" : v.trim()} after restore, was ${item.value}`);
  }
  await client.sleep(0);
  await client.send("*CLS");
  const err = await client.query(":SYSTem:ERRor?");
  if (err === null || !/^0\b/.test(err.trim())) restoreProblems.push(`error queue not clean after the run: ${err}`);
  if (failure) throw failure;
  return { entries, restoreProblems };
}

/** Minimal raw SCPI client (LF out, CRLF in). After a query that got no reply it waits 2.6 s (the instrument stalls ~2.15 s). */
export async function connectRaw(host, port, { replyTimeoutMs = 2000 } = {}) {
  const socket = new net.Socket();
  let buf = "";
  let waiter = null;
  socket.setEncoding("latin1");
  socket.on("data", (d) => {
    buf += d;
    waiter?.();
  });
  socket.on("error", () => waiter?.());
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, host, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const client = {
    sleep,
    async send(cmd) {
      await new Promise((resolve, reject) => socket.write(cmd + "\n", (e) => (e ? reject(e) : resolve())));
    },
    async query(cmd) {
      buf = "";
      await client.send(cmd);
      const deadline = Date.now() + replyTimeoutMs;
      while (!buf.includes("\n") && Date.now() < deadline && !socket.destroyed) {
        await new Promise((r) => {
          waiter = r;
          setTimeout(r, Math.max(1, deadline - Date.now()));
        });
      }
      waiter = null;
      const i = buf.indexOf("\n");
      if (i < 0) {
        await sleep(2600);
        return null;
      }
      return buf.slice(0, i).replace(/\r$/, "");
    },
    close() {
      socket.destroy();
    },
  };
  return client;
}
