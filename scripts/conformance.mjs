#!/usr/bin/env node
// Runs the conformance exchange against a REAL analyzer and diffs the redacted transcript against the committed one
// (tests/fixtures/conformance/exchange.txt), the transcript the simulator must also reproduce. On demand only:
//
//   UTS_IP=192.168.1.100 UTS_CONFORMANCE_LIVE=1 node scripts/conformance.mjs [--out transcript.txt] [--record]
//
// It refuses to run without UTS_IP and UTS_CONFORMANCE_LIVE=1, and never when CI is set. It sends only the commands in
// scripts/conformance-lib.mjs (no *RST, no :KEY:, no :SYSTem:LOCK), puts every setting it touches back and checks that
// the error queue is empty at the end. The first query puts the analyzer into remote mode (front panel locked until the
// owner presses Esc on it): tell the owner before you run it. Exit 0 = no unexplained difference and a clean restore.
// --record rewrites the committed transcript from this run (review the diff before committing).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectRaw, runExchange, redact, formatTranscript, parseTranscript, diffTranscripts, refuseReason, KNOWN_DIVERGENCES } from "./conformance-lib.mjs";

const EXPECTED = fileURLToPath(new URL("../tests/fixtures/conformance/exchange.txt", import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

const why = refuseReason(process.env);
if (why) {
  console.error(`conformance: not running: ${why}`);
  process.exit(2);
}

const client = await connectRaw(process.env.UTS_IP, Number(process.env.UTS_PORT || 5025), { replyTimeoutMs: 3000 });
let run;
try {
  run = await runExchange(client);
} finally {
  client.close();
}

const actual = run.entries.map((e) => (typeof e.reply === "string" ? { ...e, reply: redact(e.reply) } : e));
const text = formatTranscript(actual);
if (opt("--out")) writeFileSync(opt("--out"), text);
if (args.includes("--record")) {
  writeFileSync(EXPECTED, text);
  console.log(`conformance: wrote ${EXPECTED}`);
}
const diff = diffTranscripts(parseTranscript(readFileSync(EXPECTED, "utf8")), actual, KNOWN_DIVERGENCES);
for (const d of diff.differences) {
  console.log(`${d.known ? "known  " : "DIFFERS"} #${d.index} ${d.cmd}\n    committed: ${d.expected}\n    analyzer:  ${d.actual}${d.known ? `\n    note: ${d.known}` : ""}`);
}
for (const p of run.restoreProblems) console.log(`RESTORE ${p}`);
console.log(`conformance: ${run.entries.length} steps, ${diff.differences.length} differences (${diff.unexplained} unexplained), ${run.restoreProblems.length} restore problems`);
process.exit(diff.unexplained === 0 && run.restoreProblems.length === 0 ? 0 : 1);
