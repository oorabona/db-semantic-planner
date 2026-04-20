/**
 * @dbsp/mcp-server — public library API
 *
 * Import from '@dbsp/mcp-server' (not the CLI entry) to use these symbols
 * programmatically without launching a subprocess.
 */

export {
	formatLogPath,
	sanitizeErrorMessage,
	sanitizePath,
} from './format-error.js';
export {
	hasParentSegment,
	isPathContained,
	realpathBestEffort,
	validateAllowedRoots,
} from './path-validator.js';
export type {
	SchemaLoaderOptions,
	SchemaLoaderResult,
} from './schema-loader.js';
export {
	loadSchema,
	SchemaLoadError,
	validatePath,
	validateResolvedSchema,
} from './schema-loader.js';
export type { McpServerOptions } from './server.js';
export { createMcpServer, startMcpServer } from './server.js';
