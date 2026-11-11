import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyCommands, setFirstSetterPending, InstrumentError, queryBool, queryNumber, readBack, ReplyError } from "../../src/instrument.js";

const mockConnection = vi.hoisted(() => ({
  sendCommand: vi.fn(async (_cmd: string) => {}),
  query: vi.fn(async (_cmd: string, _timeout?: number): Promise<string> => '0,"No error"'),
  msSinceQueryTimeout: vi.fn((): number => Infinity),
}));
vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

beforeEach(() => {
  vi.clearAllMocks();
  mockConnection.msSinceQueryTimeout.mockReturnValue(Infinity);
  // Only the first setter of a process has the stale-queue handling; the other tests are about later ones.
  setFirstSetterPending(false);
});

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

  describe("stale -113 errors after an unsupported query (the instrument posts them ~4 s later)", () => {
    const UH = '-113,"Undefined header"';

    it("ignores -113 shortly after a query timeout", async () => {
      mockConnection.msSinceQueryTimeout.mockReturnValue(1500);
      mockConnection.query.mockResolvedValueOnce(UH).mockResolvedValueOnce('0,"No error"');
      await expect(applyCommands([":A 1"])).resolves.toBeUndefined();
    });

    it("still reports -113 when no query timed out recently", async () => {
      for (const since of [Infinity, 60000]) {
        mockConnection.msSinceQueryTimeout.mockReturnValue(since);
        mockConnection.query.mockResolvedValueOnce(UH).mockResolvedValueOnce('0,"No error"');
        await expect(applyCommands([":A 1"])).rejects.toBeInstanceOf(InstrumentError);
      }
    });

    it("still reports other errors right after a timeout, listing only those", async () => {
      mockConnection.msSinceQueryTimeout.mockReturnValue(1000);
      mockConnection.query
        .mockResolvedValueOnce(UH)
        .mockResolvedValueOnce('-131,"Invalid suffix"')
        .mockResolvedValueOnce('0,"No error"');
      const err = await applyCommands([":A 1"]).catch((e) => e);
      expect(err).toBeInstanceOf(InstrumentError);
      expect(err.errors).toEqual(['-131,"Invalid suffix"']);
    });
  });
});

describe("first setter of a process: stale errors from a previous process (#133)", () => {
  const UH = '-113,"Undefined header"';
  beforeEach(() => setFirstSetterPending(true));

  it("clears the queue and re-checks it before the first setter", async () => {
    mockConnection.query.mockResolvedValueOnce(UH).mockResolvedValueOnce('0,"No error"').mockResolvedValue('0,"No error"');
    await expect(applyCommands([":A 1"])).resolves.toBeUndefined();
    const sent = mockConnection.sendCommand.mock.calls.map((c) => c[0]);
    // *CLS, stale -113 found, *CLS again, queue clean, then the setter.
    expect(sent).toEqual(["*CLS", "*CLS", ":A 1"]);
  });

  it("ignores a -113 that arrives after the first setter (posted ~4 s after the previous process's unanswered query)", async () => {
    mockConnection.query
      .mockResolvedValueOnce('0,"No error"') // queue clean before the setter
      .mockResolvedValueOnce(UH) // stale one lands while the setter ran
      .mockResolvedValueOnce('0,"No error"');
    await expect(applyCommands([":A 1"])).resolves.toBeUndefined();
  });

  it("still reports other errors on the first setter", async () => {
    mockConnection.query
      .mockResolvedValueOnce('0,"No error"')
      .mockResolvedValueOnce('-131,"Invalid suffix"')
      .mockResolvedValueOnce('0,"No error"');
    await expect(applyCommands([":A 1"])).rejects.toBeInstanceOf(InstrumentError);
  });

  it("only the first call gets this handling; a later -113 is reported", async () => {
    await applyCommands([":A 1"]);
    mockConnection.query.mockResolvedValueOnce(UH).mockResolvedValueOnce('0,"No error"');
    await expect(applyCommands([":B 1"])).rejects.toBeInstanceOf(InstrumentError);
  });
});

describe("error messages", () => {
  it("names the commands that were sent in an InstrumentError", async () => {
    mockConnection.query.mockResolvedValueOnce('-131,"Invalid suffix"').mockResolvedValueOnce('0,"No error"');
    const err = await applyCommands([":A 1", ":B 2"]).catch((e) => e);
    expect(err.message).toContain(":A 1; :B 2");
  });

  it("says which commands may already be applied when a later send fails", async () => {
    mockConnection.sendCommand
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Write failed: EPIPE"));
    const err = await applyCommands([":A 1", ":B 2"]).catch((e) => e);
    expect(err.message).toContain("Write failed: EPIPE");
    expect(err.message).toMatch(/may already be applied: :A 1/);
    // The command in flight when the connection failed may also have been executed (live finding, #63).
    expect(err.message).toMatch(/:B 2.*may (also )?have taken effect/);
  });

  it("names the command in flight when the very first command fails mid-send (it may have taken effect)", async () => {
    mockConnection.sendCommand
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Connection to the spectrum analyzer was lost"));
    const err = await applyCommands([":A 1"]).catch((e) => e);
    expect(err.message).toMatch(/:A 1.*may (also )?have taken effect/);
  });

  it("does not blame the settings when *CLS itself fails", async () => {
    mockConnection.sendCommand.mockRejectedValueOnce(new Error("Connection to the spectrum analyzer was lost"));
    const err = await applyCommands([":A 1"]).catch((e) => e);
    expect(err.message).toBe("Connection to the spectrum analyzer was lost");
  });

  it("does not claim anything was applied when nothing was sent", async () => {
    mockConnection.sendCommand.mockRejectedValueOnce(new Error("Not connected"));
    const err = await applyCommands([":A 1"]).catch((e) => e);
    expect(err.message).toBe("Not connected");
  });

  it("says the commands may be applied when the error queue cannot be read", async () => {
    mockConnection.query.mockRejectedValueOnce(new Error("Connection closed"));
    const err = await applyCommands([":A 1"]).catch((e) => e);
    expect(err.message).toMatch(/Connection closed.*may already be applied: :A 1/);
  });
});

describe("strict query helpers", () => {
  it("queryNumber/queryBool name the command and quote the raw reply on a malformed reply", async () => {
    mockConnection.query.mockResolvedValueOnce("abc");
    const err = await queryNumber(":FREQuency:CENTer?").catch((e) => e);
    expect(err).toBeInstanceOf(ReplyError);
    expect(err.message).toContain(":FREQuency:CENTer?");
    expect(err.message).toContain('"abc"');
    mockConnection.query.mockResolvedValueOnce("");
    await expect(queryBool(":X:AUTO?")).rejects.toThrow(/:X:AUTO\?/);
  });

  it("readBack wraps failures so they do not look like a failure to set", async () => {
    await expect(readBack(async () => { throw new Error("Query timeout for command: :A?"); })).rejects.toThrow(
      /reading them back failed: Query timeout for command: :A\?.*already be applied/
    );
  });
});
