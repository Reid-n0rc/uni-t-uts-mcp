export interface BuildSiteOptions {
  root?: string;
  outDir?: string;
}
export interface BuildSiteResult {
  outDir: string;
  toolCount: number;
  groupCount: number;
}
export function buildSite(options?: BuildSiteOptions): BuildSiteResult;
