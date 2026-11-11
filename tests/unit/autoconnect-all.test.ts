import { describe, it, expect, vi } from "vitest";

const mockDiscover = vi.hoisted(() => vi.fn());
vi.mock("../../src/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/discovery.js")>()),
  discoverInstruments: mockDiscover,
}));
import { autoConnectAll } from "../../src/autoconnect.js";

const conn = () => ({ connect: vi.fn(async () => "UNI-TREND,UTS0000X,<serial>,V0") });

describe("autoConnectAll defaults", () => {
  it("UTS_IP=auto uses network discovery, skipping the hosts UTS_INSTRUMENTS names", async () => {
    const a = (host: string) => ({ host, vxi11: true, vxi11Port: 1, raw: true, analyzer: true, idn: { manufacturer: "UNI-T", model: "UTS3036B", firmware: "V1" } });
    mockDiscover.mockResolvedValue({ instruments: [a("192.168.1.100"), a("192.168.1.101")], notes: [] });
    const conns = new Map<string, ReturnType<typeof conn>>();
    const registry = { declare: (n: string) => (conns.has(n) ? conns.get(n)! : (conns.set(n, conn()), conns.get(n)!)) };
    const ok = await autoConnectAll({ UTS_IP: "auto", UTS_INSTRUMENTS: "sa2=192.168.1.101" }, registry, vi.fn());
    expect(ok).toEqual({ default: true, sa2: true });
    expect([...mockDiscover.mock.calls[0][0].skipIdentify]).toEqual(["192.168.1.101"]);
    expect(conns.get("default")!.connect).toHaveBeenCalledWith("192.168.1.100", 5025, expect.anything());
  });

  it("a logger that throws never breaks the startup connections", async () => {
    const c = conn();
    const log = vi.fn(() => { throw new Error("stderr closed"); });
    expect(await autoConnectAll({ UTS_IP: "192.168.1.100", UTS_INSTRUMENTS: "oops" }, { declare: () => c }, log)).toEqual({ default: true });
    expect(log).toHaveBeenCalled();
  });
});
