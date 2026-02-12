import { describe, expect, it } from 'vitest';
import type { ModelIR, RelationIR } from '../model-ir.js';
import { extractRecursiveField, findSelfRefRelation } from './hierarchy-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRelation(
	overrides: Partial<RelationIR> & Pick<RelationIR, 'name' | 'source' | 'target' | 'type'>,
): RelationIR {
	return {
		cardinality: 'many',
		optionality: 'optional',
		includeStrategy: 'auto',
		filterStrategy: 'auto',
		joinDefault: 'auto',
		...overrides,
	};
}

function makeMockModel(relations: readonly RelationIR[]): ModelIR {
	return {
		tables: new Map(),
		relations: new Map(),
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: (_table: string) => relations,
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

// ---------------------------------------------------------------------------
// extractRecursiveField
// ---------------------------------------------------------------------------

describe('extractRecursiveField', () => {
	it('returns empty array for null input', () => {
		expect(extractRecursiveField(null, 'ancestors')).toEqual([]);
	});

	it('returns empty array for undefined input', () => {
		expect(extractRecursiveField(undefined, 'descendants')).toEqual([]);
	});

	it('returns the field value when present', () => {
		const row = { id: 1, ancestors: [{ id: 2 }, { id: 3 }] };
		expect(extractRecursiveField(row, 'ancestors')).toEqual([{ id: 2 }, { id: 3 }]);
	});

	it('returns empty array when field is absent (nullish coalescing)', () => {
		const row = { id: 1, name: 'root' };
		expect(extractRecursiveField(row, 'descendants')).toEqual([]);
	});

	it('returns empty array when field value is null', () => {
		const row = { id: 1, ancestors: null };
		expect(extractRecursiveField(row as Record<string, unknown>, 'ancestors')).toEqual([]);
	});

	it('returns empty array when field value is undefined', () => {
		const row = { id: 1, ancestors: undefined };
		expect(extractRecursiveField(row, 'ancestors')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// findSelfRefRelation
// ---------------------------------------------------------------------------

describe('findSelfRefRelation', () => {
	it('returns null when getRelationsFrom returns empty array', () => {
		const model = makeMockModel([]);
		expect(findSelfRefRelation(model, 'categories', 'ancestors')).toBeNull();
	});

	it('returns null when all relations are non-self-referential', () => {
		const model = makeMockModel([
			makeRelation({ name: 'author', source: 'posts', target: 'users', type: 'belongsTo' }),
			makeRelation({ name: 'comments', source: 'posts', target: 'comments', type: 'hasMany' }),
		]);
		expect(findSelfRefRelation(model, 'posts', 'ancestors')).toBeNull();
	});

	it('returns belongsTo self-ref relation for ancestors direction', () => {
		const model = makeMockModel([
			makeRelation({ name: 'parent', source: 'categories', target: 'categories', type: 'belongsTo' }),
		]);
		expect(findSelfRefRelation(model, 'categories', 'ancestors')).toEqual({
			name: 'parent',
			type: 'belongsTo',
		});
	});

	it('returns hasOne self-ref relation for ancestors direction', () => {
		const model = makeMockModel([
			makeRelation({ name: 'manager', source: 'employees', target: 'employees', type: 'hasOne' }),
		]);
		expect(findSelfRefRelation(model, 'employees', 'ancestors')).toEqual({
			name: 'manager',
			type: 'hasOne',
		});
	});

	it('returns hasMany self-ref relation for descendants direction', () => {
		const model = makeMockModel([
			makeRelation({ name: 'children', source: 'categories', target: 'categories', type: 'hasMany' }),
		]);
		expect(findSelfRefRelation(model, 'categories', 'descendants')).toEqual({
			name: 'children',
			type: 'hasMany',
		});
	});

	it('ignores hasMany self-ref when looking for ancestors', () => {
		const model = makeMockModel([
			makeRelation({ name: 'children', source: 'categories', target: 'categories', type: 'hasMany' }),
		]);
		expect(findSelfRefRelation(model, 'categories', 'ancestors')).toBeNull();
	});

	it('ignores belongsTo self-ref when looking for descendants', () => {
		const model = makeMockModel([
			makeRelation({ name: 'parent', source: 'categories', target: 'categories', type: 'belongsTo' }),
		]);
		expect(findSelfRefRelation(model, 'categories', 'descendants')).toBeNull();
	});

	it('returns first matching self-ref relation when multiple exist', () => {
		const model = makeMockModel([
			makeRelation({ name: 'nonSelf', source: 'categories', target: 'tags', type: 'hasMany' }),
			makeRelation({ name: 'parent', source: 'categories', target: 'categories', type: 'belongsTo' }),
			makeRelation({ name: 'supervisor', source: 'categories', target: 'categories', type: 'hasOne' }),
		]);
		// Should return the first matching one (parent, belongsTo)
		expect(findSelfRefRelation(model, 'categories', 'ancestors')).toEqual({
			name: 'parent',
			type: 'belongsTo',
		});
	});

	it('returns null for self-ref belongsToMany (no matching direction)', () => {
		const model = makeMockModel([
			makeRelation({ name: 'related', source: 'items', target: 'items', type: 'belongsToMany' }),
		]);
		expect(findSelfRefRelation(model, 'items', 'ancestors')).toBeNull();
		expect(findSelfRefRelation(model, 'items', 'descendants')).toBeNull();
	});
});
