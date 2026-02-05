/**
 * EXPLAIN and Streaming Tests
 */

import type { Node } from '@pgsql/types';
import { describe, expect, it } from 'vitest';
import {
	buildExplain,
	buildExplainAnalyzeJson,
	buildExplainPlan,
	buildExplainVerbose,
	getRowEstimates,
	getTotalExecutionTime,
	parseExplainJson,
} from '../explain/index.js';
import {
	buildCloseCursor,
	buildDeclareCursor,
	buildFetch,
	buildFetchAll,
	buildFetchFirst,
	buildFetchForward,
	buildFetchNext,
	buildStreamingStatements,
	generateCursorName,
} from '../streaming/index.js';

// Sample SELECT query for testing
const sampleSelect: Node = {
	SelectStmt: {
		targetList: [
			{
				ResTarget: {
					val: {
						ColumnRef: {
							fields: [{ A_Star: {} }],
						},
					},
				},
			},
		],
		fromClause: [
			{
				RangeVar: {
					relname: 'users',
					inh: true,
					relpersistence: 'p',
				},
			},
		],
	},
};

describe('EXPLAIN Builder', () => {
	describe('buildExplain', () => {
		it('should build simple EXPLAIN without options', () => {
			const result = buildExplain(sampleSelect);

			expect(result).toHaveProperty('ExplainStmt');
			const stmt = (result as any).ExplainStmt;
			expect(stmt.query).toBe(sampleSelect);
			expect(stmt.options).toBeUndefined();
		});

		it('should build EXPLAIN with ANALYZE option', () => {
			const result = buildExplain(sampleSelect, { analyze: true });

			const stmt = (result as any).ExplainStmt;
			expect(stmt.options).toBeDefined();
			expect(stmt.options).toHaveLength(1);
			expect(stmt.options[0].DefElem.defname).toBe('analyze');
		});

		it('should build EXPLAIN with FORMAT JSON', () => {
			const result = buildExplain(sampleSelect, { format: 'json' });

			const stmt = (result as any).ExplainStmt;
			expect(stmt.options).toBeDefined();
			const formatOpt = stmt.options.find(
				(o: any) => o.DefElem.defname === 'format',
			);
			expect(formatOpt.DefElem.arg.String.sval).toBe('json');
		});

		it('should build EXPLAIN with multiple options', () => {
			const result = buildExplain(sampleSelect, {
				analyze: true,
				verbose: true,
				format: 'json',
			});

			const stmt = (result as any).ExplainStmt;
			expect(stmt.options).toHaveLength(3);
		});

		it('should build EXPLAIN with all options', () => {
			const result = buildExplain(sampleSelect, {
				analyze: true,
				verbose: true,
				costs: true,
				buffers: true,
				timing: true,
				settings: true,
				format: 'json',
			});

			const stmt = (result as any).ExplainStmt;
			expect(stmt.options).toHaveLength(7);
		});
	});

	describe('buildExplainAnalyzeJson', () => {
		it('should build EXPLAIN ANALYZE with JSON format', () => {
			const result = buildExplainAnalyzeJson(sampleSelect);

			const stmt = (result as any).ExplainStmt;
			expect(stmt.options).toHaveLength(2);

			const analyzeOpt = stmt.options.find(
				(o: any) => o.DefElem.defname === 'analyze',
			);
			expect(analyzeOpt.DefElem.arg.String.sval).toBe('true');

			const formatOpt = stmt.options.find(
				(o: any) => o.DefElem.defname === 'format',
			);
			expect(formatOpt.DefElem.arg.String.sval).toBe('json');
		});
	});

	describe('buildExplainPlan', () => {
		it('should build simple EXPLAIN without options', () => {
			const result = buildExplainPlan(sampleSelect);

			const stmt = (result as any).ExplainStmt;
			expect(stmt.options).toBeUndefined();
		});
	});

	describe('buildExplainVerbose', () => {
		it('should build verbose EXPLAIN with analysis options', () => {
			const result = buildExplainVerbose(sampleSelect);

			const stmt = (result as any).ExplainStmt;
			expect(stmt.options.length).toBeGreaterThanOrEqual(4);
		});
	});
});

describe('EXPLAIN JSON Parsing', () => {
	const sampleExplainJson = JSON.stringify([
		{
			Plan: {
				'Node Type': 'Seq Scan',
				'Relation Name': 'users',
				Alias: 'users',
				'Startup Cost': 0.0,
				'Total Cost': 10.5,
				'Plan Rows': 500,
				'Plan Width': 100,
				'Actual Startup Time': 0.01,
				'Actual Total Time': 0.5,
				'Actual Rows': 450,
				'Actual Loops': 1,
			},
			'Planning Time': 0.1,
			'Execution Time': 0.6,
		},
	]);

	describe('parseExplainJson', () => {
		it('should parse valid EXPLAIN JSON output', () => {
			const plans = parseExplainJson(sampleExplainJson);

			expect(plans).toHaveLength(1);
			expect(plans[0]!.Plan['Node Type']).toBe('Seq Scan');
		});

		it('should throw on invalid JSON', () => {
			expect(() => parseExplainJson('not json')).toThrow(
				'Failed to parse EXPLAIN JSON output',
			);
		});

		it('should handle single plan object (not array)', () => {
			const singlePlan = JSON.stringify({
				Plan: { 'Node Type': 'Result' },
			});
			const plans = parseExplainJson(singlePlan);

			expect(plans).toHaveLength(1);
		});
	});

	describe('getTotalExecutionTime', () => {
		it('should calculate total execution time', () => {
			const plans = parseExplainJson(sampleExplainJson);
			const time = getTotalExecutionTime(plans);

			expect(time).toBeCloseTo(0.7, 2); // Planning + Execution
		});

		it('should return 0 for empty plans', () => {
			const time = getTotalExecutionTime([]);
			expect(time).toBe(0);
		});
	});

	describe('getRowEstimates', () => {
		it('should extract row estimates', () => {
			const plans = parseExplainJson(sampleExplainJson);
			const rows = getRowEstimates(plans);

			expect(rows.estimated).toBe(500);
			expect(rows.actual).toBe(450);
		});

		it('should return zeros for empty plans', () => {
			const rows = getRowEstimates([]);
			expect(rows.estimated).toBe(0);
			expect(rows.actual).toBe(0);
		});
	});
});

describe('Streaming (Cursor) Builder', () => {
	describe('buildDeclareCursor', () => {
		it('should build basic DECLARE CURSOR', () => {
			const result = buildDeclareCursor({
				name: 'my_cursor',
				query: sampleSelect,
			});

			expect(result).toHaveProperty('DeclareCursorStmt');
			const stmt = (result as any).DeclareCursorStmt;
			expect(stmt.portalname).toBe('my_cursor');
			expect(stmt.query).toBe(sampleSelect);
		});

		it('should handle scroll option', () => {
			const result = buildDeclareCursor({
				name: 'scroll_cursor',
				query: sampleSelect,
				scroll: 'scroll',
			});

			const stmt = (result as any).DeclareCursorStmt;
			expect(stmt.options & 0x0002).toBeTruthy(); // CURSOR_OPT_SCROLL
		});

		it('should handle no_scroll option', () => {
			const result = buildDeclareCursor({
				name: 'noscroll_cursor',
				query: sampleSelect,
				scroll: 'no_scroll',
			});

			const stmt = (result as any).DeclareCursorStmt;
			expect(stmt.options & 0x0004).toBeTruthy(); // CURSOR_OPT_NO_SCROLL
		});

		it('should handle with_hold option', () => {
			const result = buildDeclareCursor({
				name: 'hold_cursor',
				query: sampleSelect,
				hold: 'with_hold',
			});

			const stmt = (result as any).DeclareCursorStmt;
			expect(stmt.options & 0x0010).toBeTruthy(); // CURSOR_OPT_HOLD
		});
	});

	describe('buildFetch', () => {
		it('should build FETCH NEXT', () => {
			const result = buildFetch({
				cursorName: 'my_cursor',
				direction: 'next',
				count: 1,
			});

			expect(result).toHaveProperty('FetchStmt');
			const stmt = (result as any).FetchStmt;
			expect(stmt.portalname).toBe('my_cursor');
			expect(stmt.howMany).toBe(BigInt(1));
		});

		it('should build FETCH FORWARD with count', () => {
			const result = buildFetch({
				cursorName: 'my_cursor',
				direction: 'forward',
				count: 100,
			});

			const stmt = (result as any).FetchStmt;
			expect(stmt.howMany).toBe(BigInt(100));
		});

		it('should build FETCH ALL with INT_MAX', () => {
			const result = buildFetch({
				cursorName: 'my_cursor',
				direction: 'forward_all',
			});

			const stmt = (result as any).FetchStmt;
			// PostgreSQL represents FETCH ALL as FETCH FORWARD with INT_MAX
			expect(stmt.howMany).toBe(BigInt(2147483647));
		});
	});

	describe('buildCloseCursor', () => {
		it('should build CLOSE cursor', () => {
			const result = buildCloseCursor('my_cursor');

			expect(result).toHaveProperty('ClosePortalStmt');
			const stmt = (result as any).ClosePortalStmt;
			expect(stmt.portalname).toBe('my_cursor');
		});

		it('should handle CLOSE ALL', () => {
			const result = buildCloseCursor('*');

			const stmt = (result as any).ClosePortalStmt;
			expect(stmt.portalname).toBeUndefined();
		});
	});

	describe('Convenience builders', () => {
		it('buildFetchNext should fetch 1 row', () => {
			const result = buildFetchNext('cursor');
			const stmt = (result as any).FetchStmt;
			expect(stmt.howMany).toBe(BigInt(1));
		});

		it('buildFetchForward should fetch N rows', () => {
			const result = buildFetchForward('cursor', 50);
			const stmt = (result as any).FetchStmt;
			expect(stmt.howMany).toBe(BigInt(50));
		});

		it('buildFetchAll should fetch all rows', () => {
			const result = buildFetchAll('cursor');
			const stmt = (result as any).FetchStmt;
			// PostgreSQL represents FETCH ALL as FETCH FORWARD with INT_MAX
			expect(stmt.howMany).toBe(BigInt(2147483647));
		});

		it('buildFetchFirst should fetch first row', () => {
			const result = buildFetchFirst('cursor');
			const stmt = (result as any).FetchStmt;
			expect(stmt.direction).toBe('FETCH_ABSOLUTE');
		});
	});

	describe('generateCursorName', () => {
		it('should generate unique cursor names', () => {
			const name1 = generateCursorName();
			const name2 = generateCursorName();

			expect(name1).not.toBe(name2);
			expect(name1).toMatch(/^__cursor_/);
		});

		it('should use custom prefix', () => {
			const name = generateCursorName('myprefix');
			expect(name).toMatch(/^myprefix_/);
		});
	});

	describe('buildStreamingStatements', () => {
		it('should build all streaming statements', () => {
			const result = buildStreamingStatements(sampleSelect, {
				batchSize: 100,
			});

			expect(result.cursorName).toMatch(/^__cursor_/);
			expect(result.declare).toHaveProperty('DeclareCursorStmt');
			expect(result.fetchBatch).toHaveProperty('FetchStmt');
			expect(result.fetchAll).toHaveProperty('FetchStmt');
			expect(result.close).toHaveProperty('ClosePortalStmt');
		});

		it('should use configured batch size', () => {
			const result = buildStreamingStatements(sampleSelect, {
				batchSize: 500,
			});

			const stmt = (result.fetchBatch as any).FetchStmt;
			expect(stmt.howMany).toBe(BigInt(500));
		});

		it('should handle withHold option', () => {
			const result = buildStreamingStatements(sampleSelect, {
				withHold: true,
			});

			const stmt = (result.declare as any).DeclareCursorStmt;
			expect(stmt.options & 0x0010).toBeTruthy(); // CURSOR_OPT_HOLD
		});

		it('should use custom cursor prefix', () => {
			const result = buildStreamingStatements(sampleSelect, {
				cursorPrefix: 'stream',
			});

			expect(result.cursorName).toMatch(/^stream_/);
		});
	});
});
