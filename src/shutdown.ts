/**
 * Clean teardown at process exit (issue #127): the MCP client ends the session by closing stdin or by
 * sending SIGINT/SIGTERM. Without a destroy_link the analyzer keeps the VXI-11 link, and the next process
 * can find a link that does not answer. So release the link first, then exit; a hung teardown cannot keep
 * the process alive longer than `graceMs`.
 */
export interface ShutdownProcess {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  stdin?: { on(event: "end" | "close", listener: () => void): unknown };
}

export function installShutdownHandlers(
  proc: ShutdownProcess,
  conn: { shutdown(): Promise<void> },
  exit: (code: number) => void,
  options: { graceMs?: number } = {}
): void {
  let started = false;
  const run = (): void => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => exit(0), options.graceMs ?? 3000);
    timer.unref?.();
    conn
      .shutdown()
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        exit(0);
      });
  };
  proc.on("SIGINT", run);
  proc.on("SIGTERM", run);
  proc.stdin?.on("end", run);
  proc.stdin?.on("close", run);
}
