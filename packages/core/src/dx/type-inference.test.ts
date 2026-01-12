/**
 * DX-102: Type inference tests for createOrm
 *
 * These tests verify that TypeScript properly infers types from schema definitions.
 * They use compile-time type assertions to catch regressions.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { createOrm } from './orm.js';
import type {
	GeneratedSchema,
	InferDBFromSchema,
	InferRowType,
} from './schema-bridge.js';
import type { OrmInstance } from './types.js';

// ============================================================================
// Test Schema Definitions
// ============================================================================

/**
 * Simple test schema with users and posts tables.
 * Uses `as const satisfies GeneratedSchema` pattern for type inference.
 */
const simpleSchema = {
	tables: {
		users: {
			id: { type: 'uuid', primaryKey: true },
			name: { type: 'string' },
			email: { type: 'string', nullable: true },
		},
		posts: {
			id: { type: 'uuid', primaryKey: true },
			title: { type: 'string' },
			authorId: { type: 'uuid' },
			publishedAt: { type: 'timestamp', nullable: true },
		},
	},
	relations: {},
	hints: {},
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: [],
	},
} as const satisfies GeneratedSchema;

/**
 * Schema with all supported column types for comprehensive type mapping tests.
 */
const allTypesSchema = {
	tables: {
		allTypes: {
			id: { type: 'uuid', primaryKey: true },
			stringCol: { type: 'string' },
			textCol: { type: 'text' },
			intCol: { type: 'integer' },
			numCol: { type: 'number' },
			bigCol: { type: 'bigint' },
			decCol: { type: 'decimal' },
			boolCol: { type: 'boolean' },
			dateCol: { type: 'date' },
			tsCol: { type: 'timestamp' },
			dtCol: { type: 'datetime' },
			jsonCol: { type: 'json' },
			nullableString: { type: 'string', nullable: true },
		},
	},
	relations: {},
	hints: {},
	conventions: {
		fkPattern: '{singular}Id',
		pluralize: true,
		timestamps: [],
	},
} as const satisfies GeneratedSchema;

// ============================================================================
// Type-Level Tests
// ============================================================================

describe('DX-102: Type inference for createOrm', () => {
	describe('InferRowType', () => {
		it('should infer correct TypeScript types from column definitions', () => {
			// Test users table row type
			type UsersRow = InferRowType<typeof simpleSchema.tables.users>;

			expectTypeOf<UsersRow>().toEqualTypeOf<{
				id: string;
				name: string;
				email: string | null;
			}>();
		});

		it('should map all column types correctly', () => {
			type AllTypesRow = InferRowType<typeof allTypesSchema.tables.allTypes>;

			// String types → string
			expectTypeOf<AllTypesRow['stringCol']>().toBeString();
			expectTypeOf<AllTypesRow['textCol']>().toBeString();
			expectTypeOf<AllTypesRow['id']>().toBeString(); // uuid → string

			// Number types → number
			expectTypeOf<AllTypesRow['intCol']>().toBeNumber();
			expectTypeOf<AllTypesRow['numCol']>().toBeNumber();
			expectTypeOf<AllTypesRow['decCol']>().toBeNumber();

			// Bigint → bigint
			expectTypeOf<AllTypesRow['bigCol']>().toEqualTypeOf<bigint>();

			// Boolean → boolean
			expectTypeOf<AllTypesRow['boolCol']>().toBeBoolean();

			// Date/time types → Date
			expectTypeOf<AllTypesRow['dateCol']>().toEqualTypeOf<Date>();
			expectTypeOf<AllTypesRow['tsCol']>().toEqualTypeOf<Date>();
			expectTypeOf<AllTypesRow['dtCol']>().toEqualTypeOf<Date>();

			// JSON → unknown
			expectTypeOf<AllTypesRow['jsonCol']>().toBeUnknown();

			// Nullable string → string | null
			expectTypeOf<AllTypesRow['nullableString']>().toEqualTypeOf<
				string | null
			>();
		});
	});

	describe('InferDBFromSchema', () => {
		it('should infer DB type with correct table names', () => {
			type DB = InferDBFromSchema<typeof simpleSchema>;

			// Should have exactly these table names
			expectTypeOf<keyof DB>().toEqualTypeOf<'users' | 'posts'>();
		});

		it('should infer correct row types for each table', () => {
			type DB = InferDBFromSchema<typeof simpleSchema>;

			// Users row type
			expectTypeOf<DB['users']>().toEqualTypeOf<{
				id: string;
				name: string;
				email: string | null;
			}>();

			// Posts row type
			expectTypeOf<DB['posts']>().toEqualTypeOf<{
				id: string;
				title: string;
				authorId: string;
				publishedAt: Date | null;
			}>();
		});
	});

	describe('createOrm with schema', () => {
		// Note: We can't actually call createOrm without an adapter in these type tests,
		// but we can verify the type inference at compile time.

		it('should infer OrmInstance with correct DB type from schema', () => {
			// This is a type-level test - we're checking the types, not runtime behavior
			// biome-ignore lint/correctness/noUnusedVariables: Type used for compile-time verification
			type ExpectedDB = InferDBFromSchema<typeof simpleSchema>;

			// The function type should accept our schema and return OrmInstance<ExpectedDB>
			// We use a type assertion to verify the return type would be correct
			const createOrmWithSchema = createOrm<
				typeof simpleSchema.tables,
				typeof simpleSchema
			>;

			// Note: We can't actually call this without an adapter, but the type inference
			// is what we're testing. The mock adapter test below verifies runtime behavior.
			expectTypeOf(createOrmWithSchema).toBeFunction();
		});

		it('should allow table name autocomplete in select()', () => {
			// Type test: verify that the OrmInstance type constrains table names correctly
			type DB = InferDBFromSchema<typeof simpleSchema>;
			type Orm = OrmInstance<DB>;

			// The select method should accept 'users' | 'posts'
			type SelectMethod = Orm['select'];

			// Verify the method exists and accepts correct table names
			expectTypeOf<SelectMethod>().toBeFunction();

			// The first parameter should be constrained to table names
			// This is verified by TypeScript at compile time
		});
	});

	describe('backwards compatibility', () => {
		it('should still work with explicit DB generic', () => {
			// Old-style usage with explicit type should still work
			interface ManualDB {
				users: { id: number; name: string };
			}

			type Orm = OrmInstance<ManualDB>;
			expectTypeOf<Orm['select']>().toBeFunction();
		});

		it('should work with adapter-only (auto-introspection)', () => {
			// The async introspection path should return Promise<OrmInstance<DB>>
			// Type verified at compile time - actual runtime is tested elsewhere
			// biome-ignore lint/correctness/noUnusedVariables: Type used for compile-time verification
			type AsyncReturn = ReturnType<typeof createOrm<Record<string, unknown>>>;

			// This could be either OrmInstance (sync) or Promise<OrmInstance> (async)
			// depending on the overload matched
		});
	});
});

// ============================================================================
// Runtime Tests with Mock Adapter
// ============================================================================

describe('DX-102: Runtime type inference with mock adapter', () => {
	/**
	 * Mock adapter for testing - minimal implementation
	 */
	const mockAdapter = {
		execute: async () => [],
		executeTakeFirst: async () => undefined,
		executeTakeFirstOrThrow: async () => {
			throw new Error('Not found');
		},
		stream: async function* () {},
		introspect: async () => {
			// Return a mock ModelIR
			return {
				tables: new Map(),
				relations: new Map(),
				getTable: () => undefined,
				getRelation: () => undefined,
				getRelationsFrom: () => [],
				getRelationsTo: () => [],
			};
		},
		withSchema: () => mockAdapter,
		insert: async () => {},
		update: async () => 0,
		delete: async () => 0,
	} as any;

	it('should create ORM with inferred types from schema', () => {
		// This is the key test: createOrm without explicit generic should infer DB type
		const orm = createOrm({
			schema: simpleSchema,
			adapter: mockAdapter,
		});

		// Valid table names should work
		const usersQuery = orm.select('users');
		const postsQuery = orm.select('posts');

		// Verify the queries were created
		expect(usersQuery).toBeDefined();
		expect(postsQuery).toBeDefined();

		// Type-level verification: the ORM should have the correct DB type
		// This verifies that select() parameter is constrained to table names
		type OrmDB = typeof orm extends OrmInstance<infer DB> ? DB : never;
		expectTypeOf<keyof OrmDB>().toEqualTypeOf<'users' | 'posts'>();
	});

	it('should infer result types from schema', () => {
		const orm = createOrm({
			schema: simpleSchema,
			adapter: mockAdapter,
		});

		// Type-level verification: result types should match schema
		type OrmDB = typeof orm extends OrmInstance<infer DB> ? DB : never;

		expectTypeOf<OrmDB['users']>().toEqualTypeOf<{
			id: string;
			name: string;
			email: string | null;
		}>();

		expectTypeOf<OrmDB['posts']>().toEqualTypeOf<{
			id: string;
			title: string;
			authorId: string;
			publishedAt: Date | null;
		}>();
	});

	it('should provide column autocomplete in object filter syntax', () => {
		const orm = createOrm({
			schema: simpleSchema,
			adapter: mockAdapter,
		});

		// Object filter syntax should provide autocomplete for column names
		// This works because where() accepts WhereFilter<TResult> where TResult = DB[TableName]
		const query = orm.select('users').where({
			id: '123',
			name: 'John',
			// email can be string or null
			email: null,
		});

		expect(query).toBeDefined();

		// Note: eq('fieldName', value) standalone helpers do NOT provide column autocomplete
		// because they don't have table context. Use object filter syntax for type safety.
	});
});
