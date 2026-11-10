export function countRegisteredTools(): Promise<number>;
export function smokeTest(opts: {
  command: string;
  args?: string[];
  expectedTools: number;
  expectedName?: string;
  timeoutMs?: number;
}): Promise<{ serverName: string; toolCount: number }>;
