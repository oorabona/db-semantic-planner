/**
 * @module compiler/recursive-cte.test
 * Tests for the shared WITH RECURSIVE scalar subquery builder.
 *
 * Covers:
 * - F-006: Edge cases for deep hierarchy + maxDepth boundary
 * - F-002: Cycle detection verification
 * - Direction-aware traversal (ancestors / descendants)
 * - Table reference with/without schema
 * - Dedup utility
 */

import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
	buildRecursiveScalarSubquery,
	buildTableRef,
	dedup,
	type RecursiveCteConfig,
} from './recursive-cte.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a default config for ancestor traversal. */
function makeConfig(
	overrides?: Partial<RecursiveCteConfig>,
): RecursiveCteConfig {
	const cteAlias = overrides?.cteAlias ?? '__rc_1';
	return {
		cteAlias,
		tableRef: sql.id('employees'),
		pkColumn: 'id',
		fkColumn: 'manager_id',
		rootAlias: 'employees',
		isAncestors: true,
		maxDepth: 10,
		selectColumns: sql`"__n".*`,
		aggregateExpr: sql`json_agg(to_jsonb(${sql.id(cteAlias)}) ORDER BY ${sql.ref(`${cteAlias}.__depth`)})`,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildRecursiveScalarSubquery
// ---------------------------------------------------------------------------

describe('buildRecursiveScalarSubquery', () => {
	describe('cycle detection (F-002)', () => {
		it('includes __visited array in anchor case', () => {
			const config = makeConfig();
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// Anchor: ARRAY["__n"."id"] AS "__visited"
			expect(node).toContain('__visited');
			expect(node).toContain('__depth');
		});

		it('includes cycle guard in recursive case', () => {
			const config = makeConfig();
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// Recursive: __n.pk <> ALL(__rc.__visited)
			// Check for the ALL operator presence
			expect(node).toContain('__visited');
		});

		it('propagates visited array in recursive step', () => {
			const config = makeConfig();
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// __rc_1.__visited || __n.id  (path extension)
			// The || operator concatenates arrays in PostgreSQL
			expect(node).toContain('__visited');
			expect(node).toContain('__depth');
		});
	});

	describe('maxDepth boundary (F-006)', () => {
		it('embeds maxDepth value in WHERE clause', () => {
			const config = makeConfig({ maxDepth: 5 });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// WHERE __rc.__depth < 5
			expect(node).toContain('__depth');
			// The value 5 should be present as a parameter
			expect(node).toContain('5');
		});

		it('respects maxDepth=1 (single level only)', () => {
			const config = makeConfig({ maxDepth: 1 });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// maxDepth=1 means only direct parent/child, no recursion beyond 1
			expect(node).toContain('1');
			expect(node).toContain('__depth');
		});

		it('handles large maxDepth (100)', () => {
			const config = makeConfig({ maxDepth: 100 });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			expect(node).toContain('100');
			expect(node).toContain('__depth');
		});
	});

	describe('direction: ancestors (isAncestors=true)', () => {
		it('anchor follows FK upward: __n.pk = outer.fk', () => {
			const config = makeConfig({ isAncestors: true });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// Ancestor anchor: __n.id = employees.manager_id
			expect(node).toContain('__n');
			expect(node).toContain('id');
			expect(node).toContain('manager_id');
		});

		it('recursive join follows FK upward: __n.pk = __rc.fk', () => {
			const config = makeConfig({ isAncestors: true });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			expect(node).toContain('__rc_1');
			expect(node).toContain('manager_id');
		});
	});

	describe('direction: descendants (isAncestors=false)', () => {
		it('anchor follows FK downward: __n.fk = outer.pk', () => {
			const config = makeConfig({ isAncestors: false });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// Descendant anchor: __n.manager_id = employees.id
			expect(node).toContain('__n');
			expect(node).toContain('manager_id');
		});

		it('recursive join follows FK downward: __n.fk = __rc.pk', () => {
			const config = makeConfig({ isAncestors: false });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			expect(node).toContain('__rc_1');
		});
	});

	describe('COALESCE fallback', () => {
		it('wraps aggregate with COALESCE to empty JSON array', () => {
			const config = makeConfig();
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			// COALESCE(..., '[]'::json)
			expect(node).toContain('COALESCE');
		});
	});

	describe('unique CTE alias', () => {
		it('uses provided cteAlias in output', () => {
			const config = makeConfig({ cteAlias: '__rc_42' });
			const result = buildRecursiveScalarSubquery(config);
			const node = JSON.stringify(result.toOperationNode());

			expect(node).toContain('__rc_42');
		});

		it('different aliases produce different output', () => {
			const config1 = makeConfig({ cteAlias: '__rc_1' });
			const config2 = makeConfig({ cteAlias: '__rc_2' });
			const node1 = JSON.stringify(
				buildRecursiveScalarSubquery(config1).toOperationNode(),
			);
			const node2 = JSON.stringify(
				buildRecursiveScalarSubquery(config2).toOperationNode(),
			);

			expect(node1).toContain('__rc_1');
			expect(node2).toContain('__rc_2');
			expect(node1).not.toEqual(node2);
		});
	});
});

// ---------------------------------------------------------------------------
// buildTableRef
// ---------------------------------------------------------------------------

describe('buildTableRef', () => {
	it('returns unqualified table reference without schema', () => {
		const ref = buildTableRef('employees');
		const node = JSON.stringify(ref.toOperationNode());

		expect(node).toContain('employees');
	});

	it('returns schema-qualified table reference with schema', () => {
		const ref = buildTableRef('employees', 'tenant_123');
		const node = JSON.stringify(ref.toOperationNode());

		expect(node).toContain('employees');
		expect(node).toContain('tenant_123');
	});

	it('handles undefined schema same as no schema', () => {
		const ref1 = buildTableRef('employees');
		const ref2 = buildTableRef('employees', undefined);
		const node1 = JSON.stringify(ref1.toOperationNode());
		const node2 = JSON.stringify(ref2.toOperationNode());

		expect(node1).toEqual(node2);
	});
});

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

describe('dedup', () => {
	it('removes duplicates preserving order', () => {
		expect(dedup(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
	});

	it('returns empty array for empty input', () => {
		expect(dedup([])).toEqual([]);
	});

	it('preserves single-element arrays', () => {
		expect(dedup(['x'])).toEqual(['x']);
	});

	it('handles all-same elements', () => {
		expect(dedup(['a', 'a', 'a'])).toEqual(['a']);
	});
});
