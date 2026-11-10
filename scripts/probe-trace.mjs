#!/usr/bin/env node
// Probe of trace data and screenshot formats (issue #3).
// Usage: node scripts/probe-trace.mjs <output-dir> [host]   (host defaults to UTS_IP)
//   bash:        UTS_IP=192.168.1.100 node scripts/probe-trace.mjs out
//   PowerShell:  $env:UTS_IP = "192.168.1.100"; node scripts/probe-trace.mjs out
//   cmd:         set UTS_IP=192.168.1.100 && node scripts/probe-trace.mjs out
// Reads trace data and the screenshot; the only state change is switching :FORMat
// (and :SYSTem:PICture:FORMat if it exists), which is restored afterwards.
// Raw replies are written to <output-dir> for inspection; nothing is redacted there,
// so review files before committing any as fixtures.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const host = process.argv[3] || process.env.UTS_IP;
const port = Number(process.env.UTS_PORT || 5025);
const outDir = process.argv[2];
if (!host || !outDir) {
  console.error("Usage: node scripts/probe-trace.mjs <output-dir> [host]   (or set UTS_IP)");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

/** Send lines, then collect every byte until `idleMs` passes with no data (or maxMs). */
function raw(lines, { idleMs = 1200, maxMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const chunks = [];
    let idle;
    const started = Date.now();
    const done = () => {
      clearTimeout(idle);
      sock.destroy();
      resolve({ data: Buffer.concat(chunks), ms: Date.now() - started });
    };
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(done, Date.now() - started > maxMs ? 0 : idleMs);
    };
    sock.on("data", (d) => {
      chunks.push(d);
      arm();
    });
    sock.on("error", done);
    sock.connect(port, host, () => {
      sock.write(lines.map((l) => l + "\n").join(""));
      arm();
    });
  });
}

const q = async (cmd) => (await raw([cmd], { idleMs: 600 })).data.toString().trim();
const save = (name, buf) => fs.writeFileSync(path.join(outDir, name), buf);
const hex = (b, n = 24) => b.subarray(0, n).toString("hex").replace(/(..)/g, "$1 ").trim();

console.log("== settings ==");
const originalFormat = await q(":FORMat?");
const settings = {};
for (const c of [":FORMat?", ":SWEep:POINts?", ":FREQuency:STARt?", ":FREQuency:STOP?", ":UNIT:POWer?", ":TRACe:SELect?", ":SYSTem:PICture:FORMat?", ":INITiate:CONTinuous?"]) {
  settings[c] = await q(c);
  console.log(c.padEnd(28), JSON.stringify(settings[c]) || "(no reply)");
}
const points = Number(settings[":SWEep:POINts?"]);

function analyzeAscii(buf, label) {
  const text = buf.toString("latin1");
  const parts = text.replace(/[\r\n]+$/, "").split(",");
  const nums = parts.map(Number);
  const bad = nums.filter((n) => Number.isNaN(n)).length;
  console.log(`${label}: ${buf.length} bytes, ${parts.length} values (sweep points ${points}), non-numeric ${bad}, ends with ${JSON.stringify(text.slice(-3))}, first ${JSON.stringify(parts.slice(0, 3))}, min ${Math.min(...nums).toFixed(2)} max ${Math.max(...nums).toFixed(2)}, separator ${JSON.stringify(text.slice(parts[0].length, parts[0].length + 2))}`);
}

console.log("== ASCII trace ==");
await raw([":FORMat ASCii"], { idleMs: 300 });
console.log(":FORMat? ->", JSON.stringify(await q(":FORMat?")));
let r = await raw([":TRACe:DATA? TRACE1"]);
save("trace1-ascii.bin", r.data);
analyzeAscii(r.data, "TRACE1 ascii");

for (const fmt of ["REAL32", "REAL64"]) {
  console.log(`== ${fmt} trace ==`);
  await raw([`:FORMat ${fmt}`], { idleMs: 300 });
  console.log(":FORMat? ->", JSON.stringify(await q(":FORMat?")));
  r = await raw([":TRACe:DATA? TRACE1"]);
  save(`trace1-${fmt.toLowerCase()}.bin`, r.data);
  const b = r.data;
  console.log(`${fmt}: ${b.length} bytes, first bytes ${hex(b)}`);
  const m = b.toString("latin1", 0, 12).match(/^#(\d)(\d+)/);
  if (m) {
    const digits = Number(m[1]);
    const len = Number(b.toString("latin1", 2, 2 + digits));
    const start = 2 + digits;
    const size = fmt === "REAL32" ? 4 : 8;
    console.log(`  header #${digits}, declared length ${len}, values ${len / size} (sweep points ${points}), trailing bytes after payload ${b.length - start - len}: ${hex(b.subarray(start + len), 8)}`);
    const payload = b.subarray(start, start + len);
    for (const [name, rd] of fmt === "REAL32"
      ? [["LE", (o) => payload.readFloatLE(o)], ["BE", (o) => payload.readFloatBE(o)]]
      : [["LE", (o) => payload.readDoubleLE(o)], ["BE", (o) => payload.readDoubleBE(o)]]) {
      const vals = [];
      for (let o = 0; o + size <= payload.length; o += size) vals.push(rd(o));
      const sane = vals.filter((v) => v > -200 && v < 50).length;
      console.log(`  ${name}: ${sane}/${vals.length} values in -200..50, first ${vals.slice(0, 3).map((v) => v.toFixed(2))}`);
    }
  } else {
    console.log("  no # block header found; first text:", JSON.stringify(b.toString("latin1", 0, 60)));
  }
}
await raw([`:FORMat ${originalFormat}`], { idleMs: 300 });
console.log("restored :FORMat ->", JSON.stringify(await q(":FORMat?")), "(was", JSON.stringify(originalFormat) + ")");

console.log("== screenshot ==");
for (const cmd of [":DISPlay:ZBmp?", ":DISPlay:DATA?"]) {
  r = await raw([cmd], { idleMs: 2500, maxMs: 30000 });
  const name = cmd.replace(/[^A-Za-z]/g, "");
  save(`${name}.bin`, r.data);
  console.log(`${cmd}: ${r.data.length} bytes in ${r.ms} ms, first bytes ${hex(r.data)} | text ${JSON.stringify(r.data.toString("latin1", 0, 24))}`);
}
