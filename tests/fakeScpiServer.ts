import * as net from "node:net";

export interface FakeScpi {
  port: number;
  /** Every line (LF-terminated, LF stripped) received from any client, in order. */
  received: string[];
  /** Arrival time (ms since epoch) of each entry in `received`. */
  receivedAt: number[];
  /** Currently open server-side sockets. */
  sockets: Set<net.Socket>;
  close(): Promise<void>;
}

/**
 * In-process TCP server on 127.0.0.1 that splits input into LF-terminated lines and
 * hands each to `handler`, which may reply (in chunks, with delays) or stay silent
 * like the real instrument does for unsupported queries.
 */
export async function startFakeScpi(
  handler: (line: string, socket: net.Socket) => void
): Promise<FakeScpi> {
  const received: string[] = [];
  const receivedAt: number[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        received.push(line);
        receivedAt.push(Date.now());
        handler(line, socket);
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    received,
    receivedAt,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export const IDN = "UNI-TREND,UTS0000X,<serial>,V0.0.0";

/**
 * Handler answering *IDN? and (by default) *OPC?; `extra` handles everything else.
 * Pass `{ opc: false }` when a test wants to control the *OPC? reply itself.
 */
export function idnHandler(
  extra?: (line: string, socket: net.Socket) => void,
  options: { opc?: boolean } = {}
): (line: string, socket: net.Socket) => void {
  const answerOpc = options.opc ?? true;
  return (line, socket) => {
    if (line === "*IDN?") socket.write(IDN + "\r\n");
    else if (line === "*OPC?" && answerOpc) socket.write("1\r\n");
    else extra?.(line, socket);
  };
}
