export interface Entry {
  cmd: string;
  reply?: string | null;
}
export interface Difference {
  index: number;
  cmd: string;
  expected: string;
  actual: string;
  known: string | null;
}
export interface KnownDivergence {
  cmd: string;
  actual: string;
  note: string;
}
export interface Client {
  query(cmd: string): Promise<string | null>;
  send(cmd: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  close?(): void;
}
export function redact(text: string): string;
export function formatTranscript(entries: Entry[]): string;
export function parseTranscript(text: string): Entry[];
export function diffTranscripts(expected: Entry[], actual: Entry[], known?: KnownDivergence[]): { identical: boolean; differences: Difference[]; unexplained: number };
export const KNOWN_DIVERGENCES: KnownDivergence[];
export const RESTORE_PLAN: Array<{ get: string; set: string }>;
export const EXCHANGE: Array<{ cmd?: string; wait?: number }>;
export function refuseReason(env: Record<string, string | undefined>): string | null;
export function runExchange(client: Client, options?: { steps?: Array<{ cmd?: string; wait?: number }>; plan?: Array<{ get: string; set: string }> }): Promise<{ entries: Entry[]; restoreProblems: string[] }>;
export function connectRaw(host: string, port: number, options?: { replyTimeoutMs?: number }): Promise<Client & { close(): void }>;
