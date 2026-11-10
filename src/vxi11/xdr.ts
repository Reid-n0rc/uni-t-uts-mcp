/**
 * Minimal XDR (RFC 4506) writer and reader for the types ONC RPC and VXI-11 need:
 * unsigned/signed 32-bit integers, booleans, fixed and variable-length opaque data and strings.
 *
 * The reader parses untrusted network input: every read is bounds-checked and every length is
 * capped, so malformed or truncated data raises an {@link XdrError} and never reads out of range.
 */

/** Default cap for one variable-length opaque/string (16 MiB). */
export const MAX_OPAQUE_BYTES = 16 * 1024 * 1024;

/** Malformed, truncated, oversized or unencodable XDR data. */
export class XdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XdrError";
  }
}

const padding = (n: number): number => (4 - (n % 4)) % 4;
const ZERO_PAD = Buffer.alloc(3);

export class XdrWriter {
  private readonly parts: Buffer[] = [];
  private size = 0;

  /** Number of bytes written so far. */
  get length(): number {
    return this.size;
  }

  private push(b: Buffer): void {
    this.parts.push(b);
    this.size += b.length;
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new XdrError(`unsigned 32-bit value out of range: ${value}`);
    }
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(value, 0);
    this.push(b);
    return this;
  }

  i32(value: number): this {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new XdrError(`signed 32-bit value out of range: ${value}`);
    }
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(value, 0);
    this.push(b);
    return this;
  }

  bool(value: boolean): this {
    return this.u32(value ? 1 : 0);
  }

  /** Fixed-length opaque: the bytes plus zero padding to a multiple of 4, no length prefix. */
  opaqueFixed(data: Uint8Array): this {
    this.push(Buffer.from(data));
    const pad = padding(data.length);
    if (pad) this.push(ZERO_PAD.subarray(0, pad));
    return this;
  }

  /** Variable-length opaque: u32 length, bytes, zero padding. */
  opaque(data: Uint8Array, maxLength: number = MAX_OPAQUE_BYTES): this {
    if (data.length > maxLength) {
      throw new XdrError(`opaque length ${data.length} exceeds the limit of ${maxLength}`);
    }
    this.u32(data.length);
    return this.opaqueFixed(data);
  }

  /** String encoded as Latin-1 bytes (XDR strings are ASCII); characters above U+00FF are rejected. */
  string(value: string, maxLength: number = MAX_OPAQUE_BYTES): this {
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) > 0xff) {
        throw new XdrError(`string contains a character that cannot be encoded: U+${value.charCodeAt(i).toString(16)}`);
      }
    }
    return this.opaque(Buffer.from(value, "latin1"), maxLength);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts, this.size);
  }
}

export class XdrReader {
  private readonly buf: Buffer;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Bytes not yet consumed. */
  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /** Current read offset. */
  get offset(): number {
    return this.pos;
  }

  private need(n: number, what: string): void {
    if (n > this.remaining) {
      throw new XdrError(`truncated XDR data: need ${n} byte(s) for ${what} at offset ${this.pos}, only ${this.remaining} left`);
    }
  }

  u32(): number {
    this.need(4, "u32");
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4, "i32");
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  /** Strict: only 0 and 1 are valid XDR booleans. */
  bool(): boolean {
    const v = this.u32();
    if (v !== 0 && v !== 1) throw new XdrError(`invalid XDR boolean value ${v}`);
    return v === 1;
  }

  /** Fixed-length opaque of `length` bytes (plus padding, which is skipped). Returns a copy. */
  opaqueFixed(length: number): Buffer {
    if (!Number.isInteger(length) || length < 0) throw new XdrError(`invalid opaque length ${length}`);
    const total = length + padding(length);
    this.need(total, `opaque[${length}]`);
    const out = Buffer.from(this.buf.subarray(this.pos, this.pos + length));
    this.pos += total;
    return out;
  }

  /** Variable-length opaque. A length above `maxLength` is rejected before anything is read. */
  opaque(maxLength: number = MAX_OPAQUE_BYTES): Buffer {
    const length = this.u32();
    if (length > maxLength) {
      throw new XdrError(`opaque length ${length} exceeds the limit of ${maxLength}`);
    }
    return this.opaqueFixed(length);
  }

  string(maxLength: number = MAX_OPAQUE_BYTES): string {
    return this.opaque(maxLength).toString("latin1");
  }

  /** Throws unless every byte has been consumed. */
  expectEnd(): void {
    if (this.remaining !== 0) throw new XdrError(`${this.remaining} unexpected trailing byte(s) in XDR data`);
  }
}
