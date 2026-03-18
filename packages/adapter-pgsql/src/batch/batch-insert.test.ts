/**
 * Batch INSERT via unnest tests — BATCH-001 Block 2
 *
 * Verifies the compilation strategy switch:
 * - rows <= batchThreshold (default 50) → VALUES ($1,$2),...
 * - rows > batchThreshold OR batchThreshold === 0 → SELECT unnest($1::type[]),...
 */

import { InvalidOperationError } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an intent with N rows of { symbol_id: number, vector: string } */
function makeEmbeddingRows(n: number): Record<string, unknown>[] {
	return Array.from({ length: n }, (_, i) => ({
		symbol_id: i + 1,
		vector: `vec_${i}`,
	}));
}

/** Build an intent with N rows of { symbol_id, vector, chunk_text } */
function makeEmbeddingRows3Col(n: number): Record<string, unknown>[] {
	return Array.from({ length: n }, (_, i) => ({
		symbol_id: i + 1,
		vector: `vec_${i}`,
		chunk_text: `chunk_${i}`,
	}));
}

// ---------------------------------------------------------------------------
// SC-01: Large batch uses unnest strategy
// ---------------------------------------------------------------------------
describe('SC-01: large batch (100 rows) uses unnest', () => {
	it('generates INSERT ... SELECT unnest() for 100 rows', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows3Col(100),
		};

		const result = adapter.compileInsert(intent as any);

		// Must use unnest, not VALUES
		expect(result.sql).toContain('unnest(');
		expect(result.sql).not.toContain('VALUES');

		// 3 columns → 3 array parameters
		expect(result.parameters).toHaveLength(3);
		// Each parameter is an array of length 100
		expect((result.parameters[0] as unknown[]).length).toBe(100);
		expect((result.parameters[1] as unknown[]).length).toBe(100);
		expect((result.parameters[2] as unknown[]).length).toBe(100);
	});

	it('column arrays contain the correct values', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const rows = makeEmbeddingRows3Col(3).concat(
			makeEmbeddingRows3Col(97).map((r, i) => ({
				...r,
				symbol_id: (r.symbol_id as number) + 3,
			})),
		);
		// Use a fresh 100-row batch for value checking
		const rows100 = Array.from({ length: 100 }, (_, i) => ({
			symbol_id: i + 1,
			vector: `v${i}`,
			chunk_text: `c${i}`,
		}));
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: rows100,
		};
		const result = adapter.compileInsert(intent as any);

		// symbol_id column: [1..100]
		const symbolIds = result.parameters[0] as number[];
		expect(symbolIds[0]).toBe(1);
		expect(symbolIds[99]).toBe(100);

		// vector column: ['v0'..'v99']
		const vectors = result.parameters[1] as string[];
		expect(vectors[0]).toBe('v0');
		expect(vectors[99]).toBe('v99');
	});
});

// ---------------------------------------------------------------------------
// SC-02: Small batch uses VALUES strategy
// ---------------------------------------------------------------------------
describe('SC-02: small batch (3 rows) uses VALUES', () => {
	it('generates INSERT ... VALUES for 3 rows', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(3),
		};

		const result = adapter.compileInsert(intent as any);

		expect(result.sql).not.toContain('unnest(');
		// VALUES strategy: 3 rows × 2 cols = 6 scalar parameters
		expect(result.parameters).toHaveLength(6);
	});

	it('exactly at threshold (50 rows) still uses VALUES', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(50),
		};

		const result = adapter.compileInsert(intent as any);

		expect(result.sql).not.toContain('unnest(');
		// 50 rows × 2 cols = 100 scalar parameters
		expect(result.parameters).toHaveLength(100);
	});

	it('one row above threshold (51 rows) uses unnest', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(51),
		};

		const result = adapter.compileInsert(intent as any);

		expect(result.sql).toContain('unnest(');
		// 2 column arrays
		expect(result.parameters).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// SC-03: Unnest with RETURNING
// ---------------------------------------------------------------------------
describe('SC-03: unnest batch with RETURNING clause', () => {
	it('includes RETURNING in unnest SQL', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
			returning: ['id'],
		};

		const result = adapter.compileInsert(intent as any);

		expect(result.sql).toContain('unnest(');
		expect(result.sql).toContain('RETURNING');
		// Deparser outputs table-qualified column reference: "embeddings.id AS id"
		expect(result.sql.toLowerCase()).toContain('id');
	});

	it('returns correct parameter count with RETURNING', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
			returning: ['id', 'symbol_id'],
		};

		const result = adapter.compileInsert(intent as any);
		// 2 columns → 2 array parameters (RETURNING does not add params)
		expect(result.parameters).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// SC-04: Empty values array rejected (by InsertBuilder.buildIntent)
// ---------------------------------------------------------------------------
describe('SC-04: empty values array is rejected', () => {
	it('produces empty INSERT when values is empty (no crash)', () => {
		// Note: InsertBuilder.buildIntent() rejects empty via InvalidOperationError.
		// At the adapter level (compileInsert), empty values returns a no-op INSERT.
		// The guard is in the builder, not the adapter.
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: [],
		};
		// Adapter-level: does not throw, columns/values are empty
		const result = adapter.compileInsert(intent as any);
		expect(result.sql).toContain('INSERT');
	});
});

// ---------------------------------------------------------------------------
// SC-19: batchThreshold=0 forces unnest even for small batches
// ---------------------------------------------------------------------------
describe('SC-19: batchThreshold=0 forces unnest', () => {
	it('uses unnest for 2 rows when batchThreshold=0', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(2),
		};

		const result = adapter.compileInsert(intent as any, {
			batchThreshold: 0,
		});

		expect(result.sql).toContain('unnest(');
		expect(result.parameters).toHaveLength(2);
	});

	it('uses unnest for 1 row when batchThreshold=0', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: [{ symbol_id: 42, vector: 'abc' }],
		};

		const result = adapter.compileInsert(intent as any, {
			batchThreshold: 0,
		});

		expect(result.sql).toContain('unnest(');
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toEqual([42]);
		expect(result.parameters[1]).toEqual(['abc']);
	});
});

// ---------------------------------------------------------------------------
// maxBatchSize: throws InvalidOperationError when exceeded
// ---------------------------------------------------------------------------
describe('maxBatchSize guard', () => {
	it('throws when rows exceed maxBatchSize', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(200),
		};

		expect(() =>
			adapter.compileInsert(intent as any, { maxBatchSize: 100 }),
		).toThrow(InvalidOperationError);
	});

	it('error message includes batch size and limit', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(200),
		};

		expect(() =>
			adapter.compileInsert(intent as any, { maxBatchSize: 100 }),
		).toThrow(/200.*100|maxBatchSize/);
	});

	it('does not throw when rows equal maxBatchSize', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
		};

		expect(() =>
			adapter.compileInsert(intent as any, { maxBatchSize: 100 }),
		).not.toThrow();
	});

	it('does not throw when rows are below maxBatchSize', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(3),
		};

		expect(() =>
			adapter.compileInsert(intent as any, { maxBatchSize: 100 }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Custom batchThreshold
// ---------------------------------------------------------------------------
describe('custom batchThreshold option', () => {
	it('uses unnest when rows exceed custom threshold', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(11),
		};

		const result = adapter.compileInsert(intent as any, {
			batchThreshold: 10,
		});

		expect(result.sql).toContain('unnest(');
	});

	it('uses VALUES when rows are at custom threshold', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(10),
		};

		const result = adapter.compileInsert(intent as any, {
			batchThreshold: 10,
		});

		expect(result.sql).not.toContain('unnest(');
	});
});

// ---------------------------------------------------------------------------
// Type inference in SQL output
// The PostgreSQL deparser normalizes type casts to CAST($N AS type[]) syntax.
// ---------------------------------------------------------------------------
describe('type casting in unnest SQL', () => {
	it('integer column is cast to int4[]', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
		};

		const result = adapter.compileInsert(intent as any);
		// symbol_id is integer: deparser outputs CAST($1 AS int4[])
		expect(result.sql).toMatch(/CAST\(\$1 AS int4\[\]\)/);
	});

	it('string column is cast to text[]', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
		};

		const result = adapter.compileInsert(intent as any);
		// vector is string: deparser outputs CAST($2 AS text[])
		expect(result.sql).toMatch(/CAST\(\$2 AS text\[\]\)/);
	});

	it('boolean column is cast to bool[]', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'flags',
			values: Array.from({ length: 51 }, (_, i) => ({
				id: i,
				active: i % 2 === 0,
			})),
		};

		const result = adapter.compileInsert(intent as any);
		// deparser outputs CAST($2 AS bool[])
		expect(result.sql).toMatch(/CAST\(\$2 AS bool\[\]\)/);
	});

	it('float column is cast to float8[]', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		// Use 0.1 as the base to ensure non-integer samples (i * 0.5 = 0 when i=0)
		const intent = {
			type: 'insert' as const,
			table: 'metrics',
			values: Array.from({ length: 51 }, (_, i) => ({
				id: i,
				score: 0.1 + i * 0.5,
			})),
		};

		const result = adapter.compileInsert(intent as any);
		// deparser outputs CAST($2 AS float8[])
		expect(result.sql).toMatch(/CAST\(\$2 AS float8\[\]\)/);
	});
});

// ---------------------------------------------------------------------------
// SQL structure: table name and column names
// Note: default adapter uses 'preserve' casing — no forced quoting.
// ---------------------------------------------------------------------------
describe('SQL structure', () => {
	it('contains table and column names in SQL', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
		};

		const result = adapter.compileInsert(intent as any);
		expect(result.sql).toContain('embeddings');
		expect(result.sql).toContain('symbol_id');
		expect(result.sql).toContain('vector');
	});

	it('schema-scoped table uses schema prefix', () => {
		const adapter = createPgsqlCompileOnlyAdapter({
			schemaName: 'tenant_xyz',
		});
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
		};

		const result = adapter.compileInsert(intent as any);
		// Schema prefix appears (exact quoting format varies by casing/deparser version)
		expect(result.sql).toContain('tenant_xyz');
		expect(result.sql).toContain('embeddings');
	});

	it('schema from compile options is used', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = {
			type: 'insert' as const,
			table: 'embeddings',
			values: makeEmbeddingRows(100),
		};

		const result = adapter.compileInsert(intent as any, {
			schemaName: 'opt_schema',
		});
		expect(result.sql).toContain('opt_schema');
		expect(result.sql).toContain('embeddings');
	});
});
