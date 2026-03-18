/**
 * Batch UPSERT via unnest tests — BATCH-001 Block 4
 *
 * Verifies the compilation strategy switch for upsert:
 * - rows <= batchThreshold (default 50) → VALUES ($1,$2),...  ON CONFLICT ...
 * - rows > batchThreshold OR batchThreshold === 0 → SELECT unnest(...) ON CONFLICT ...
 */

import { InvalidOperationError } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EmbeddingRow = {
	symbol_id: number;
	chunk_index: number;
	vector: string;
	chunk_text: string;
};

function makeEmbeddingRows(n: number): EmbeddingRow[] {
	return Array.from({ length: n }, (_, i) => ({
		symbol_id: i + 1,
		chunk_index: i,
		vector: `vec_${i}`,
		chunk_text: `chunk_${i}`,
	}));
}

type SimpleRow = {
	symbol_id: number;
	vector: string;
};

function makeSimpleRows(n: number): SimpleRow[] {
	return Array.from({ length: n }, (_, i) => ({
		symbol_id: i + 1,
		vector: `vec_${i}`,
	}));
}

function makeUpsertIntent(
	values: Record<string, unknown>[],
	conflictColumns: string[],
	action: 'doUpdate' | 'doNothing' = 'doUpdate',
	updateColumns?: string[],
	returning?: string[],
) {
	const intent: Record<string, unknown> = {
		type: 'upsert',
		table: 'embeddings',
		values,
		onConflict: { columns: conflictColumns },
		action:
			action === 'doNothing'
				? { type: 'doNothing' }
				: {
						type: 'doUpdate',
						// No explicit set → adapter auto-updates non-conflict columns
						...(updateColumns
							? {
									set: Object.fromEntries(
										updateColumns.map((col) => [col, null]),
									),
								}
							: {}),
					},
	};
	if (returning) intent.returning = returning;
	return intent;
}

// ---------------------------------------------------------------------------
// SC-12: Large batch upsert uses unnest
// ---------------------------------------------------------------------------
describe('SC-12: large batch upsert (100 rows) uses unnest strategy', () => {
	it('generates INSERT ... SELECT unnest() ON CONFLICT DO UPDATE for 100 rows', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeEmbeddingRows(100) as unknown as Record<string, unknown>[],
			['symbol_id', 'chunk_index'],
		);

		const result = adapter.compileUpsert(intent as any);

		// Must use unnest strategy, not VALUES
		expect(result.sql).toContain('unnest(');
		expect(result.sql).not.toContain('VALUES');

		// Must include ON CONFLICT clause
		expect(result.sql).toContain('ON CONFLICT');
		expect(result.sql).toContain('DO UPDATE SET');

		// 4 columns → 4 array parameters
		expect(result.parameters).toHaveLength(4);

		// Each parameter is an array of length 100
		for (const param of result.parameters) {
			expect((param as unknown[]).length).toBe(100);
		}
	});

	it('column arrays contain correct values', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const rows = makeEmbeddingRows(100) as unknown as Record<string, unknown>[];
		const intent = makeUpsertIntent(rows, ['symbol_id', 'chunk_index']);

		const result = adapter.compileUpsert(intent as any);

		const symbolIds = result.parameters[0] as number[];
		const chunkIndexes = result.parameters[1] as number[];
		const vectors = result.parameters[2] as string[];
		const chunkTexts = result.parameters[3] as string[];

		expect(symbolIds[0]).toBe(1);
		expect(symbolIds[99]).toBe(100);
		expect(chunkIndexes[0]).toBe(0);
		expect(chunkIndexes[99]).toBe(99);
		expect(vectors[0]).toBe('vec_0');
		expect(vectors[99]).toBe('vec_99');
		expect(chunkTexts[0]).toBe('chunk_0');
		expect(chunkTexts[99]).toBe('chunk_99');
	});

	it('conflict columns appear in ON CONFLICT clause', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeEmbeddingRows(100) as unknown as Record<string, unknown>[],
			['symbol_id', 'chunk_index'],
		);

		const result = adapter.compileUpsert(intent as any);

		expect(result.sql).toContain('symbol_id');
		expect(result.sql).toContain('chunk_index');
	});

	it('EXCLUDED references appear in DO UPDATE SET', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(100) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any);

		// DO UPDATE SET "vector" = "excluded"."vector"
		expect(result.sql).toContain('excluded');
	});
});

// ---------------------------------------------------------------------------
// SC-13: Batch upsert preserves conflict handling — DO NOTHING
// ---------------------------------------------------------------------------
describe('SC-13: batch upsert preserves conflict handling', () => {
	it('generates ON CONFLICT DO NOTHING with unnest for 100 rows', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(100) as unknown as Record<string, unknown>[],
			['symbol_id'],
			'doNothing',
		);

		const result = adapter.compileUpsert(intent as any);

		expect(result.sql).toContain('unnest(');
		expect(result.sql).not.toContain('VALUES');
		expect(result.sql).toContain('ON CONFLICT');
		expect(result.sql).toContain('DO NOTHING');
		expect(result.sql).not.toContain('DO UPDATE');
	});

	it('DO NOTHING uses 2 column arrays for 2-column table', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(100) as unknown as Record<string, unknown>[],
			['symbol_id'],
			'doNothing',
		);

		const result = adapter.compileUpsert(intent as any);

		expect(result.parameters).toHaveLength(2);
		expect((result.parameters[0] as unknown[]).length).toBe(100);
		expect((result.parameters[1] as unknown[]).length).toBe(100);
	});
});

// ---------------------------------------------------------------------------
// Small batch uses VALUES (below threshold)
// ---------------------------------------------------------------------------
describe('small batch upsert uses VALUES strategy', () => {
	it('generates INSERT ... VALUES for 3 rows', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(3) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any);

		expect(result.sql).not.toContain('unnest(');
		// VALUES strategy: 3 rows × 2 cols = 6 scalar parameters
		expect(result.parameters).toHaveLength(6);
		expect(result.sql).toContain('ON CONFLICT');
	});

	it('exactly at threshold (50 rows) still uses VALUES', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(50) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any);

		expect(result.sql).not.toContain('unnest(');
		// 50 rows × 2 cols = 100 scalar parameters
		expect(result.parameters).toHaveLength(100);
	});

	it('one row above threshold (51 rows) uses unnest', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(51) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any);

		expect(result.sql).toContain('unnest(');
		// 2 column arrays
		expect(result.parameters).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// batchThreshold=0 forces unnest even for small batches
// ---------------------------------------------------------------------------
describe('batchThreshold=0 forces unnest for upsert', () => {
	it('uses unnest for 2 rows when batchThreshold=0', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(2) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any, {
			batchThreshold: 0,
		});

		expect(result.sql).toContain('unnest(');
		expect(result.parameters).toHaveLength(2);
	});

	it('uses unnest for 1 row when batchThreshold=0', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			[{ symbol_id: 42, vector: 'abc' }],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any, {
			batchThreshold: 0,
		});

		expect(result.sql).toContain('unnest(');
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toEqual([42]);
		expect(result.parameters[1]).toEqual(['abc']);
	});
});

// ---------------------------------------------------------------------------
// RETURNING works with unnest upsert
// ---------------------------------------------------------------------------
describe('RETURNING clause with unnest upsert', () => {
	it('includes RETURNING when specified with unnest strategy', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent: Record<string, unknown> = {
			type: 'upsert',
			table: 'embeddings',
			values: makeSimpleRows(100),
			onConflict: { columns: ['symbol_id'] },
			action: { type: 'doUpdate' },
			returning: ['symbol_id', 'vector'],
		};

		const result = adapter.compileUpsert(intent as any);

		expect(result.sql).toContain('unnest(');
		expect(result.sql).toContain('RETURNING');
		// 2 column arrays (RETURNING does not add params)
		expect(result.parameters).toHaveLength(2);
	});

	it('RETURNING does not add extra parameters', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent: Record<string, unknown> = {
			type: 'upsert',
			table: 'embeddings',
			values: makeEmbeddingRows(100),
			onConflict: { columns: ['symbol_id', 'chunk_index'] },
			action: { type: 'doUpdate' },
			returning: ['symbol_id', 'vector', 'chunk_text'],
		};

		const result = adapter.compileUpsert(intent as any);

		expect(result.sql).toContain('unnest(');
		// 4 column arrays (not 7)
		expect(result.parameters).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// maxBatchSize guard
// ---------------------------------------------------------------------------
describe('maxBatchSize guard for upsert', () => {
	it('throws InvalidOperationError when rows exceed maxBatchSize', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(200) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		expect(() =>
			adapter.compileUpsert(intent as any, { maxBatchSize: 100 }),
		).toThrow(InvalidOperationError);
	});

	it('error message includes batch size and limit', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(200) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		expect(() =>
			adapter.compileUpsert(intent as any, { maxBatchSize: 100 }),
		).toThrow(/200.*100|maxBatchSize/);
	});

	it('does not throw when rows equal maxBatchSize', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(100) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		expect(() =>
			adapter.compileUpsert(intent as any, { maxBatchSize: 100 }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Custom batchThreshold
// ---------------------------------------------------------------------------
describe('custom batchThreshold for upsert', () => {
	it('uses unnest when rows exceed custom threshold', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(11) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any, {
			batchThreshold: 10,
		});

		expect(result.sql).toContain('unnest(');
	});

	it('uses VALUES when rows are at custom threshold', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const intent = makeUpsertIntent(
			makeSimpleRows(10) as unknown as Record<string, unknown>[],
			['symbol_id'],
		);

		const result = adapter.compileUpsert(intent as any, {
			batchThreshold: 10,
		});

		expect(result.sql).not.toContain('unnest(');
		// 10 rows × 2 cols = 20 scalar parameters
		expect(result.parameters).toHaveLength(20);
	});
});
