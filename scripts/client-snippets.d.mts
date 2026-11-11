export interface ClientSnippet { label: string; lang: string; text: string }
export interface Client {
  id: string;
  name: string;
  where: string;
  docs: string;
  verified: string;
  link?: { label: string; href: string };
  steps: string[];
  snippets: ClientSnippet[];
}
export const PLACEHOLDER_HOST: string;
export const BEGIN: string;
export const END: string;
export const TARGETS: { file: string; render: (c: Client[]) => string }[];
export function buildClients(version: string): Client[];
export function renderReadmeTable(c: Client[]): string;
export function renderWiki(c: Client[]): string;
export function renderSiteSection(c: Client[]): string;
export function replaceRegion(text: string, body: string, file?: string): string;
export function sync(opts?: { root?: string; write?: boolean; version?: string }): string[];
export const PLUGIN_DIR: string;
export const MARKETPLACE: string;
export function pluginFiles(version: string): Record<string, string>;
