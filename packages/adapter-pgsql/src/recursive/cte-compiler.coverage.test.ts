// @ts-nocheck — coverage test: runtime assertions on AST nodes

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../naming-plugin.js';
import {
	buildRecursiveCte,
	buildRecursiveScalarSubquery,
} from './cte-compiler.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Build a minimal CompilerContext for testing
 */
function makeCtx(overrides = {}) {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	};
}

/**
 * Build a base RecursiveCteConfig for testing
 */
function makeConfig(overrides = {}) {
	return {
		cteAlias: '__rc_0',
		table: 'categories',
		pkColumn: 'id',
		fkColumn: 'parent_id',
		outerAlias: 't0',
		isAncestors: true,
		maxDepth: 100,
		selectColumns: ['id', 'name'],
		ctx: makeCtx(),
		...overrides,
	};
}

// ============================================================================
// Adjacency Mode Tests (Standard Self-Referencing Table)
// ============================================================================

describe('buildRecursiveCte - adjacency mode', () => {
	it('should build ancestors CTE (isAncestors: true)', () => {
		const result = buildRecursiveCte(makeConfig({ isAncestors: true }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte).toHaveProperty('CommonTableExpr');
		expect(result.cte.CommonTableExpr).toHaveProperty('ctename', '__rc_0');
		expect(result.cte.CommonTableExpr).toHaveProperty('cterecursive', true);
	});

	it('should build descendants CTE (isAncestors: false)', () => {
		const result = buildRecursiveCte(makeConfig({ isAncestors: false }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte).toHaveProperty('CommonTableExpr');
		expect(result.cte.CommonTableExpr).toHaveProperty('ctename', '__rc_0');
		expect(result.cte.CommonTableExpr).toHaveProperty('cterecursive', true);
	});

	it('should handle single column selection', () => {
		const result = buildRecursiveCte(makeConfig({ selectColumns: ['id'] }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr.ctequery).toBeDefined();
	});

	it('should handle multiple column selection', () => {
		const result = buildRecursiveCte(
			makeConfig({ selectColumns: ['id', 'name', 'parent_id', 'created_at'] }),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr.ctequery).toBeDefined();
	});

	it('should handle small maxDepth (3)', () => {
		const result = buildRecursiveCte(makeConfig({ maxDepth: 3 }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should handle default maxDepth (100)', () => {
		const result = buildRecursiveCte(makeConfig({ maxDepth: 100 }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should handle large maxDepth (1000)', () => {
		const result = buildRecursiveCte(makeConfig({ maxDepth: 1000 }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should add __path column when trackPath: true', () => {
		const result = buildRecursiveCte(makeConfig({ trackPath: true }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr.ctequery).toBeDefined();
	});

	it('should not add __path column when trackPath: false', () => {
		const result = buildRecursiveCte(makeConfig({ trackPath: false }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should use PG14 CYCLE clause when usePg14Cycle: true', () => {
		const result = buildRecursiveCte(makeConfig({ usePg14Cycle: true }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr).toHaveProperty('cycle_clause');
	});

	it('should not use PG14 CYCLE clause when usePg14Cycle: false', () => {
		const result = buildRecursiveCte(makeConfig({ usePg14Cycle: false }));

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr).not.toHaveProperty('cycle_clause');
	});

	it('should handle trackPath: true AND usePg14Cycle: true combined', () => {
		const result = buildRecursiveCte(
			makeConfig({ trackPath: true, usePg14Cycle: true }),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr).toHaveProperty('cycle_clause');
	});

	it('should qualify table with schema when ctx.schema provided', () => {
		const result = buildRecursiveCte(
			makeConfig({
				ctx: makeCtx({ schema: 'tenant_123' }),
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should not qualify table when ctx.schema not provided', () => {
		const result = buildRecursiveCte(
			makeConfig({
				ctx: makeCtx(),
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});
});

// ============================================================================
// Edge-Table Mode Tests
// ============================================================================

describe('buildRecursiveCte - edge-table mode', () => {
	it('should build edge-table CTE when edgeTable provided', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr).toHaveProperty('ctename', '__rc_0');
	});

	it('should throw error when edgeTable provided but edgeFrom missing', () => {
		expect(() => {
			buildRecursiveCte(
				makeConfig({
					edgeTable: 'role_edges',
					edgeTo: 'child_role_id',
				}),
			);
		}).toThrow('edgeTable, edgeFrom, and edgeTo are required');
	});

	it('should throw error when edgeTable provided but edgeTo missing', () => {
		expect(() => {
			buildRecursiveCte(
				makeConfig({
					edgeTable: 'role_edges',
					edgeFrom: 'parent_role_id',
				}),
			);
		}).toThrow('edgeTable, edgeFrom, and edgeTo are required');
	});

	it('should create bidirectional CTE with union strategy', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				bidirectionalStrategy: 'union',
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.extraCtes).toBeDefined();
		expect(result.extraCtes).toHaveLength(1);
		expect(result.extraCtes[0]).toHaveProperty('CommonTableExpr');
		expect(result.extraCtes[0].CommonTableExpr).toHaveProperty(
			'ctename',
			'__edges_bidir',
		);
	});

	it('should create bidirectional CTE with union-all strategy', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				bidirectionalStrategy: 'union-all',
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.extraCtes).toBeDefined();
		expect(result.extraCtes).toHaveLength(1);
		expect(result.extraCtes[0]).toHaveProperty('CommonTableExpr');
	});

	it('should not create extraCtes when bidirectionalStrategy not provided', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.extraCtes).toBeUndefined();
	});

	it('should use anchorWhere when provided in edge-table mode', () => {
		const anchorWhere = {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: '=' } }],
				lexpr: {
					ColumnRef: {
						fields: [{ String: { sval: '__n' } }, { String: { sval: 'id' } }],
					},
				},
				rexpr: { A_Const: { ival: { ival: 42 } } },
			},
		};

		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				anchorWhere,
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should use default TRUE anchor when anchorWhere not provided', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should add __path in edge-table mode when trackPath: true', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				trackPath: true,
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should use PG14 CYCLE in edge-table mode when usePg14Cycle: true', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				usePg14Cycle: true,
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr).toHaveProperty('cycle_clause');
	});

	it('should qualify edge table with schema when ctx.schema provided', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				ctx: makeCtx({ schema: 'tenant_123' }),
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
	});

	it('should handle bidirectional + trackPath + usePg14Cycle combined', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				bidirectionalStrategy: 'union',
				trackPath: true,
				usePg14Cycle: true,
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.extraCtes).toBeDefined();
		expect(result.extraCtes).toHaveLength(1);
		expect(result.cte.CommonTableExpr).toHaveProperty('cycle_clause');
	});
});

// ============================================================================
// Scalar Subquery Tests
// ============================================================================

describe('buildRecursiveScalarSubquery', () => {
	it('should build scalar subquery with json_agg', () => {
		const result = buildRecursiveScalarSubquery(makeConfig(), 'id');

		expect(result).toBeDefined();
		expect(result).toHaveProperty('SubLink');
		expect(result.SubLink).toHaveProperty('subLinkType', 'EXPR_SUBLINK');
		expect(result.SubLink).toHaveProperty('subselect');
	});

	it('should wrap recursive CTE with json_agg for ancestors', () => {
		const result = buildRecursiveScalarSubquery(
			makeConfig({ isAncestors: true }),
			'name',
		);

		expect(result).toBeDefined();
		expect(result).toHaveProperty('SubLink');
		expect(result.SubLink.subselect).toHaveProperty('SelectStmt');
	});

	it('should wrap recursive CTE with json_agg for descendants', () => {
		const result = buildRecursiveScalarSubquery(
			makeConfig({ isAncestors: false }),
			'name',
		);

		expect(result).toBeDefined();
		expect(result).toHaveProperty('SubLink');
		expect(result.SubLink.subselect).toHaveProperty('SelectStmt');
	});

	it('should include withClause with recursive CTE', () => {
		const result = buildRecursiveScalarSubquery(makeConfig(), 'id');

		expect(result).toBeDefined();
		expect(result.SubLink.subselect.SelectStmt).toHaveProperty('withClause');
		expect(result.SubLink.subselect.SelectStmt.withClause).toHaveProperty(
			'recursive',
			true,
		);
		expect(result.SubLink.subselect.SelectStmt.withClause).toHaveProperty(
			'ctes',
		);
		expect(result.SubLink.subselect.SelectStmt.withClause.ctes).toHaveLength(1);
	});
});

// ============================================================================
// Complex Combination Tests
// ============================================================================

describe('buildRecursiveCte - complex combinations', () => {
	it('should handle all options enabled for adjacency mode', () => {
		const result = buildRecursiveCte(
			makeConfig({
				isAncestors: false,
				maxDepth: 50,
				selectColumns: ['id', 'name', 'created_at'],
				trackPath: true,
				usePg14Cycle: true,
				ctx: makeCtx({ schema: 'public' }),
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.cte.CommonTableExpr).toHaveProperty('cycle_clause');
	});

	it('should handle all options enabled for edge-table mode', () => {
		const result = buildRecursiveCte(
			makeConfig({
				edgeTable: 'role_edges',
				edgeFrom: 'parent_role_id',
				edgeTo: 'child_role_id',
				bidirectionalStrategy: 'union-all',
				maxDepth: 25,
				selectColumns: ['id', 'name', 'description'],
				trackPath: true,
				usePg14Cycle: true,
				ctx: makeCtx({ schema: 'tenant_456' }),
				anchorWhere: {
					A_Expr: {
						kind: 'AEXPR_OP',
						name: [{ String: { sval: '=' } }],
						lexpr: {
							ColumnRef: {
								fields: [
									{ String: { sval: '__n' } },
									{ String: { sval: 'active' } },
								],
							},
						},
						rexpr: { A_Const: { boolval: { boolval: true } } },
					},
				},
			}),
		);

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.extraCtes).toBeDefined();
		expect(result.extraCtes).toHaveLength(1);
		expect(result.cte.CommonTableExpr).toHaveProperty('cycle_clause');
	});

	it('should handle minimal configuration (adjacency mode)', () => {
		const result = buildRecursiveCte({
			cteAlias: '__rc_0',
			table: 'nodes',
			pkColumn: 'id',
			fkColumn: 'parent_id',
			outerAlias: 't0',
			isAncestors: true,
			maxDepth: 100,
			selectColumns: ['id'],
			ctx: makeCtx(),
		});

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.extraCtes).toBeUndefined();
	});

	it('should handle minimal configuration (edge-table mode)', () => {
		const result = buildRecursiveCte({
			cteAlias: '__rc_0',
			table: 'nodes',
			pkColumn: 'id',
			fkColumn: 'parent_id',
			outerAlias: 't0',
			isAncestors: true,
			maxDepth: 100,
			selectColumns: ['id'],
			edgeTable: 'edges',
			edgeFrom: 'from_id',
			edgeTo: 'to_id',
			ctx: makeCtx(),
		});

		expect(result.cte).toBeDefined();
		expect(result.cteSelect).toBeDefined();
		expect(result.extraCtes).toBeUndefined();
	});
});
