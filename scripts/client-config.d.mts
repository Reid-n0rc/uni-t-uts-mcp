export const NPM_PUBLISHED: boolean;
export const REPO: string;
export const IMAGE: string;
export type Source = "local" | "tarball" | "github" | "docker" | "npm";
export interface ConfigOptions {
  host?: string;
  source?: Source;
  version: string;
  platform?: string;
  entry?: string;
}
export interface ClientConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
export function tarballUrl(version: string): string;
export function githubSpec(version: string): string;
export function dockerImage(version: string): string;
export function validateHost(host: string): string | null;
export function buildServerConfig(opts: ConfigOptions): ClientConfig;
export function claudeCodeCommand(opts: ConfigOptions): string;
export function jsonConfig(opts: ConfigOptions): string;
export function render(opts: ConfigOptions): string;
export function main(argv: string[], io?: { out: (s: string) => void; err: (s: string) => void; platform?: string; entry?: string; version?: string }): number;
