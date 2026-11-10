import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("createServer", () => {
  it("builds a server exposing the connection and raw SCPI tools", async () => {
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["connect", "disconnect", "discover_instruments", "identify", "scpi_query", "scpi_command", "get_frequency", "set_frequency", "get_amplitude", "set_amplitude", "get_bandwidth", "set_bandwidth", "get_sweep", "set_sweep", "get_detector", "set_detector", "get_acquisition", "set_acquisition", "start_sweep", "single_sweep", "wait_for_sweep_complete", "get_trace", "set_trace", "set_trace_math", "restart_trace", "get_trace_data", "screenshot", "get_marker", "set_marker", "marker_search", "marker_to_instrument", "markers_all_off", "get_peak_criteria", "set_peak_criteria", "get_measurement", "configure_measurement", "read_measurement", "exit_measurement", "measure"]) expect(names).toContain(n);
  });
});
