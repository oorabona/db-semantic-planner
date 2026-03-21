/**
 * DELETE-NOTEXISTS-ALIAS regression test.
 *
 * Bug: notExists(relation) in DELETE WHERE used the relation name as table
 * name in the subquery instead of the real DB table name.
 *
 * Fix: compileDelete() calls resolveExistsIntent() to look up
 * sourceTable.relation in ModelIR; normalizeToDecision() prefers explicit
 * targetTable over the fallback relation name.
 */

import { exists, notExists } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import type { ModelIR } from '@dbsp/types';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

function buildModel(source: string, name: string, target: string, foreignKey?: string): ModelIR {
	const rel = {
		name, type: "belongsTo" as const, source, target,
		cardinality: "many-to-one" as const, optionality: "optional" as const,
		includeStrategy: "auto" as const, filterStrategy: "auto" as const,
		joinDefault: "auto" as const,
		...(foreignKey !== undefined && { foreignKey }),
	};
	const relations = new Map([[source + "." + name, rel]]);
	return {
		tables: new Map(), relations,
		getTable: () => undefined,
		getRelation: (qname: string) => relations.get(qname),
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false }),
	} as unknown as ModelIR;
}

describe('DELETE-NOTEXISTS-ALIAS: relation resolved to real table via ModelIR', () => {
	it('resolves relation to DB table name in NOT EXISTS subquery', () => {
		const model = buildModel('embeddings', 'symbol', 'symbols');
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbol'),
		});

		// Must use the real table name 'symbols', not the relation name 'symbol'
		expect(sql).toContain('symbols');
		// alias check covered by toContain above;
		expect(sql).toMatch(/NOT.*EXISTS/i);
	});

	it('resolves table with RETURNING clause', () => {
		const model = buildModel('embeddings', 'symbol', 'symbols');
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbol'),
			returning: ['id'] as readonly string[],
		});

		expect(sql).toContain('symbols');
		expect(sql).toMatch(/NOT.*EXISTS/i);
		expect(sql).toMatch(/RETURNING/i);
	});

	it('resolves exists() (not just notExists()) via ModelIR', () => {
		const model = buildModel('posts', 'comments', 'post_comments');
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'posts',
			where: exists('comments'),
		});

		expect(sql).toContain('post_comments');
		expect(sql).toContain('EXISTS');
		expect(sql).not.toMatch(/NOT.*EXISTS/i);
	});

	it('falls back to relation name when no ModelIR available', () => {
		const adapter = createPgsqlCompileOnlyAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbols'),
		});

		expect(sql).toMatch(/NOT.*EXISTS/i);
		expect(sql).toMatch(/symbols/i);
	});

	it('resolves FK column from belongsTo relation (symbol_id not embedding_id)', () => {
		// Regression: without FK resolution, buildExistsSubquery defaulted to
		// deriveFk('embeddings', 'id') = 'embedding_id' on the target side, generating
		// WHERE embeddings.id = symbols_exists_0.embedding_id (wrong).
		// With FK resolution, it uses: WHERE embeddings.symbol_id = symbols_exists_0.id (correct).
		const model = buildModel('embeddings', 'symbol', 'symbols', 'symbol_id');
		const adapter = createPgsqlCompileOnlyAdapter({ model });

		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'embeddings',
			where: notExists('symbol'),
			returning: ['id'] as readonly string[],
		});

		expect(sql).toContain('symbols');
		expect(sql).toMatch(/NOT.*EXISTS/i);
		// Must correlate via symbol_id (FK on embeddings side), NOT embedding_id
		expect(sql).toContain('symbol_id');
		expect(sql).not.toContain('embedding_id');
	});
});