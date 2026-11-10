export const TARGETS: { file: string; width: number; height: number }[];
export function findChrome(explicit?: string): string;
export function registeredToolCount(): Promise<number>;
export function renderHtml(template: string, toolCount: number, width: number, height: number): string;
export function buildOgImages(options?: { chrome?: string }): Promise<{ toolCount: number; files: string[] }>;
