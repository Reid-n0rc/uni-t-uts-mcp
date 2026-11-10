export interface BuildSiteOptions {
  root?: string;
  outDir?: string;
  /** Tool name -> description, overriding the summaries taken from the docs. */
  descriptions?: Record<string, string>;
}
export interface BuildSiteResult {
  outDir: string;
  toolCount: number;
  groupCount: number;
}
export function buildSite(options?: BuildSiteOptions): BuildSiteResult;
