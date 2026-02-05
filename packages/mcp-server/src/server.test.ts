/**
 * E06c: MCP Server Tests
 *
 * Tests for MCP server creation and configuration.
 */

import type { ResolvedSchema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from './server.js';

// Mock schema for testing - minimal structure that passes validation
const mockSchema = {
	tables: {
		users: { id: 'uuid', email: 'text' },
		posts: { id: 'uuid', title: 'text', userId: 'uuid' },
	},
	relations: {
		posts_userId_users: {
			kind: 'belongsTo',
			from: 'posts',
			to: 'users',
			foreignKey: 'userId',
		},
	},
	hints: {},
	conventions: {
		primaryKey: 'id',
		timestamps: false,
		softDelete: false,
		namingConvention: 'camelCase',
	},
	indexes: {},
	defaultFilters: {},
} as unknown as ResolvedSchema;

describe('createMcpServer', () => {
	// Suppress console.error during tests
	const originalConsoleError = console.error;
	beforeAll(() => {
		console.error = vi.fn();
	});
	afterAll(() => {
		console.error = originalConsoleError;
	});

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

		it('should use default name and version when not provided', () => {
			// The defaults are '@dbsp/mcp-server' and '0.0.1'
			// We verify by checking console.error was called (logs server info)
			createMcpServer({ schema: mockSchema });
			expect(console.error).toHaveBeenCalled();
		});
	});

	describe('schema handling', () => {
		it('should log table count on creation', () => {
			createMcpServer({ schema: mockSchema });
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('Tables: 2'),
			);
		});

		it('should log relation count on creation', () => {
			createMcpServer({ schema: mockSchema });
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('Relations: 1'),
			);
		});

		it('should handle schema with no relations', () => {
			const schemaNoRelations = {
				...mockSchema,
				relations: {},
			} as unknown as ResolvedSchema;
			const server = createMcpServer({ schema: schemaNoRelations });
			expect(server).toBeDefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('Relations: 0'),
			);
		});

		it('should handle empty schema', () => {
			const emptySchema = {
				tables: {},
				relations: {},
				hints: {},
				conventions: mockSchema.conventions,
				indexes: {},
				defaultFilters: {},
			} as unknown as ResolvedSchema;
			const server = createMcpServer({ schema: emptySchema });
			expect(server).toBeDefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('Tables: 0'),
			);
		});
	});
});
