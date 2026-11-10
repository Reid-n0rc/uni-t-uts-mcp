import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyCommands, InstrumentError } from "../../src/instrument.js";

const mockConnection = vi.hoisted(() => ({
  sendCommand: vi.fn(async (_cmd: string) => {}),
  query: vi.fn(async (_cmd: string, _timeout?: number): Promise<string> => '0,"No error"'),
}));
vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

beforeEach(() => vi.clearAllMocks());

describe("applyCommands", () => {
  it("clears the status/error queue first, sends the commands in order, then checks errors", async () => {
    await applyCommands([":A 1", ":B 2"]);
    expect(mockConnection.sendCommand.mock.calls.map((c) => c[0])).toEqual(["*CLS", ":A 1", ":B 2"]);
    expect(mockConnection.query).toHaveBeenCalledWith(":SYSTem:ERRor?", expect.any(Number));
  });

  it("throws InstrumentError carrying the instrument's errors", async () => {
    mockConnection.query
      .mockResolvedValueOnce('-131,"Invalid suffix"')
      .mockResolvedValueOnce('0,"No error"');
    const err = await applyCommands([":A 1"]).catch((e) => e);
    expect(err).toBeInstanceOf(InstrumentError);
    expect(err.errors).toEqual(['-131,"Invalid suffix"']);
    expect(err.message).toContain("Invalid suffix");
  });

  it("does not check errors if sending fails, and propagates the failure", async () => {
    mockConnection.sendCommand.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Connection closed"));
    await expect(applyCommands([":A 1"])).rejects.toThrow("Connection closed");
    expect(mockConnection.query).not.toHaveBeenCalled();
  });
});
