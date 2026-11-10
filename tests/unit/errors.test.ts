import { describe, it, expect, vi, beforeEach } from "vitest";
import { drainErrorQueue } from "../../src/errors.js";

const mockConnection = vi.hoisted(() => ({
  query: vi.fn(async (_cmd: string, _timeout?: number): Promise<string> => '0,"No error"'),
}));
vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

beforeEach(() => vi.clearAllMocks());

describe("drainErrorQueue", () => {
  it("returns an empty list when there are no errors", async () => {
    expect(await drainErrorQueue()).toEqual([]);
    expect(mockConnection.query).toHaveBeenCalledWith(":SYSTem:ERRor?", expect.any(Number));
  });

  it("collects errors until the queue reports 0", async () => {
    mockConnection.query
      .mockResolvedValueOnce('-131,"Invalid suffix"')
      .mockResolvedValueOnce('-222,"Data out of range"')
      .mockResolvedValueOnce('0,"No error"');
    expect(await drainErrorQueue()).toEqual(['-131,"Invalid suffix"', '-222,"Data out of range"']);
  });

  it("stops after a maximum number of reads", async () => {
    mockConnection.query.mockResolvedValue('-100,"Command error"');
    const errors = await drainErrorQueue(3);
    expect(errors).toHaveLength(3);
    expect(mockConnection.query).toHaveBeenCalledTimes(3);
  });

  it("treats a timeout (queue unsupported) as no information, not a failure", async () => {
    mockConnection.query.mockRejectedValueOnce(new Error("Query timeout after 1000ms for command: :SYSTem:ERRor?"));
    expect(await drainErrorQueue()).toEqual([]);
  });
});
