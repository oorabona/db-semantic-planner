/**
 * Error path tests for schema-dsl.ts
 *
 * Tests: validateRelations, validateHints, validateDefaultFilters (via defineSchema),
 * SchemaValidationError class, and edge cases for empty/minimal inputs.
 */

import { describe, expect, it } from 'vitest';
import { defineSchema, SchemaValidationError } from './schema-dsl.js';
import type { SchemaTablesDefinition } from './schema-dsl-types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const minimalTables: SchemaTablesDefinition = {
	users: { id: { type: 'uuid', primaryKey: true } },
	posts: { id: { type: 'uuid', primaryKey: true } },
};

// ===========================================================================
// SchemaValidationError
// ===========================================================================

describe('SchemaValidationError', () => {
	it('is an instance of Error', () => {
		const err = new SchemaValidationError('boom');
		expect(err).toBeInstanceOf(Error);
	});

	it('has name set to SchemaValidationError', () => {
		const err = new SchemaValidationError('boom');
		expect(err.name).toBe('SchemaValidationError');
	});

	it('preserves the message', () => {
		const err = new SchemaValidationError('detail message');
		expect(err.message).toBe('detail message');
	});
});

// ===========================================================================
// validateRelations (via defineSchema)
// ===========================================================================

describe('defineSchema → validateRelations', () => {
	it('throws when relation references non-existent source table', () => {
		expect(() =>
			defineSchema(minimalTables, {
				relations: {
					'nonexistent.rel': {
						kind: 'hasMany',
						target: 'users',
						foreignKey: 'userId',
					},
				},
			}),
		).toThrow(SchemaValidationError);
	});

	it('error message mentions non-existent source table name', () => {
		expect(() =>
			defineSchema(minimalTables, {
				relations: {
					'ghosts.rel': {
						kind: 'hasMany',
						target: 'users',
						foreignKey: 'userId',
					},
				},
			}),
		).toThrow(/non-existent source table.*ghosts/i);
	});

	it('throws when relation references non-existent target table', () => {
		expect(() =>
			defineSchema(minimalTables, {
				relations: {
					'users.phantoms': {
						kind: 'hasMany',
						target: 'phantoms',
						foreignKey: 'userId',
					},
				},
			}),
		).toThrow(SchemaValidationError);
	});

	it('error message mentions non-existent target table name', () => {
		expect(() =>
			defineSchema(minimalTables, {
				relations: {
					'users.phantoms': {
						kind: 'hasMany',
						target: 'phantoms',
						foreignKey: 'userId',
					},
				},
			}),
		).toThrow(/non-existent target table.*phantoms/i);
	});

	it('throws when manyToMany references non-existent junction table', () => {
		expect(() =>
			defineSchema(minimalTables, {
				relations: {
					'users.posts': {
						kind: 'manyToMany',
						target: 'posts',
						through: 'missing_junction',
						sourceFk: 'userId',
						targetFk: 'postId',
					},
				},
			}),
		).toThrow(SchemaValidationError);
	});

	it('error message mentions non-existent junction table name', () => {
		expect(() =>
			defineSchema(minimalTables, {
				relations: {
					'users.posts': {
						kind: 'manyToMany',
						target: 'posts',
						through: 'missing_junction',
						sourceFk: 'userId',
						targetFk: 'postId',
					},
				},
			}),
		).toThrow(/non-existent junction table.*missing_junction/i);
	});

	it('does not throw for valid manyToMany with existing junction', () => {
		const tables: SchemaTablesDefinition = {
			users: { id: { type: 'uuid', primaryKey: true } },
			roles: { id: { type: 'uuid', primaryKey: true } },
			user_roles: { id: { type: 'uuid', primaryKey: true } },
		};

		expect(() =>
			defineSchema(tables, {
				relations: {
					'users.roles': {
						kind: 'manyToMany',
						target: 'roles',
						through: 'user_roles',
						sourceFk: 'userId',
						targetFk: 'roleId',
					},
				},
			}),
		).not.toThrow();
	});
});

// ===========================================================================
// validateHints (via defineSchema)
// ===========================================================================

describe('defineSchema → validateHints', () => {
	it('throws when hint path does not match any relation', () => {
		expect(() =>
			defineSchema(minimalTables, {
				hints: {
					'users.nonexistent': { defaultStrategy: 'exists' },
				},
			}),
		).toThrow(SchemaValidationError);
	});

	it('error message contains "does not match any relation"', () => {
		expect(() =>
			defineSchema(minimalTables, {
				hints: {
					'users.nonexistent': { defaultStrategy: 'exists' },
				},
			}),
		).toThrow(/does not match any relation/i);
	});

	it('error message lists available relation paths', () => {
		// With minimalTables, no relations exist, so "Available:" is in the message
		expect(() =>
			defineSchema(minimalTables, {
				hints: {
					'users.nope': { cardinality: 'many' },
				},
			}),
		).toThrow(/Available:/);
	});

	it('throws for each invalid hint path (first one encountered)', () => {
		// defineSchema will throw on the first invalid path
		expect(() =>
			defineSchema(minimalTables, {
				hints: {
					'users.bad1': { defaultStrategy: 'exists' },
					'posts.bad2': { cardinality: 'one' },
				},
			}),
		).toThrow(SchemaValidationError);
	});
});

// ===========================================================================
// validateDefaultFilters (via defineSchema)
// ===========================================================================

describe('defineSchema → validateDefaultFilters', () => {
	it('throws when default filter references non-existent table', () => {
		expect(() =>
			defineSchema(minimalTables, {
				defaultFilters: {
					nonexistent: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: true,
					},
				},
			}),
		).toThrow(SchemaValidationError);
	});

	it('error message contains "non-existent table" and the table name', () => {
		expect(() =>
			defineSchema(minimalTables, {
				defaultFilters: {
					ghosts: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: true,
					},
				},
			}),
		).toThrow(/non-existent table.*ghosts/i);
	});

	it('error message lists available table names', () => {
		expect(() =>
			defineSchema(minimalTables, {
				defaultFilters: {
					missing: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: true,
					},
				},
			}),
		).toThrow(/Available:.*users/i);
	});

	it('does not throw for valid default filter table', () => {
		expect(() =>
			defineSchema(minimalTables, {
				defaultFilters: {
					users: {
						kind: 'comparison',
						field: 'active',
						operator: 'eq',
						value: true,
					},
				},
			}),
		).not.toThrow();
	});
});

// ===========================================================================
// defineSchema edge cases
// ===========================================================================

describe('defineSchema edge cases', () => {
	it('handles empty tables object without crashing', () => {
		const result = defineSchema({});
		expect(result.tables).toEqual({});
		expect(result.relations).toEqual({});
	});

	it('handles tables with no relations at all', () => {
		const tables: SchemaTablesDefinition = {
			standalone: {
				id: { type: 'uuid', primaryKey: true },
				name: { type: 'string' },
			},
		};
		const result = defineSchema(tables);
		expect(result.relations).toEqual({});
	});

	it('handles config with all empty objects', () => {
		const result = defineSchema(minimalTables, {
			relations: {},
			hints: {},
			conventions: {},
			indexes: {},
			defaultFilters: {},
		});
		expect(result.tables).toBe(minimalTables);
		expect(result.hints).toEqual({});
		expect(result.indexes).toEqual({});
		expect(result.defaultFilters).toEqual({});
	});

	it('handles undefined config', () => {
		const result = defineSchema(minimalTables);
		expect(result.tables).toBe(minimalTables);
	});
});
