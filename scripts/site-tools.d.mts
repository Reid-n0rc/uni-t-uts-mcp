export interface SiteTool {
  name: string;
  summary: string;
}
export interface SiteGroup {
  name: string;
  tools: SiteTool[];
}
export function parseToolsReference(markdown: string): SiteGroup[];
export function renderToolGroups(groups: SiteGroup[]): string;
export function renderSite(template: string, groups: SiteGroup[]): string;
