export interface WikiIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  /** author_association from the GitHub API (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...) */
  authorAssociation?: string;
}
export interface WikiSources {
  toolsReference: string;
  verifiedHardware: string;
  version: string;
  wiki: Record<string, string>;
}
export type WikiPages = Record<string, string>;
export const REPO_URL: string;
export const GENERATED_PAGES: string[];
export function slugify(heading: string): string;
export function loadSources(root?: string): WikiSources;
export function buildWikiPages(sources: WikiSources, options?: { issues?: WikiIssue[] | null; warnings?: string[] }): WikiPages;
export function parseIssues(json: unknown): WikiIssue[];
export function fetchIssues(options?: { repo?: string; token?: string }): WikiIssue[] | null;
export function findPrivateData(text: string): string[];
export function checkPages(pages: WikiPages, options?: { repoRoot?: string }): string[];
export function writePages(dir: string, pages: WikiPages): void;
export const TRUSTED_ASSOCIATIONS: string[];
export const MAX_TITLE_LENGTH: number;
export const MAX_LABEL_LENGTH: number;
export function isTrustedIssue(issue: WikiIssue): boolean;
export function sanitizeIssueText(value: unknown, options?: { max?: number; onRedact?: () => void }): string;
export function redactPrivateData(text: string): string;
