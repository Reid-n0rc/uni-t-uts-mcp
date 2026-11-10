export const MCPB_CLI_VERSION: string;
export function checkBundleFiles(paths: string[]): string[];
export function buildBundle(opts?: { outDir?: string }): Promise<{ file: string }>;
export function unpackBundle(file: string, dir: string): Promise<void>;
export function validateManifest(manifestPath: string): Promise<void>;
