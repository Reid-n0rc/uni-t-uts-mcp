import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { decodeImage } from "../../src/panelLock.js";
import { captureScreenshot, checkPanelLockOnInstrument } from "../../src/panelLockCapture.js";
import { startFakeVxi11Instrument, type FakeVxi11Instrument } from "../fakeVxi11Instrument.js";
import { bmp, png } from "../panelLockImages.js";

// A full 1280x800 screen whose status bar is the locked/unlocked fixture crop (see panelLock.test.ts).
const ORIGIN = { x: 740, y: 745 };
function screen(name: string): Buffer {
  const crop = decodeImage(readFileSync(new URL(`../fixtures/panel-lock/${name}`, import.meta.url)));
  const v = (x: number, y: number): number => {
    const cx = x - ORIGIN.x;
    const cy = y - ORIGIN.y;
    return cx >= 0 && cy >= 0 && cx < crop.width && cy < crop.height ? crop.data[cy * crop.width + cx]! : 0;
  };
  return png(1280, 800, 0, 1280, (y) => Buffer.from(Array.from({ length: 1280 }, (_, x) => v(x, y))));
}
const block = (data: Buffer): Buffer => Buffer.concat([Buffer.from(`#${String(data.length).length}${data.length}`), data, Buffer.from("\n")]);

let fake: FakeVxi11Instrument | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
const start = async (reply: (c: string) => Buffer | string | undefined) => {
  fake = await startFakeVxi11Instrument({ scpi: (c) => reply(c) });
  return { portmapperPort: fake.port };
};

describe("captureScreenshot / checkPanelLockOnInstrument", () => {
  it("reports locked from a PNG screenshot and sends nothing but :DISPlay:DATA?", async () => {
    const opts = await start((c) => (c === ":DISPlay:DATA?" ? block(screen("locked-statusbar.png")) : undefined));
    const r = await checkPanelLockOnInstrument("127.0.0.1", opts);
    expect(r.state).toBe("locked");
    expect(fake!.received).toEqual([":DISPlay:DATA?"]);
    expect(fake!.destroyedLinks).toBe(1);
  });

  it("reports unlocked, also from the default BMP format", async () => {
    const opts = await start((c) => (c === ":DISPlay:DATA?" ? block(screen("unlocked-statusbar.png")) : undefined));
    expect((await checkPanelLockOnInstrument("127.0.0.1", opts)).state).toBe("unlocked");
    const img = decodeImage(screen("unlocked-statusbar.png"));
    const b = bmp(1280, 800, 32, (x, y) => {
      const v = img.data[y * 1280 + x]!;
      return [v, v, v];
    });
    fake!.setScpiHandler((c) => (c === ":DISPlay:DATA?" ? block(b) : undefined));
    expect((await checkPanelLockOnInstrument("127.0.0.1", opts)).state).toBe("unlocked");
  });

  it("returns the image bytes without the block header", async () => {
    const img = screen("locked-statusbar.png");
    const opts = await start(() => block(img));
    expect((await captureScreenshot("127.0.0.1", opts)).equals(img)).toBe(true);
  });

  it("is unknown (not a throw) when the reply is not a block or not an image", async () => {
    const opts = await start(() => "1.0e9");
    const r = await checkPanelLockOnInstrument("127.0.0.1", opts);
    expect(r.state).toBe("unknown");
    expect(r.reason).toMatch(/screenshot/i);
    fake!.setScpiHandler(() => block(Buffer.from("not an image")));
    expect((await checkPanelLockOnInstrument("127.0.0.1", opts)).state).toBe("unknown");
  });

  it("is unknown when the instrument cannot be reached", async () => {
    const r = await checkPanelLockOnInstrument("127.0.0.1", { portmapperPort: 9, connectTimeoutMs: 500 });
    expect(r.state).toBe("unknown");
    expect(r.reason).toMatch(/connect|VXI-11/i);
  });
});
