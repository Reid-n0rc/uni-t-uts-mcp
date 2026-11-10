import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connection } from "../connection.js";
import { applyCommands, queryParsed } from "../instrument.js";
import { errorResult, defineTool } from "./util.js";

// Commands: docs/programming-guide.md section 8 (ambiguity 14); behavior verified on the UTS3036B
// (docs/verified-hardware.md, VXI-11 section). :DISPlay:DATA? returns the screen as a `#` block in the
// format selected with :SYSTem:PICture:FORMat; with PNG selected it is a real PNG (about 90 KB, ~3 s).
// Over raw TCP the instrument stops after exactly 144,800 bytes (issue #42), so the tool needs a
// transport whose replies arrive complete (capability `completeLargeBlocks`, VXI-11).

const FORMAT_QUERY = ":SYSTem:PICture:FORMat?";
const DATA_QUERY = ":DISPlay:DATA?";
const TRANSFER_TIMEOUT_MS = 30000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PictureFormat = "BMP" | "PNG";

function parseFormat(reply: string): PictureFormat {
  const text = reply.trim().toUpperCase();
  if (text === "BMP" || text === "PNG") return text;
  throw new Error(`Unexpected picture format ${JSON.stringify(reply)}`);
}

const RAW_REFUSAL =
  "Cannot take a screenshot over raw TCP: the analyzer stops sending after exactly 144,800 bytes of a large reply " +
  "(issue #42), so the image (about 90 KB as PNG) would never complete. " +
  "Use the VXI-11 transport, where the full screenshot arrives: reconnect with transport 'vxi11' (or 'auto' when the " +
  "analyzer registers VXI-11), or set UTS_TRANSPORT=vxi11 (or auto) for the server.";

export function registerScreenshotTools(server: McpServer): void {
  defineTool(
    server,
    "screenshot",
    "Capture the analyzer's screen and return it as a PNG image. Needs the VXI-11 transport (over raw TCP the instrument " +
      "truncates large replies at 144,800 bytes, so the tool refuses with instructions). Temporarily selects PNG as the picture " +
      "format (:SYSTem:PICture:FORMat) and always restores the original format. Takes about 3 seconds.",
    {},
    { readOnlyHint: true },
    async () => {
      if (!connection.capabilities.completeLargeBlocks) {
        return errorResult(RAW_REFUSAL);
      }
      try {
        const original = await queryParsed(FORMAT_QUERY, parseFormat);
        let image: Buffer | undefined;
        let failure: unknown;
        let restoreProblem: string | undefined;
        try {
          if (original !== "PNG") await applyCommands([":SYSTem:PICture:FORMat PNG"]);
          const data = await connection.queryBinary(DATA_QUERY, TRANSFER_TIMEOUT_MS).catch((err) => {
            throw new Error(`${err instanceof Error ? err.message : String(err)} (command: ${DATA_QUERY})`);
          });
          if (data.length === 0) {
            throw new Error(`The instrument returned an empty reply to ${DATA_QUERY}.`);
          }
          if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
            throw new Error(
              `The reply to ${DATA_QUERY} (${data.length} bytes) is not a PNG image although the picture format was set to PNG.`
            );
          }
          image = data;
        } catch (err) {
          failure = err;
        } finally {
          // Always put the picture format back (also after a failure: the set may have been applied).
          if (original !== "PNG") {
            try {
              await applyCommands([`:SYSTem:PICture:FORMat ${original}`]);
            } catch (err) {
              restoreProblem =
                `the picture format could not be restored to ${original}: ${err instanceof Error ? err.message : String(err)}. ` +
                `Check it with scpi_query ${FORMAT_QUERY} and set it back.`;
            }
          }
        }
        if (failure !== undefined || !image) {
          const message = failure instanceof Error ? failure.message : String(failure);
          return errorResult(restoreProblem ? `${message} Also, ${restoreProblem}` : message);
        }
        const picture = { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" };
        if (restoreProblem) {
          // The capture worked but the instrument was left in PNG mode: an error, with the image kept.
          return {
            content: [picture, { type: "text" as const, text: `Error: The screenshot was captured (${image.length} bytes) but ${restoreProblem}` }],
            isError: true as const,
          };
        }
        return { content: [picture, { type: "text" as const, text: `Screenshot: PNG, ${image.length} bytes.` }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
