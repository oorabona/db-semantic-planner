/**
 * MCP Server for db-semantic-planner
 *
 * Exposes schema and query planning capabilities to AI tools via MCP protocol.
 */

import { createRequire } from 'node:module';
import type { ResolvedSchema } from '@dbsp/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const _require = createRequire(import.meta.url);
const _pkg = _require('../package.json') as { version: string };

/**
 * Options for creating the MCP server.
 */
export interface McpServerOptions {
	/**
	 * The loaded schema to expose via MCP.
	 */
	schema: ResolvedSchema;

	/**
	 * Server name for MCP identification.
	 * @default '@dbsp/mcp-server'
	 */
	name?: string;

	/**
	 * Server version.
	 * @default — package version (from package.json)
	 */
	version?: string;
}

/**
 * Create the db-semantic-planner MCP server instance.
 *
 * This sets up the server with tools for schema introspection and query planning,
 * and resources for accessing schema definitions and documentation.
 *
 * @param options - Server configuration options
 * @returns Configured McpServer instance (not yet connected)
 */
export function createMcpServer(options: McpServerOptions): McpServer {
	const { schema, name = '@dbsp/mcp-server', version = _pkg.version } = options;

	const server = new McpServer({
		name,
		version,
	});

	// Schema is available in closure for future tool/resource registrations
	void schema;

	// TODO: MCP-003 - Register schema_list_tables tool
	// TODO: MCP-004 - Register schema_get_relations tool
	// TODO: MCP-005 - Register query_plan tool
	// TODO: MCP-006 - Register intent_validate tool

	// TODO: MCP-007 - Register schema://manifest resource
	// TODO: MCP-007a - Register schema://intent-schema resource
	// TODO: MCP-007b - Register schema://cookbook resource

	return server;
}

/**
 * Start the MCP server with stdio transport.
 *
 * This is the main entry point for running the server as a spawned process.
 * Uses stdin/stdout for MCP protocol communication.
 *
 * @param options - Server configuration options
 */
export async function startMcpServer(options: McpServerOptions): Promise<void> {
	const server = createMcpServer(options);

	// Use stdio transport for communication with parent process (Claude Code, etc.)
	const transport = new StdioServerTransport();

	console.error('[dbsp-mcp] Starting server with stdio transport...');
	await server.connect(transport);
	console.error('[dbsp-mcp] Server connected and ready');
}
