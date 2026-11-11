import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { findPrivateData } from "../../scripts/sync-wiki.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const GUIDE = "docs/manual-testing-guide.md";

async function toolNames(): Promise<string[]> {
  const server = createServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "guide-coverage", version: "0.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

/** Backticked tokens in the guide's checklist table rows (lines starting with "| " and a step id). */
function stepRows(doc: string): string[] {
  return doc.split("\n").filter((l) => /^\|\s*[A-Z]{2,4}\d+\s*\|/.test(l));
}

describe("docs/manual-testing-guide.md", () => {
  const doc = read(GUIDE);

  it("mentions every tool of the built server's tools/list in a checklist step", async () => {
    const rows = stepRows(doc).join("\n");
    const missing = (await toolNames()).filter((n) => !rows.includes(`\`${n}\``));
    expect(missing, `Add a checklist step to ${GUIDE} for: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not name tools that no longer exist in its steps", async () => {
    const registered = new Set(await toolNames());
    const named = new Set<string>();
    for (const row of stepRows(doc)) for (const m of row.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) named.add(m[1]);
    const known = new Set([...registered, "scpi_query"]);
    const unknown = [...named].filter((n) => !known.has(n) && /^(get|set|read|exit|configure|delete|discover|wait_for|restart)_/.test(n));
    expect(unknown).toEqual([]);
  });

  it("has a checklist section for every tool group, on both transports", () => {
    for (const group of ["Connection", "Raw SCPI", "Frequency", "Amplitude", "Bandwidth, sweep and detector", "Acquisition", "Trace", "Markers", "Marker functions", "Measurements", "Screenshot", "Limit lines", "Tracking generator", "Discovery"]) {
      const headings = doc.split("\n").filter((l) => /^### [A-Z]\d+\. /.test(l)).map((l) => l.replace(/^### [A-Z]\d+\. /, ""));
      expect(headings, group).toContain(group);
    }
    expect(doc).toMatch(/raw/i);
    expect(doc).toMatch(/VXI-11/);
    expect(doc).toContain("| Raw | VXI-11 |");
  });

  it("states the remote-mode behavior and the rules that follow from it", () => {
    for (const s of ["remote mode", "Esc", ":KEY:", ":SYSTem:LOCK 0", "device_local", ":KEY:ESC", "V1.04.0040", "SRQ", "unknown", "first"]) {
      expect(doc, s).toContain(s);
    }
  });

  it("has setup, restore, reporting template and troubleshooting sections", () => {
    for (const h of ["Prerequisites", "Safe setup", "Restore", "Reporting template", "Troubleshooting"]) {
      expect(doc, h).toMatch(new RegExp(`^## .*${h}`, "m"));
    }
    for (const s of ["UTS_VXI11_PROBE_TIMEOUT_S", "ECONNRESET", "-113", "port 111", "Model", "Firmware"]) expect(doc, s).toContain(s);
  });

  it("contains no real IP address, serial number or personal email", () => {
    expect(findPrivateData(doc)).toEqual([]);
    expect(doc).toContain("192.168.1.100");
  });

  it("only links to files and anchors that exist", () => {
    const links = [...doc.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/i.test(l));
    expect(links.length).toBeGreaterThan(3);
    for (const link of links) {
      const [path, anchor] = link.split("#");
      const target = path ? normalize(join(dirname(GUIDE), path)) : GUIDE;
      expect(existsSync(join(ROOT, target)), link).toBe(true);
      if (anchor && target.endsWith(".md")) {
        const slugs = read(target)
          .split("\n")
          .filter((l) => /^#{1,6}\s/.test(l))
          .map((l) => l.replace(/^#+\s+/, "").toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/ /g, "-"));
        expect(slugs, link).toContain(anchor);
      }
    }
  });
});

describe("the guide is linked from the rest of the documentation", () => {
  it.each([
    ["README.md", "docs/manual-testing-guide.md"],
    ["CONTRIBUTING.md", "docs/manual-testing-guide.md"],
    ["docs/releasing.md", "manual-testing-guide.md"],
    ["docs/wiki/Manual-Testing.md", "docs/manual-testing-guide.md"],
    ["docs/wiki/_Sidebar.md", "Manual-Testing"],
    ["docs/wiki/Development.md", "Manual Testing"],
  ])("%s links to it", (file, needle) => {
    expect(read(file)).toContain(needle);
  });

  it("CONTRIBUTING no longer says the guide does not exist yet", () => {
    expect(read("CONTRIBUTING.md")).not.toContain("once it exists");
  });
});
