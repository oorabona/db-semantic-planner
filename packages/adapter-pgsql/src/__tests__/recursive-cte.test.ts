/**
 * Recursive CTE Compiler Tests
 */

import { describe, expect, it } from 'vitest';
import { deparseQuoted } from '../deparse.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';
import {
	buildCycleCheck,
	buildCycleDetection,
	buildCycleFilter,
	buildPg14CycleClause,
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

		it('should attach PG14 CYCLE clause when usePg14Cycle is true', () => {
			const config = { ...baseConfig, usePg14Cycle: true };
			const { cte } = buildRecursiveCte(config);
			const cteNode = (cte as any).CommonTableExpr;

			// cycle_clause should be attached
			expect(cteNode.cycle_clause).toBeDefined();
			expect(cteNode.cycle_clause.cycle_mark_column).toBe('is_cycle');
			expect(cteNode.cycle_clause.cycle_path_column).toBe('__cycle_path');
			expect(cteNode.cycle_clause.cycle_col_list).toEqual([
				{ String: { sval: 'id' } },
			]);
		});

		it('should omit __visited column when usePg14Cycle is true', () => {
			const config = { ...baseConfig, usePg14Cycle: true };
			const { cte } = buildRecursiveCte(config);
			const cteNode = (cte as any).CommonTableExpr;

			// larg is a SelectStmt directly (not wrapped in { SelectStmt: ... })
			const union = cteNode.ctequery.SelectStmt;
			const anchorTargets = union.larg.targetList;

			// Should NOT have __visited
			const visitedTarget = anchorTargets.find(
				(t: any) => t.ResTarget?.name === '__visited',
			);
			expect(visitedTarget).toBeUndefined();
		});

		it('should include __visited column when usePg14Cycle is false', () => {
			const config = { ...baseConfig, usePg14Cycle: false };
			const { cte } = buildRecursiveCte(config);
			const cteNode = (cte as any).CommonTableExpr;

			const union = cteNode.ctequery.SelectStmt;
			const anchorTargets = union.larg.targetList;

			// Should have __visited
			const visitedTarget = anchorTargets.find(
				(t: any) => t.ResTarget?.name === '__visited',
			);
			expect(visitedTarget).toBeDefined();
			expect(cteNode.cycle_clause).toBeUndefined();
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
		it('should return true (CTECycleClause available in @pgsql/types)', () => {
			expect(isPg14CycleSupported()).toBe(true);
		});
	});

	describe('buildPg14CycleClause', () => {
		it('should return CTECycleClause node', () => {
			const result = buildPg14CycleClause('id') as any;

			expect(result).toHaveProperty('CTECycleClause');
			expect(result.CTECycleClause.cycle_col_list).toEqual([
				{ String: { sval: 'id' } },
			]);
			expect(result.CTECycleClause.cycle_mark_column).toBe('is_cycle');
			expect(result.CTECycleClause.cycle_path_column).toBe('__cycle_path');
		});

		it('should accept custom column names', () => {
			const result = buildPg14CycleClause('pk', 'cycled', 'path') as any;

			expect(result.CTECycleClause.cycle_col_list).toEqual([
				{ String: { sval: 'pk' } },
			]);
			expect(result.CTECycleClause.cycle_mark_column).toBe('cycled');
			expect(result.CTECycleClause.cycle_path_column).toBe('path');
		});
	});
});

// ============================================================================
// Edge-Table CTE Tests
// ============================================================================

describe('Edge-Table Recursive CTE', () => {
	const naming = new CamelCaseNamingPlugin();

	const edgeConfig: RecursiveCteConfig = {
		cteAlias: '__rc_0',
		table: 'roles',
		pkColumn: 'id',
		fkColumn: '', // unused in edge-table mode
		outerAlias: 't0',
		isAncestors: false,
		maxDepth: 10,
		selectColumns: ['id', 'name'],
		edgeTable: 'roleEdges',
		edgeFrom: 'parentRoleId',
		edgeTo: 'childRoleId',
		anchorWhere: {
			A_Expr: {
				kind: 'AEXPR_OP',
				name: [{ String: { sval: '=' } }],
				lexpr: {
					ColumnRef: {
						fields: [{ String: { sval: '__n' } }, { String: { sval: 'name' } }],
					},
				},
				rexpr: { A_Const: { sval: { sval: 'admin' } } },
			},
		},
		ctx: {
			naming,
			rootTable: 'roles',
			maxRecursiveDepth: 10,
		},
	};

	describe('buildRecursiveCte (edge-table, direction: out)', () => {
		it('should build CTE with edge-table JOINs', () => {
			const { cte, extraCtes } = buildRecursiveCte(edgeConfig);

			const cteNode = (cte as any).CommonTableExpr;
			expect(cteNode.ctename).toBe('__rc_0');
			expect(cteNode.cterecursive).toBe(true);

			// No extra CTEs for non-bidirectional
			expect(extraCtes).toBeUndefined();

			// UNION ALL structure
			const union = cteNode.ctequery.SelectStmt;
			expect(union.op).toBe('SETOP_UNION');
			expect(union.all).toBe(true);

			// Recursive part should have a JoinExpr (nested: cte JOIN edge JOIN node)
			const rarg = union.rarg;
			expect(rarg.fromClause).toHaveLength(1);
			expect(rarg.fromClause[0]).toHaveProperty('JoinExpr');

			// The outer join is edge-to-node
			const outerJoin = rarg.fromClause[0].JoinExpr;
			expect(outerJoin.jointype).toBe('JOIN_INNER');
			// Inner join is cte-to-edge
			expect(outerJoin.larg).toHaveProperty('JoinExpr');
		});

		it('should produce valid SQL via deparseQuoted', () => {
			const { cte } = buildRecursiveCte(edgeConfig);
			const cteNode = (cte as any).CommonTableExpr;

			// Build a wrapping SELECT to deparse
			const sql = deparseQuoted({
				SelectStmt: {
					targetList: [
						{
							ResTarget: {
								val: { ColumnRef: { fields: [{ A_Star: {} }] } },
							},
						},
					],
					fromClause: [
						{
							RangeVar: {
								relname: '__rc_0',
								inh: true,
								relpersistence: 'p',
							},
						},
					],
					withClause: {
						ctes: [cte],
						recursive: true,
					},
				},
			});

			// Should contain edge table JOIN
			expect(sql).toContain('role_edges');
			expect(sql).toContain('parent_role_id');
			expect(sql).toContain('child_role_id');
			// Should contain node table
			expect(sql).toContain('roles');
			// Should contain RECURSIVE keyword
			expect(sql).toContain('RECURSIVE');
			// Should contain cycle detection
			expect(sql).toContain('__visited');
			// Should contain depth tracking
			expect(sql).toContain('__depth');
		});
	});

	describe('buildRecursiveCte (edge-table, direction: in — swapped)', () => {
		it('should work with swapped edgeFrom/edgeTo', () => {
			const inConfig: RecursiveCteConfig = {
				...edgeConfig,
				// For 'in' direction, caller swaps edgeFrom/edgeTo
				edgeFrom: 'childRoleId',
				edgeTo: 'parentRoleId',
			};

			const { cte } = buildRecursiveCte(inConfig);
			const cteNode = (cte as any).CommonTableExpr;

			const sql = deparseQuoted({
				SelectStmt: {
					targetList: [
						{
							ResTarget: {
								val: { ColumnRef: { fields: [{ A_Star: {} }] } },
							},
						},
					],
					fromClause: [
						{
							RangeVar: {
								relname: '__rc_0',
								inh: true,
								relpersistence: 'p',
							},
						},
					],
					withClause: {
						ctes: [cte],
						recursive: true,
					},
				},
			});

			// For 'in' direction, edgeFrom is childRoleId and edgeTo is parentRoleId
			expect(sql).toContain('child_role_id');
			expect(sql).toContain('parent_role_id');
			expect(cteNode.cterecursive).toBe(true);
		});
	});

	describe('buildRecursiveCte (edge-table with path tracking)', () => {
		it('should include __path column when trackPath is true', () => {
			const pathConfig: RecursiveCteConfig = {
				...edgeConfig,
				trackPath: true,
			};

			const { cte } = buildRecursiveCte(pathConfig);
			const cteNode = (cte as any).CommonTableExpr;
			const union = cteNode.ctequery.SelectStmt;

			// Anchor should have __path target
			const anchorTargets = union.larg.targetList;
			const pathTarget = anchorTargets.find(
				(t: any) => t.ResTarget?.name === '__path',
			);
			expect(pathTarget).toBeDefined();

			// Recursive should also have __path target
			const recursiveTargets = union.rarg.targetList;
			const recPathTarget = recursiveTargets.find(
				(t: any) => t.ResTarget?.name === '__path',
			);
			expect(recPathTarget).toBeDefined();
		});
	});

	describe('buildRecursiveCte (bidirectional — UNION)', () => {
		it('should produce __edges_bidir CTE with UNION', () => {
			const bidirConfig: RecursiveCteConfig = {
				...edgeConfig,
				bidirectionalStrategy: 'union',
			};

			const { cte, extraCtes } = buildRecursiveCte(bidirConfig);

			// Should have the extra __edges_bidir CTE
			expect(extraCtes).toBeDefined();
			expect(extraCtes).toHaveLength(1);

			const bidirCte = (extraCtes![0] as any).CommonTableExpr;
			expect(bidirCte.ctename).toBe('__edges_bidir');
			expect(bidirCte.cterecursive).toBe(false);

			// The bidir CTE should be UNION (not UNION ALL)
			const bidirUnion = bidirCte.ctequery.SelectStmt;
			expect(bidirUnion.op).toBe('SETOP_UNION');
			expect(bidirUnion.all).toBeFalsy();

			// Main CTE should reference __edges_bidir
			const sql = deparseQuoted({
				SelectStmt: {
					targetList: [
						{
							ResTarget: {
								val: { ColumnRef: { fields: [{ A_Star: {} }] } },
							},
						},
					],
					fromClause: [
						{
							RangeVar: {
								relname: '__rc_0',
								inh: true,
								relpersistence: 'p',
							},
						},
					],
					withClause: {
						ctes: [...extraCtes!, cte],
						recursive: true,
					},
				},
			});

			expect(sql).toContain('__edges_bidir');
			expect(sql).toContain('from_id');
			expect(sql).toContain('to_id');
		});
	});

	describe('buildRecursiveCte (bidirectional — UNION ALL / directed-only)', () => {
		it('should produce __edges_bidir CTE with UNION ALL', () => {
			const bidirAllConfig: RecursiveCteConfig = {
				...edgeConfig,
				bidirectionalStrategy: 'union-all',
			};

			const { extraCtes } = buildRecursiveCte(bidirAllConfig);

			expect(extraCtes).toBeDefined();
			const bidirCte = (extraCtes![0] as any).CommonTableExpr;
			const bidirUnion = bidirCte.ctequery.SelectStmt;
			expect(bidirUnion.op).toBe('SETOP_UNION');
			expect(bidirUnion.all).toBe(true);
		});
	});
});
