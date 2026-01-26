/**
 * @fileoverview Type-level tests for TableRef, ColumnRef, RelationRef types.
 *
 * These tests verify compile-time type inference without runtime execution.
 * Uses vitest's expectTypeOf for type assertions.
 *
 * @module table-ref.test
 * @since DX-040
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	type AliasedColumn,
	type AllColumns,
	BRAND,
	COLUMN_META,
	type ColumnRef,
	type InferColumnTypes,
	type InferTableRow,
	isAliasedColumn,
	isAllColumns,
	isColumnRef,
	isRelationRef,
	isTableRef,
	RELATION_META,
	type RelationRef,
	type RelationType,
	TABLE_META,
	type TableRef,
} from './table-ref.js';

// ============================================================================
// Test fixtures: Mock TableRef for type testing
// ============================================================================

// Define column types for 'users' table
type UserColumns = {
	id: ColumnRef<'users', 'id', number>;
	name: ColumnRef<'users', 'name', string>;
	email: ColumnRef<'users', 'email', string>;
	active: ColumnRef<'users', 'active', boolean>;
};

// Define column types for 'posts' table
type PostColumns = {
	id: ColumnRef<'posts', 'id', number>;
	title: ColumnRef<'posts', 'title', string>;
	authorId: ColumnRef<'posts', 'authorId', number>;
	published: ColumnRef<'posts', 'published', boolean>;
};

// Define relation types
type UserRelations = {
	posts: RelationRef<
		'posts',
		Array<{ id: number; title: string }>,
		'hasMany',
		{
			id: number;
			title: string;
			authorId: number;
			published: boolean;
		}
	>;
};

// Full TableRef types
type UsersTableRef = TableRef<'users', UserColumns, UserRelations>;
type PostsTableRef = TableRef<'posts', PostColumns>;

// ============================================================================
// Type-level tests
// ============================================================================

describe('TableRef types', () => {
	describe('ColumnRef', () => {
		it('should have correct type parameters', () => {
			type IdColumn = ColumnRef<'users', 'id', number>;

			// Verify type structure
			expectTypeOf<IdColumn>().toHaveProperty(TABLE_META);
			expectTypeOf<IdColumn>().toHaveProperty(COLUMN_META);
			expectTypeOf<IdColumn>().toHaveProperty(BRAND);
			expectTypeOf<IdColumn>().toHaveProperty('_type');
			expectTypeOf<IdColumn>().toHaveProperty('as');
		});

		it('should infer correct phantom type', () => {
			type IdColumn = ColumnRef<'users', 'id', number>;
			type NameColumn = ColumnRef<'users', 'name', string>;

			// The _type should match the type parameter
			expectTypeOf<IdColumn['_type']>().toEqualTypeOf<number>();
			expectTypeOf<NameColumn['_type']>().toEqualTypeOf<string>();
		});

		it('should have as() method returning AliasedColumn', () => {
			type IdColumn = ColumnRef<'users', 'id', number>;
			type AliasedResult = ReturnType<IdColumn['as']>;

			// as() method should exist and return correct type
			expectTypeOf<IdColumn['as']>().toBeFunction();
			// AliasedColumn extends ColumnRef and has _alias
			expectTypeOf<AliasedResult>().toHaveProperty('_alias');
		});
	});

	describe('AliasedColumn', () => {
		it('should extend ColumnRef with _alias property', () => {
			type AliasedId = AliasedColumn<'users', 'id', number, 'userId'>;

			// Should have all ColumnRef properties
			expectTypeOf<AliasedId>().toHaveProperty(TABLE_META);
			expectTypeOf<AliasedId>().toHaveProperty(COLUMN_META);
			expectTypeOf<AliasedId>().toHaveProperty(BRAND);
			expectTypeOf<AliasedId>().toHaveProperty('_type');

			// Plus _alias
			expectTypeOf<AliasedId>().toHaveProperty('_alias');
			expectTypeOf<AliasedId['_alias']>().toEqualTypeOf<'userId'>();
		});
	});

	describe('AllColumns', () => {
		it('should have correct type parameters', () => {
			type UserAllCols = AllColumns<'users', { id: number; name: string }>;

			expectTypeOf<UserAllCols>().toHaveProperty(BRAND);
			expectTypeOf<UserAllCols>().toHaveProperty(TABLE_META);
			expectTypeOf<UserAllCols>().toHaveProperty('_columns');
		});

		it('should carry column types in _columns', () => {
			type UserAllCols = AllColumns<'users', { id: number; name: string }>;

			expectTypeOf<UserAllCols['_columns']>().toEqualTypeOf<{
				id: number;
				name: string;
			}>();
		});
	});

	describe('RelationRef', () => {
		it('should have correct type parameters', () => {
			type PostsRelation = RelationRef<
				'posts',
				Array<{ id: number; title: string }>,
				'hasMany',
				{ id: number; title: string }
			>;

			expectTypeOf<PostsRelation>().toHaveProperty(RELATION_META);
			expectTypeOf<PostsRelation>().toHaveProperty(BRAND);
			expectTypeOf<PostsRelation>().toHaveProperty('_type');
		});

		it('should provide column access through relation', () => {
			type PostsRelation = RelationRef<
				'posts',
				Array<{ id: number; title: string }>,
				'hasMany',
				{ id: number; title: string }
			>;

			// Should be able to access target table columns
			expectTypeOf<PostsRelation['id']>().toExtend<
				ColumnRef<'posts', 'id', number>
			>();
			expectTypeOf<PostsRelation['title']>().toExtend<
				ColumnRef<'posts', 'title', string>
			>();
		});

		it('should have wildcard property for SELECT *', () => {
			type PostsRelation = RelationRef<
				'posts',
				Array<{ id: number; title: string }>,
				'hasMany',
				{ id: number; title: string }
			>;

			expectTypeOf<PostsRelation['*']>().toExtend<
				AllColumns<'posts', { id: number; title: string }>
			>();
		});
	});

	describe('TableRef', () => {
		it('should have correct metadata properties', () => {
			expectTypeOf<UsersTableRef>().toHaveProperty(TABLE_META);
			expectTypeOf<UsersTableRef>().toHaveProperty(BRAND);
		});

		it('should provide typed column access', () => {
			// Column access should return ColumnRef with correct types
			expectTypeOf<UsersTableRef['id']>().toExtend<
				ColumnRef<'users', 'id', number>
			>();
			expectTypeOf<UsersTableRef['name']>().toExtend<
				ColumnRef<'users', 'name', string>
			>();
			expectTypeOf<UsersTableRef['email']>().toExtend<
				ColumnRef<'users', 'email', string>
			>();
			expectTypeOf<UsersTableRef['active']>().toExtend<
				ColumnRef<'users', 'active', boolean>
			>();
		});

		it('should provide typed relation access', () => {
			// Relation access should return RelationRef - verify the BRAND
			expectTypeOf<
				UsersTableRef['posts'][typeof BRAND]
			>().toEqualTypeOf<'RelationRef'>();
			// Verify relation metadata
			expectTypeOf<
				UsersTableRef['posts'][typeof RELATION_META]
			>().toEqualTypeOf<{
				target: 'posts';
				type: 'hasMany';
			}>();
		});

		it('should have wildcard property for SELECT *', () => {
			// Verify wildcard has correct BRAND
			expectTypeOf<
				UsersTableRef['*'][typeof BRAND]
			>().toEqualTypeOf<'AllColumns'>();
			// Verify table name
			expectTypeOf<
				UsersTableRef['*'][typeof TABLE_META]
			>().toEqualTypeOf<'users'>();
		});

		it('should exclude relations that conflict with column names', () => {
			// If a relation has the same name as a column, column takes precedence
			type ConflictColumns = {
				id: ColumnRef<'test', 'id', number>;
				posts: ColumnRef<'test', 'posts', string>; // column named 'posts'
			};
			type ConflictRelations = {
				posts: RelationRef<'posts', unknown[], 'hasMany'>; // relation named 'posts'
			};
			type ConflictTable = TableRef<'test', ConflictColumns, ConflictRelations>;

			// 'posts' should be the column, not the relation - verify BRAND is ColumnRef
			expectTypeOf<
				ConflictTable['posts'][typeof BRAND]
			>().toEqualTypeOf<'ColumnRef'>();
			// Verify column metadata
			expectTypeOf<
				ConflictTable['posts'][typeof COLUMN_META]
			>().toEqualTypeOf<'posts'>();
		});
	});

	describe('InferColumnTypes', () => {
		it('should extract column types from TColumns record', () => {
			type Inferred = InferColumnTypes<UserColumns>;

			expectTypeOf<Inferred>().toEqualTypeOf<{
				id: number;
				name: string;
				email: string;
				active: boolean;
			}>();
		});
	});

	describe('InferTableRow', () => {
		it('should infer row type from TableRef', () => {
			// Test InferTableRow with a simple TableRef (matching table name in columns)
			type SimpleColumns = {
				id: ColumnRef<'simple', 'id', number>;
				name: ColumnRef<'simple', 'name', string>;
			};
			type SimpleTable = TableRef<'simple', SimpleColumns>;
			type SimpleRow = InferTableRow<SimpleTable>;

			expectTypeOf<SimpleRow>().toEqualTypeOf<{
				id: number;
				name: string;
			}>();
		});
	});

	describe('RelationType', () => {
		it('should be union of valid relation types', () => {
			expectTypeOf<RelationType>().toEqualTypeOf<
				'belongsTo' | 'hasMany' | 'hasOne'
			>();
		});
	});
});

// ============================================================================
// Runtime type guard tests
// ============================================================================

describe('Type guards', () => {
	// Create mock objects for testing type guards
	const mockTableRef = {
		[TABLE_META]: 'users',
		[BRAND]: 'TableRef' as const,
	};

	const mockColumnRef = {
		[TABLE_META]: 'users',
		[COLUMN_META]: 'id',
		[BRAND]: 'ColumnRef' as const,
		_type: 0 as number,
		as: () => ({}),
	};

	const mockRelationRef = {
		[RELATION_META]: { target: 'posts', type: 'hasMany' as const },
		[BRAND]: 'RelationRef' as const,
		_type: [] as unknown[],
	};

	const mockAllColumns = {
		[TABLE_META]: 'users',
		[BRAND]: 'AllColumns' as const,
		_columns: {} as Record<string, unknown>,
	};

	const mockAliasedColumn = {
		...mockColumnRef,
		_alias: 'userId',
	};

	describe('isTableRef', () => {
		it('should return true for TableRef objects', () => {
			expect(isTableRef(mockTableRef)).toBe(true);
		});

		it('should return false for non-TableRef values', () => {
			expect(isTableRef(null)).toBe(false);
			expect(isTableRef(undefined)).toBe(false);
			expect(isTableRef({})).toBe(false);
			expect(isTableRef(mockColumnRef)).toBe(false);
			expect(isTableRef(mockRelationRef)).toBe(false);
		});
	});

	describe('isColumnRef', () => {
		it('should return true for ColumnRef objects', () => {
			expect(isColumnRef(mockColumnRef)).toBe(true);
		});

		it('should return false for non-ColumnRef values', () => {
			expect(isColumnRef(null)).toBe(false);
			expect(isColumnRef(undefined)).toBe(false);
			expect(isColumnRef({})).toBe(false);
			expect(isColumnRef(mockTableRef)).toBe(false);
			expect(isColumnRef(mockRelationRef)).toBe(false);
		});
	});

	describe('isRelationRef', () => {
		it('should return true for RelationRef objects', () => {
			expect(isRelationRef(mockRelationRef)).toBe(true);
		});

		it('should return false for non-RelationRef values', () => {
			expect(isRelationRef(null)).toBe(false);
			expect(isRelationRef(undefined)).toBe(false);
			expect(isRelationRef({})).toBe(false);
			expect(isRelationRef(mockTableRef)).toBe(false);
			expect(isRelationRef(mockColumnRef)).toBe(false);
		});
	});

	describe('isAllColumns', () => {
		it('should return true for AllColumns objects', () => {
			expect(isAllColumns(mockAllColumns)).toBe(true);
		});

		it('should return false for non-AllColumns values', () => {
			expect(isAllColumns(null)).toBe(false);
			expect(isAllColumns(undefined)).toBe(false);
			expect(isAllColumns({})).toBe(false);
			expect(isAllColumns(mockTableRef)).toBe(false);
			expect(isAllColumns(mockColumnRef)).toBe(false);
		});
	});

	describe('isAliasedColumn', () => {
		it('should return true for AliasedColumn objects', () => {
			expect(isAliasedColumn(mockAliasedColumn)).toBe(true);
		});

		it('should return false for regular ColumnRef', () => {
			expect(isAliasedColumn(mockColumnRef)).toBe(false);
		});

		it('should return false for non-ColumnRef values', () => {
			expect(isAliasedColumn(null)).toBe(false);
			expect(isAliasedColumn(undefined)).toBe(false);
			expect(isAliasedColumn({})).toBe(false);
			expect(isAliasedColumn(mockTableRef)).toBe(false);
		});
	});
});

// ============================================================================
// Symbol tests
// ============================================================================

describe('Symbols', () => {
	it('should be globally unique via Symbol.for()', () => {
		// Symbols created with Symbol.for() are globally registered
		expect(TABLE_META).toBe(Symbol.for('dbsp:table'));
		expect(COLUMN_META).toBe(Symbol.for('dbsp:column'));
		expect(RELATION_META).toBe(Symbol.for('dbsp:relation'));
		expect(BRAND).toBe(Symbol.for('dbsp:brand'));
	});

	it('should be accessible across module boundaries', () => {
		// Create an object with our symbols in this module
		const obj = {
			[TABLE_META]: 'test',
			[BRAND]: 'TableRef',
		};

		// Access using imported symbols (simulates cross-module access)
		expect(obj[TABLE_META]).toBe('test');
		expect(obj[BRAND]).toBe('TableRef');
	});
});
