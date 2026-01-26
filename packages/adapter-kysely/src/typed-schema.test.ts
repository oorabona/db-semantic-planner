/**
 * DX-012 Block 2: Typed Schema Generics Tests
 *
 * Type-level tests for ARCH-006 schema inference.
 * Tests that ORM types are properly inferred from schema definition.
 */

import type { OrmInstance } from '@dbsp/core';
import { createOrm, eq, ref, schema } from '@dbsp/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createCompileOnlyAdapter } from './compile-only-adapter.js';

// ============================================================================
// Test Schema Definition (ARCH-006 API)
// ============================================================================

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		content: 'string',
		authorId: ref('users'),
		published: 'boolean',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		text: 'string',
		postId: ref('posts'),
		authorId: ref('users'),
	},
});

// ============================================================================
// Type-Level Tests
// ============================================================================

describe('DX-012 Block 2: Typed Schema Generics (ARCH-006)', () => {
	describe('Typed createOrm({ schema })', () => {
		it('should infer types from schema definition', () => {
			// ARCH-006: Types are inferred from schema, not explicit DB generic
			const orm = createOrm({ schema: testSchema });

			// OrmInstance should be properly typed
			expectTypeOf(orm).toMatchTypeOf<OrmInstance>();
		});

		it('should compile without errors', () => {
			// Basic usage should work
			const orm = createOrm({ schema: testSchema });
			expect(orm.select).toBeDefined();
		});
	});

	describe('Typed select() method', () => {
		it('should allow selecting from defined tables', () => {
			const orm = createOrm({ schema: testSchema });
			const builder = orm.select('users');

			// Builder should be defined
			expect(builder).toBeDefined();
			expect(builder.dump).toBeDefined();
		});

		it('should provide autocomplete for table names', () => {
			const orm = createOrm({ schema: testSchema });

			// These should compile
			orm.select('users');
			orm.select('posts');
			orm.select('comments');

			// This would be a type error if uncommented:
			// orm.select('invalid'); // 'invalid' is not a valid table name
		});
	});

	describe('Typed insert() method', () => {
		it('should allow inserting into defined tables', () => {
			const orm = createOrm({ schema: testSchema });
			const builder = orm.insert('users');

			expect(builder).toBeDefined();
		});
	});

	describe('Typed update() method', () => {
		it('should allow updating defined tables', () => {
			const orm = createOrm({ schema: testSchema });
			const builder = orm.update('users');

			expect(builder).toBeDefined();
		});
	});

	describe('Typed delete() method', () => {
		it('should allow deleting from defined tables', () => {
			const orm = createOrm({ schema: testSchema });
			const builder = orm.delete('users');

			expect(builder).toBeDefined();
		});
	});

	describe('Filter type safety', () => {
		// Create compile-only adapter for SQL generation tests
		const adapter = createCompileOnlyAdapter();

		it('should accept filter helpers with schema columns', () => {
			const orm = createOrm({ schema: testSchema, adapter });

			// eq() should work with table columns
			const query = orm.select('users').where(eq('name', 'Alice'));
			expect(query.dump().sql).toContain('name');
		});

		it('should generate correct SQL for filters', () => {
			const orm = createOrm({ schema: testSchema, adapter });

			const dump = orm.select('users').where(eq('active', true)).dump();

			expect(dump.sql).toContain('active');
		});
	});
});
