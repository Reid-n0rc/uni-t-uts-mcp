#!/usr/bin/env node
// Read-only probe of SCPI basics (issue #2). Host comes from UTS_IP, never hard-coded.
// Sends only queries plus *CLS (clears status registers; no instrument settings change).
// Serial numbers are redacted from the output.
import net from "node:net";

const host = process.env.UTS_IP;
const port = Number(process.env.UTS_PORT || 5025);
if (!host) {
  console.error("Set UTS_IP");
  process.exit(1);
}

function redact(text) {
  // *IDN? is "maker,model,serial,version": blank out the third field.
  return text.replace(/^([^,]*,[^,]*,)[^,]*(,.*)$/, "$1<redacted>$2");
}

function probe(payload, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let data = Buffer.alloc(0);
    const started = Date.now();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    sock.on("error", (e) => finish({ error: e.message }));
    sock.on("data", (d) => {
      data = Buffer.concat([data, d]);
      if (data.includes(0x0a)) finish({ reply: JSON.stringify(redact(data.toString().replace(/\r?\n$/, ""))) });
    });
    sock.setTimeout(timeoutMs, () =>
      finish(data.length ? { reply: JSON.stringify(redact(data.toString())) } : { timeout: true })
    );
    sock.connect(port, host, () => sock.write(payload));
  });
}

const cases = [
  ["terminator LF", "*IDN?\n"],
  ["terminator CRLF", "*IDN?\r\n"],
  ["terminator CR only", "*IDN?\r"],
  ["no terminator", "*IDN?"],
  ["*OPC?", "*OPC?\n"],
  ["*ESR?", "*ESR?\n"],
  ["*STB?", "*STB?\n"],
  ["*ESE?", "*ESE?\n"],
  ["*SRE?", "*SRE?\n"],
  ["*CLS then *ESR?", "*CLS\n*ESR?\n"],
  [":SYSTem:ERRor?", ":SYSTem:ERRor?\n"],
  [":SYSTem:ERRor:NEXT?", ":SYSTem:ERRor:NEXT?\n"],
  [":STATus:OPERation:CONDition?", ":STATus:OPERation:CONDition?\n"],
  [":STATus:QUEStionable:CONDition?", ":STATus:QUEStionable:CONDition?\n"],
  [":SYSTem:VERSion?", ":SYSTem:VERSion?\n"],
  [":INITiate:CONTinuous?", ":INITiate:CONTinuous?\n"],
  [":SWEep:POINts?", ":SWEep:POINts?\n"],
  [":SWEep:TIME?", ":SWEep:TIME?\n"],
  [":FORMat?", ":FORMat?\n"],
  ["unknown query (error behavior)", ":NOT:ACOMMAND?\n"],
  ["unknown query then *OPC?", ":NOT:ACOMMAND?\n*OPC?\n"],
];

for (const [name, payload] of cases) {
  const r = await probe(payload);
  console.log(`${name.padEnd(36)} ${JSON.stringify(payload).padEnd(34)} -> ${r.timeout ? "TIMEOUT (no reply)" : r.error ? "ERROR " + r.error : r.reply}  [${r.ms} ms]`);
  await new Promise((r) => setTimeout(r, 300));
}
