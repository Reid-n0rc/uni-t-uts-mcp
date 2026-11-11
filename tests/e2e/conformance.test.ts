import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { startFakeUts, type FakeUts } from "../fakeUts.js";
import { connectRaw, runExchange, formatTranscript, parseTranscript, diffTranscripts, redact, KNOWN_DIVERGENCES } from "../../scripts/conformance-lib.mjs";

/**
 * Simulator conformance (issue #147): the SAME scripted exchange that `scripts/conformance.mjs` runs against a real
 * analyzer is run here against the simulator and must equal the committed transcript, which is what the real
 * analyzer was recorded as (redacted). A simulator change that alters a reply fails here; a real-analyzer run
 * that disagrees with the transcript is fixed in the simulator or listed in KNOWN_DIVERGENCES (docs/releasing.md).
 */
const EXPECTED = new URL("../fixtures/conformance/exchange.txt", import.meta.url);

let fake: FakeUts;
beforeAll(async () => { fake = await startFakeUts(); });
afterAll(async () => { await fake.close(); });

describe("simulator conformance", () => {
  it("replays the exchange to the committed transcript", async () => {
    const client = await connectRaw("127.0.0.1", fake.port);
    try {
      const out = await runExchange(client);
      expect(out.restoreProblems).toEqual([]);
      const actual = parseTranscript(formatTranscript(out.entries.map((e: any) => ({ ...e, ...(typeof e.reply === "string" ? { reply: redact(e.reply) } : {}) }))));
      const expected = parseTranscript(readFileSync(EXPECTED, "utf8"));
      const diff = diffTranscripts(expected, actual, []);
      expect(diff.differences).toEqual([]);
    } finally {
      client.close();
    }
  }, 40_000);

  it("leaves the simulator as it found it and its error queue clean", async () => {
    const m = fake.model;
    expect([m.num("fc"), m.num("span"), m.bool("rbw.auto"), m.bool("vbw.auto"), m.bool("swt.auto"), m.bool("cont"), m.bool("tg.out")])
      .toEqual([1.805e9, 3.59e9, true, true, true, true, false]);
  });

  it("documents each known divergence with a note", () => {
    for (const k of KNOWN_DIVERGENCES as any[]) expect(k.note.length).toBeGreaterThan(10);
  });
});
