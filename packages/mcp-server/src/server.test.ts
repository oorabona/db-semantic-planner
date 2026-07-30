/**
 * E06c: MCP Server Tests
 *
 * Tests for MCP server creation and configuration.
 */

import { schema as dbSchema, ref } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';

// Mock schema for testing - live schema() result shape
const mockSchema = dbSchema({
	users: {
		id: { type: 'integer', primaryKey: true },
		email: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		userId: ref('users'),
	},
});

describe('createMcpServer', () => {
	describe('basic creation', () => {
		it('should create an MCP server instance', () => {
			const server = createMcpServer({ schema: mockSchema });
			expect(server).toBeDefined();
		});

		it('should accept custom name and version', () => {
			const server = createMcpServer({
				schema: mockSchema,
				name: 'custom-server',
				version: '1.2.3',
			});
			expect(server).toBeDefined();
		});

		it('should use default name from package when not provided', () => {
			// Version defaults to package.json version (no longer hardcoded 0.0.1)
			const server = createMcpServer({ schema: mockSchema });
			expect(server).toBeDefined();
		});
	});

	describe('schema handling', () => {
		it('should accept schema with multiple tables', () => {
			const server = createMcpServer({ schema: mockSchema });
			expect(server).toBeDefined();
		});

		it('should accept schema with relations', () => {
			const server = createMcpServer({ schema: mockSchema });
			expect(server).toBeDefined();
		});

		it('should handle schema with no relations', () => {
			const schemaNoRelations = dbSchema({
				users: {
					id: { type: 'integer', primaryKey: true },
				},
			});
			const server = createMcpServer({ schema: schemaNoRelations });
			expect(server).toBeDefined();
		});

		it('should handle empty schema', () => {
			const emptySchema = dbSchema({});
			const server = createMcpServer({ schema: emptySchema });
			expect(server).toBeDefined();
		});
	});
});
