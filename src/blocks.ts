/**
 * IEEE 488.2 definite-length arbitrary block parser: `#<N><len><data>` where
 * N is a single digit (1-9) giving the number of digits in `len`.
 *
 * Both styles seen in the UNI-T manuals parse here (e.g. `#3123...` and
 * `#9` followed by a nine-digit length). Indefinite-length blocks (`#0`) are
 * not supported. See docs/programming-guide.md, section 3.
 */

export type BlockResult =
  | { status: "ok"; data: Buffer; consumed: number }
  /** More bytes are needed; `needed` (total from offset) is known once the header is complete. */
  | { status: "incomplete"; needed?: number }
  | { status: "invalid"; reason: string };

export interface BlockOptions {
  /** Largest payload length accepted (default 256 MiB). */
  maxLength?: number;
}

const HASH = 0x23;
const NEWLINE = 0x0a;
const DEFAULT_MAX_LENGTH = 256 * 1024 * 1024;

export function parseBlock(buf: Buffer, offset = 0, options: BlockOptions = {}): BlockResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;

  if (buf.length <= offset) return { status: "incomplete" };
  if (buf[offset] !== HASH) {
    return { status: "invalid", reason: "block does not start with '#'" };
  }
  if (buf.length < offset + 2) return { status: "incomplete" };

  const digitCount = buf[offset + 1] - 0x30;
  if (digitCount === 0) {
    return { status: "invalid", reason: "indefinite-length blocks (#0) are not supported" };
  }
  if (!(digitCount >= 1 && digitCount <= 9)) {
    return { status: "invalid", reason: "invalid length-digit count after '#'" };
  }

  const headerLength = 2 + digitCount;
  if (buf.length < offset + headerLength) return { status: "incomplete" };

  const lengthText = buf.toString("ascii", offset + 2, offset + headerLength);
  if (!/^[0-9]+$/.test(lengthText)) {
    return { status: "invalid", reason: "block length is not numeric" };
  }
  const length = parseInt(lengthText, 10);
  if (length > maxLength) {
    return { status: "invalid", reason: `block length ${length} exceeds limit ${maxLength}` };
  }

  const end = offset + headerLength + length;
  if (buf.length < end) {
    return { status: "incomplete", needed: headerLength + length };
  }

  const data = Buffer.from(buf.subarray(offset + headerLength, end));
  const trailingNewline = buf.length > end && buf[end] === NEWLINE ? 1 : 0;
  return { status: "ok", data, consumed: headerLength + length + trailingNewline };
}
