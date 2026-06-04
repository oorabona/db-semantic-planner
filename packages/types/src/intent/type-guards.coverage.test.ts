/**
 * Coverage tests for intent type guard functions.
 *
 * Tests all ~35 exported type guards, covering every branch
 * (null, non-object, missing kind, wrong kind, correct kind).
 */
import { describe, expect, it } from 'vitest';
import type { ExpressionIntent, WindowFunction } from './expression-intent.js';
import type { RecursiveTraversal } from './recursive-intent.js';
import type { SelectIntent } from './select-intent.js';
import {
	isAdjacencyTraversal,
	isAggregateWindowFunction,
	isCoalesceExpression,
	isColumnAliasExpression,
	isCustomTraversal,
	isDeleteIntent,
	isEdgeTableTraversal,
	isInsertIntent,
	isMutationIntent,
	isRankingWindowFunction,
	isRawExpression,
	isRecursiveIntent,
	isRelationColumnExpression,
	isSelectAggregate,
	isSelectAll,
	isSelectFields,
	isSelectWithExpressions,
	isSubqueryRef,
	isUpdateIntent,
	isUpsertIntent,
	isWhereAnd,
	isWhereComparison,
	isWhereExists,
	isWhereIn,
	isWhereLike,
	isWhereLogical,
	isWhereNot,
	isWhereNotExists,
	isWhereNull,
	isWhereOr,
	isWhereRange,
	isWhereRelationBased,
	isWhereRelationFilter,
	isWhereSubquery,
	isWindowIntent,
} from './type-guards.js';
import type { WhereIntent } from './where-intent.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Factory for testing simple kind-discriminated where intent guards.
 */
function testWhereKindGuard(
	name: string,
	guard: (w: WhereIntent) => boolean,
	matchingKind: string,
	nonMatchingKinds: string[],
) {
	describe(name, () => {
		it(`returns true for kind === '${matchingKind}'`, () => {
			expect(guard({ kind: matchingKind } as WhereIntent)).toBe(true);
		});

		for (const kind of nonMatchingKinds) {
			it(`returns false for kind === '${kind}'`, () => {
				expect(guard({ kind } as WhereIntent)).toBe(false);
			});
		}
	});
}

/**
 * Factory for testing simple type-discriminated select intent guards.
 */
function testSelectTypeGuard(
	name: string,
	guard: (s: SelectIntent) => boolean,
	matchingType: string,
	nonMatchingTypes: string[],
) {
	describe(name, () => {
		it(`returns true for type === '${matchingType}'`, () => {
			expect(guard({ type: matchingType } as SelectIntent)).toBe(true);
		});

		for (const type of nonMatchingTypes) {
			it(`returns false for type === '${type}'`, () => {
				expect(guard({ type } as SelectIntent)).toBe(false);
			});
		}
	});
}

/**
 * Factory for testing simple kind-discriminated expression intent guards.
 */
function testExpressionKindGuard(
	name: string,
	guard: (e: ExpressionIntent) => boolean,
	matchingKind: string,
	nonMatchingKinds: string[],
) {
	describe(name, () => {
		it(`returns true for kind === '${matchingKind}'`, () => {
			expect(guard({ kind: matchingKind } as ExpressionIntent)).toBe(true);
		});

		for (const kind of nonMatchingKinds) {
			it(`returns false for kind === '${kind}'`, () => {
				expect(guard({ kind } as ExpressionIntent)).toBe(false);
			});
		}
	});
}

// ============================================================================
// Window Intent Type Guards
// ============================================================================

describe('isWindowIntent', () => {
	it('returns false for null', () => {
		expect(isWindowIntent(null)).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isWindowIntent(undefined)).toBe(false);
	});

	it('returns false for a string', () => {
		expect(isWindowIntent('window')).toBe(false);
	});

	it('returns false for a number', () => {
		expect(isWindowIntent(42)).toBe(false);
	});

	it('returns false for an empty object (no kind)', () => {
		expect(isWindowIntent({})).toBe(false);
	});

	it('returns false for object with wrong kind', () => {
		expect(isWindowIntent({ kind: 'other' })).toBe(false);
	});

	it('returns true for object with kind === "window"', () => {
		expect(isWindowIntent({ kind: 'window' })).toBe(true);
	});
});

describe('isAggregateWindowFunction', () => {
	const aggregateFunctions: WindowFunction[] = [
		'sum',
		'avg',
		'count',
		'min',
		'max',
		'lag',
		'lead',
	];

	for (const fn of aggregateFunctions) {
		it(`returns true for '${fn}'`, () => {
			expect(isAggregateWindowFunction(fn)).toBe(true);
		});
	}

	const nonAggregateFunctions: WindowFunction[] = [
		'row_number',
		'rank',
		'dense_rank',
	];

	for (const fn of nonAggregateFunctions) {
		it(`returns false for '${fn}'`, () => {
			expect(isAggregateWindowFunction(fn)).toBe(false);
		});
	}
});

describe('isRankingWindowFunction', () => {
	const rankingFunctions: WindowFunction[] = [
		'row_number',
		'rank',
		'dense_rank',
	];

	for (const fn of rankingFunctions) {
		it(`returns true for '${fn}'`, () => {
			expect(isRankingWindowFunction(fn)).toBe(true);
		});
	}

	const nonRankingFunctions: WindowFunction[] = [
		'sum',
		'avg',
		'count',
		'min',
		'max',
		'lag',
		'lead',
	];

	for (const fn of nonRankingFunctions) {
		it(`returns false for '${fn}'`, () => {
			expect(isRankingWindowFunction(fn)).toBe(false);
		});
	}
});

// ============================================================================
// Where Intent Type Guards — complex multi-branch
// ============================================================================

describe('isSubqueryRef', () => {
	it('returns false for null', () => {
		expect(isSubqueryRef(null)).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isSubqueryRef(undefined)).toBe(false);
	});

	it('returns false for a string', () => {
		expect(isSubqueryRef('ref')).toBe(false);
	});

	it('returns false for a number', () => {
		expect(isSubqueryRef(123)).toBe(false);
	});

	it('returns false for an empty object', () => {
		expect(isSubqueryRef({})).toBe(false);
	});

	it('returns false for object with wrong kind', () => {
		expect(isSubqueryRef({ kind: 'column' })).toBe(false);
	});

	it('returns true for object with kind === "ref"', () => {
		expect(isSubqueryRef({ kind: 'ref' })).toBe(true);
	});
});

describe('isWhereRelationBased', () => {
	const matchingKinds = ['exists', 'notExists', 'relationFilter'] as const;

	for (const kind of matchingKinds) {
		it(`returns true for kind === '${kind}'`, () => {
			expect(isWhereRelationBased({ kind } as WhereIntent)).toBe(true);
		});
	}

	const nonMatchingKinds = [
		'comparison',
		'like',
		'in',
		'null',
		'range',
		'and',
		'or',
		'not',
		'subquery',
	] as const;

	for (const kind of nonMatchingKinds) {
		it(`returns false for kind === '${kind}'`, () => {
			expect(isWhereRelationBased({ kind } as WhereIntent)).toBe(false);
		});
	}
});

describe('isWhereLogical', () => {
	const matchingKinds = ['and', 'or', 'not'] as const;

	for (const kind of matchingKinds) {
		it(`returns true for kind === '${kind}'`, () => {
			expect(isWhereLogical({ kind } as WhereIntent)).toBe(true);
		});
	}

	const nonMatchingKinds = [
		'comparison',
		'like',
		'in',
		'null',
		'range',
		'exists',
		'notExists',
		'relationFilter',
		'subquery',
	] as const;

	for (const kind of nonMatchingKinds) {
		it(`returns false for kind === '${kind}'`, () => {
			expect(isWhereLogical({ kind } as WhereIntent)).toBe(false);
		});
	}
});

// ============================================================================
// Where Intent Type Guards — simple kind checks
// ============================================================================

testWhereKindGuard('isWhereComparison', isWhereComparison, 'comparison', [
	'like',
	'in',
	'null',
]);

testWhereKindGuard('isWhereLike', isWhereLike, 'like', [
	'comparison',
	'in',
	'null',
]);

testWhereKindGuard('isWhereSubquery', isWhereSubquery, 'subquery', [
	'comparison',
	'like',
]);

testWhereKindGuard('isWhereIn', isWhereIn, 'in', ['comparison', 'like']);

testWhereKindGuard('isWhereNull', isWhereNull, 'null', ['comparison', 'in']);

testWhereKindGuard('isWhereRange', isWhereRange, 'range', [
	'comparison',
	'null',
]);

testWhereKindGuard('isWhereAnd', isWhereAnd, 'and', ['or', 'not']);

testWhereKindGuard('isWhereOr', isWhereOr, 'or', ['and', 'not']);

testWhereKindGuard('isWhereNot', isWhereNot, 'not', ['and', 'or']);

testWhereKindGuard('isWhereExists', isWhereExists, 'exists', [
	'notExists',
	'relationFilter',
]);

testWhereKindGuard('isWhereNotExists', isWhereNotExists, 'notExists', [
	'exists',
	'relationFilter',
]);

testWhereKindGuard(
	'isWhereRelationFilter',
	isWhereRelationFilter,
	'relationFilter',
	['exists', 'notExists'],
);

// ============================================================================
// Select Intent Type Guards
// ============================================================================

testSelectTypeGuard('isSelectAll', isSelectAll, 'all', [
	'fields',
	'aggregate',
	'expressions',
]);

testSelectTypeGuard('isSelectFields', isSelectFields, 'fields', [
	'all',
	'aggregate',
	'expressions',
]);

testSelectTypeGuard('isSelectAggregate', isSelectAggregate, 'aggregate', [
	'all',
	'fields',
	'expressions',
]);

testSelectTypeGuard(
	'isSelectWithExpressions',
	isSelectWithExpressions,
	'expressions',
	['all', 'fields', 'aggregate'],
);

// ============================================================================
// Expression Intent Type Guards
// ============================================================================

testExpressionKindGuard(
	'isCoalesceExpression',
	isCoalesceExpression,
	'coalesce',
	['raw', 'columnAlias', 'relationColumn'],
);

testExpressionKindGuard('isRawExpression', isRawExpression, 'raw', [
	'coalesce',
	'columnAlias',
	'relationColumn',
]);

testExpressionKindGuard(
	'isColumnAliasExpression',
	isColumnAliasExpression,
	'columnAlias',
	['coalesce', 'raw', 'relationColumn'],
);

testExpressionKindGuard(
	'isRelationColumnExpression',
	isRelationColumnExpression,
	'relationColumn',
	['coalesce', 'raw', 'columnAlias'],
);

// ============================================================================
// Recursive CTE Type Guards
// ============================================================================

describe('isAdjacencyTraversal', () => {
	it('returns true for kind === "adjacency"', () => {
		expect(
			isAdjacencyTraversal({ kind: 'adjacency' } as RecursiveTraversal),
		).toBe(true);
	});

	it('returns false for kind === "edge-table"', () => {
		expect(
			isAdjacencyTraversal({ kind: 'edge-table' } as RecursiveTraversal),
		).toBe(false);
	});

	it('returns false for kind === "custom"', () => {
		expect(isAdjacencyTraversal({ kind: 'custom' } as RecursiveTraversal)).toBe(
			false,
		);
	});
});

describe('isEdgeTableTraversal', () => {
	it('returns true for kind === "edge-table"', () => {
		expect(
			isEdgeTableTraversal({ kind: 'edge-table' } as RecursiveTraversal),
		).toBe(true);
	});

	it('returns false for kind === "adjacency"', () => {
		expect(
			isEdgeTableTraversal({ kind: 'adjacency' } as RecursiveTraversal),
		).toBe(false);
	});

	it('returns false for kind === "custom"', () => {
		expect(isEdgeTableTraversal({ kind: 'custom' } as RecursiveTraversal)).toBe(
			false,
		);
	});
});

describe('isCustomTraversal', () => {
	it('returns true for kind === "custom"', () => {
		expect(isCustomTraversal({ kind: 'custom' } as RecursiveTraversal)).toBe(
			true,
		);
	});

	it('returns false for kind === "adjacency"', () => {
		expect(isCustomTraversal({ kind: 'adjacency' } as RecursiveTraversal)).toBe(
			false,
		);
	});

	it('returns false for kind === "edge-table"', () => {
		expect(
			isCustomTraversal({ kind: 'edge-table' } as RecursiveTraversal),
		).toBe(false);
	});
});

describe('isRecursiveIntent', () => {
	it('returns true for type === "recursive"', () => {
		expect(
			isRecursiveIntent({ type: 'recursive' } as Parameters<
				typeof isRecursiveIntent
			>[0]),
		).toBe(true);
	});

	it('returns false for type === "select"', () => {
		expect(
			isRecursiveIntent({ type: 'select' } as Parameters<
				typeof isRecursiveIntent
			>[0]),
		).toBe(false);
	});
});

// ============================================================================
// Mutation Intent Type Guards
// ============================================================================

describe('isInsertIntent', () => {
	it('returns true for type === "insert"', () => {
		expect(
			isInsertIntent({ type: 'insert' } as Parameters<
				typeof isInsertIntent
			>[0]),
		).toBe(true);
	});

	it('returns false for type === "update"', () => {
		expect(
			isInsertIntent({ type: 'update' } as Parameters<
				typeof isInsertIntent
			>[0]),
		).toBe(false);
	});

	it('returns false for type === "select"', () => {
		expect(
			isInsertIntent({ type: 'select' } as Parameters<
				typeof isInsertIntent
			>[0]),
		).toBe(false);
	});
});

describe('isUpdateIntent', () => {
	it('returns true for type === "update"', () => {
		expect(
			isUpdateIntent({ type: 'update' } as Parameters<
				typeof isUpdateIntent
			>[0]),
		).toBe(true);
	});

	it('returns false for type === "insert"', () => {
		expect(
			isUpdateIntent({ type: 'insert' } as Parameters<
				typeof isUpdateIntent
			>[0]),
		).toBe(false);
	});

	it('returns false for type === "select"', () => {
		expect(
			isUpdateIntent({ type: 'select' } as Parameters<
				typeof isUpdateIntent
			>[0]),
		).toBe(false);
	});
});

describe('isDeleteIntent', () => {
	it('returns true for type === "delete"', () => {
		expect(
			isDeleteIntent({ type: 'delete' } as Parameters<
				typeof isDeleteIntent
			>[0]),
		).toBe(true);
	});

	it('returns false for type === "insert"', () => {
		expect(
			isDeleteIntent({ type: 'insert' } as Parameters<
				typeof isDeleteIntent
			>[0]),
		).toBe(false);
	});

	it('returns false for type === "recursive"', () => {
		expect(
			isDeleteIntent({ type: 'recursive' } as Parameters<
				typeof isDeleteIntent
			>[0]),
		).toBe(false);
	});
});

describe('isUpsertIntent', () => {
	it('returns true for type === "upsert"', () => {
		expect(
			isUpsertIntent({ type: 'upsert' } as Parameters<
				typeof isUpsertIntent
			>[0]),
		).toBe(true);
	});

	it('returns false for type === "insert"', () => {
		expect(
			isUpsertIntent({ type: 'insert' } as Parameters<
				typeof isUpsertIntent
			>[0]),
		).toBe(false);
	});

	it('returns false for type === "select"', () => {
		expect(
			isUpsertIntent({ type: 'select' } as Parameters<
				typeof isUpsertIntent
			>[0]),
		).toBe(false);
	});
});

describe('isMutationIntent', () => {
	const mutationTypes = [
		'insert',
		'insert_from',
		'upsert_from',
		'update',
		'batchUpdate',
		'delete',
		'upsert',
	] as const;

	for (const type of mutationTypes) {
		it(`returns true for type === '${type}'`, () => {
			expect(
				isMutationIntent({ type } as Parameters<typeof isMutationIntent>[0]),
			).toBe(true);
		});
	}

	const nonMutationTypes = ['select', 'recursive'] as const;

	for (const type of nonMutationTypes) {
		it(`returns false for type === '${type}'`, () => {
			expect(
				isMutationIntent({ type } as Parameters<typeof isMutationIntent>[0]),
			).toBe(false);
		});
	}
});
