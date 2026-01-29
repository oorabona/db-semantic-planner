/**
 * Recursive CTE Compiler Tests
 */

import { describe, expect, it } from 'vitest';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';
import {
	buildCycleCheck,
	buildCycleDetection,
	buildCycleFilter,
	isPg14CycleSupported,
} from '../recursive/cycle-detection.js';
import {
	buildRecursiveCte,
	buildRecursiveScalarSubquery,
	type RecursiveCteConfig,
} from '../recursive/index.js';
import {
	appendPathColumn,
	buildPathColumn,
	buildPathString,
} from '../recursive/path-tracking.js';

describe('Recursive CTE Compiler', () => {
	const naming = new CamelCaseNamingPlugin();

	const baseConfig: RecursiveCteConfig = {
		cteAlias: '__rc_0',
		table: 'employees',
		pkColumn: 'id',
		fkColumn: 'parent_id',
		outerAlias: 't0',
		isAncestors: true,
		maxDepth: 100,
		selectColumns: ['id', 'name'],
		ctx: {
			naming,
			rootTable: 'employees',
			maxRecursiveDepth: 100,
		},
	};

	describe('buildRecursiveCte', () => {
		it('should build CTE for ancestor traversal', () => {
			const { cte, cteSelect } = buildRecursiveCte(baseConfig);

			expect(cte).toHaveProperty('CommonTableExpr');
			const cteNode = (cte as any).CommonTableExpr;

			expect(cteNode.ctename).toBe('__rc_0');
			expect(cteNode.cterecursive).toBe(true);
			expect(cteNode.ctequery).toHaveProperty('SelectStmt');

			// Should be UNION ALL
			const unionStmt = cteNode.ctequery.SelectStmt;
			expect(unionStmt.op).toBe('SETOP_UNION');
			expect(unionStmt.all).toBe(true);
		});

		it('should build CTE for descendant traversal', () => {
			const config = { ...baseConfig, isAncestors: false };
			const { cte } = buildRecursiveCte(config);

			expect(cte).toHaveProperty('CommonTableExpr');
			expect((cte as any).CommonTableExpr.cterecursive).toBe(true);
		});

		it('should include path tracking when enabled', () => {
			const config = { ...baseConfig, trackPath: true };
			const { cte } = buildRecursiveCte(config);

			// The CTE should have __path in target list
			expect(cte).toHaveProperty('CommonTableExpr');
		});
	});

	describe('buildRecursiveScalarSubquery', () => {
		it('should produce a SubLink for scalar subquery', () => {
			const result = buildRecursiveScalarSubquery(baseConfig, 'name');

			expect(result).toHaveProperty('SubLink');
			const subLink = (result as any).SubLink;
			expect(subLink.subLinkType).toBe('EXPR_SUBLINK');
			expect(subLink.subselect).toHaveProperty('SelectStmt');

			// Should have WITH clause
			const selectStmt = subLink.subselect.SelectStmt;
			expect(selectStmt.withClause).toBeDefined();
			expect(selectStmt.withClause.recursive).toBe(true);
		});
	});
});

describe('Path Tracking', () => {
	describe('buildPathColumn', () => {
		it('should build anchor path column', () => {
			const result = buildPathColumn('t0', 'id') as any;

			expect(result).toHaveProperty('ResTarget');
			expect(result.ResTarget.name).toBe('__path');
			expect(result.ResTarget.val).toHaveProperty('A_ArrayExpr');
		});
	});

	describe('appendPathColumn', () => {
		it('should build recursive path append', () => {
			const result = appendPathColumn('__rc', 't0', 'id') as any;

			expect(result).toHaveProperty('ResTarget');
			expect(result.ResTarget.name).toBe('__path');
			expect(result.ResTarget.val).toHaveProperty('A_Expr');
		});
	});

	describe('buildPathString', () => {
		it('should build path string expression', () => {
			const result = buildPathString('__rc', '/') as any;

			expect(result).toHaveProperty('ResTarget');
			expect(result.ResTarget.name).toBe('__path_string');
			expect(result.ResTarget.val).toHaveProperty('FuncCall');
		});
	});
});

describe('Cycle Detection', () => {
	describe('buildCycleDetection', () => {
		it('should build anchor __visited array', () => {
			const result = buildCycleDetection('t0', 'id', true) as any;

			expect(result).toHaveProperty('ResTarget');
			expect(result.ResTarget.name).toBe('__visited');
			expect(result.ResTarget.val).toHaveProperty('A_ArrayExpr');
		});

		it('should build recursive __visited append', () => {
			const result = buildCycleDetection('t0', 'id', false, '__rc') as any;

			expect(result).toHaveProperty('ResTarget');
			expect(result.ResTarget.name).toBe('__visited');
			expect(result.ResTarget.val).toHaveProperty('A_Expr');
		});

		it('should throw if cteAlias missing for recursive', () => {
			expect(() => {
				buildCycleDetection('t0', 'id', false);
			}).toThrow('cteAlias required');
		});
	});

	describe('buildCycleCheck', () => {
		it('should build pk <> ALL(__visited) expression', () => {
			const result = buildCycleCheck('t0', '__rc', 'id') as any;

			expect(result).toHaveProperty('A_Expr');
			expect(result.A_Expr.kind).toBe('AEXPR_OP_ALL');
		});
	});

	describe('buildCycleFilter', () => {
		it('should build NOT is_cycle expression', () => {
			const result = buildCycleFilter() as any;

			expect(result).toHaveProperty('BoolExpr');
			expect(result.BoolExpr.boolop).toBe('NOT_EXPR');
		});
	});

	describe('isPg14CycleSupported', () => {
		it('should return false by default', () => {
			expect(isPg14CycleSupported()).toBe(false);
		});
	});
});
