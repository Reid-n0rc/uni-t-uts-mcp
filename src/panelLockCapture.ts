/**
 * Capture a screenshot over a dedicated VXI-11 link and classify the front-panel lock from it (issue #172).
 *
 * Sends exactly one query, `:DISPlay:DATA?`, in whatever picture format the analyzer is set to (BMP by default, PNG
 * after the `screenshot` tool): no setter, so it changes no setting. A VXI-11 link plus this query did not lock an
 * unlocked panel (docs/verified-hardware.md, "Front-panel lock"). It never throws: a failure is reported as "unknown"
 * with the reason, so a caller can tell "could not check" from "locked".
 */
import { parseBlock } from "./blocks.js";
import { detectPanelLockInImageFile, type PanelLockResult } from "./panelLock.js";
import { Vxi11Client, type Vxi11ConnectOptions } from "./vxi11/client.js";

const DATA_QUERY = ":DISPlay:DATA?";
const TRANSFER_TIMEOUT_MS = 60000;

export interface CaptureOptions extends Vxi11ConnectOptions {
  /** Time allowed for the screenshot transfer (default 60 s; a 1280x800 BMP is about 4 MB). */
  transferTimeoutMs?: number;
}

/** The screenshot as the instrument sent it (PNG or BMP bytes, block header removed). Throws on failure. */
export async function captureScreenshot(host: string, options: CaptureOptions = {}): Promise<Buffer> {
  const { transferTimeoutMs, ...connect } = options;
  const client = await Vxi11Client.connect(host, connect);
  try {
    await client.write(`${DATA_QUERY}\n`);
    // The instrument waits a multiple of the io_timeout for a reply, so send a fraction (see Vxi11ReadOptions).
    const reply = await client.read({ timeoutMs: transferTimeoutMs ?? TRANSFER_TIMEOUT_MS, ioTimeoutFraction: 0.2 });
    const parsed = parseBlock(Buffer.from(reply.data));
    if (parsed.status !== "ok") {
      throw new Error(`the reply to ${DATA_QUERY} is not a complete binary block (${parsed.status === "invalid" ? parsed.reason : "incomplete"})`);
    }
    return parsed.data;
  } finally {
    await client.close();
  }
}

/** Take a screenshot and report locked / unlocked / unknown. Never throws. */
export async function checkPanelLockOnInstrument(host: string, options: CaptureOptions = {}): Promise<PanelLockResult> {
  let image: Buffer;
  try {
    image = await captureScreenshot(host, options);
  } catch (err) {
    return { state: "unknown", padlockScore: 0, monitorScore: 0, reason: `could not take a screenshot over VXI-11: ${err instanceof Error ? err.message : String(err)}` };
  }
  return detectPanelLockInImageFile(image);
}
