/**
 * DDL Table Operations tests — exact SQL matching (toEqual, not toContain).
 * Covers all BDD scenarios from FR-1.md.
 */

import { describe, expect, it } from 'vitest';
import {
	generateCreateIndexSQL,
	generateDropIndexSQL,
} from '../ddl/index-operations.js';
import {
	generateAlterColumnSQL,
	generateTruncateSQL,
	generateVacuumSQL,
} from '../ddl/table-operations.js';

// ===========================================================================
// TRUNCATE
// ===========================================================================

describe('generateTruncateSQL', () => {
	it('basic truncate', () => {
		expect(generateTruncateSQL('embeddings')).toEqual('TRUNCATE "embeddings"');
	});

	it('truncate with cascade', () => {
		expect(
			generateTruncateSQL('embeddings', undefined, { cascade: true }),
		).toEqual('TRUNCATE "embeddings" CASCADE');
	});

	it('truncate with restart identity', () => {
		expect(
			generateTruncateSQL('embeddings', undefined, { restartIdentity: true }),
		).toEqual('TRUNCATE "embeddings" RESTART IDENTITY');
	});

	it('truncate with both cascade and restart identity', () => {
		expect(
			generateTruncateSQL('embeddings', undefined, {
				cascade: true,
				restartIdentity: true,
			}),
		).toEqual('TRUNCATE "embeddings" RESTART IDENTITY CASCADE');
	});

	it('truncate with schema scope', () => {
		expect(generateTruncateSQL('embeddings', 'tenant_42')).toEqual(
			'TRUNCATE "tenant_42"."embeddings"',
		);
	});

	it('schema-scoped truncate with cascade', () => {
		expect(
			generateTruncateSQL('embeddings', 'tenant_42', { cascade: true }),
		).toEqual('TRUNCATE "tenant_42"."embeddings" CASCADE');
	});

	it('quotes identifiers with embedded double-quotes', () => {
		expect(generateTruncateSQL('my"table')).toEqual('TRUNCATE "my""table"');
	});
});

// ===========================================================================
// VACUUM
// ===========================================================================

describe('generateVacuumSQL', () => {
	it('basic vacuum', () => {
		expect(generateVacuumSQL('embeddings')).toEqual('VACUUM "embeddings"');
	});

	it('vacuum full', () => {
		expect(generateVacuumSQL('embeddings', undefined, { full: true })).toEqual(
			'VACUUM FULL "embeddings"',
		);
	});

	it('vacuum analyze', () => {
		expect(
			generateVacuumSQL('embeddings', undefined, { analyze: true }),
		).toEqual('VACUUM ANALYZE "embeddings"');
	});

	it('vacuum full analyze', () => {
		expect(
			generateVacuumSQL('embeddings', undefined, { full: true, analyze: true }),
		).toEqual('VACUUM FULL ANALYZE "embeddings"');
	});

	it('ignores schema (PostgreSQL VACUUM does not support schema-qualified names)', () => {
		// VACUUM only takes the bare table name regardless of schema
		expect(generateVacuumSQL('embeddings', 'tenant_42')).toEqual(
			'VACUUM "embeddings"',
		);
	});
});

// ===========================================================================
// ALTER COLUMN
// ===========================================================================

describe('generateAlterColumnSQL', () => {
	it('alter column type', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'vector', { type: 'vector(384)' }),
		).toEqual(
			'ALTER TABLE "embeddings" ALTER COLUMN "vector" TYPE vector(384)',
		);
	});

	it('alter column type with USING', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'vector', {
				type: 'vector(384)',
				using: 'vector::vector(384)',
			}),
		).toEqual(
			'ALTER TABLE "embeddings" ALTER COLUMN "vector" TYPE vector(384) USING vector::vector(384)',
		);
	});

	it('alter column set not null', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'model', { setNotNull: true }),
		).toEqual('ALTER TABLE "embeddings" ALTER COLUMN "model" SET NOT NULL');
	});

	it('alter column drop not null', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'model', { setNotNull: false }),
		).toEqual('ALTER TABLE "embeddings" ALTER COLUMN "model" DROP NOT NULL');
	});

	it('alter column drop default', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'model', { dropDefault: true }),
		).toEqual('ALTER TABLE "embeddings" ALTER COLUMN "model" DROP DEFAULT');
	});

	it('alter column set default string', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'status', { setDefault: 'active' }),
		).toEqual(
			'ALTER TABLE "embeddings" ALTER COLUMN "status" SET DEFAULT \'active\'',
		);
	});

	it('alter column set default number', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'score', { setDefault: 0 }),
		).toEqual('ALTER TABLE "embeddings" ALTER COLUMN "score" SET DEFAULT 0');
	});

	it('alter column set default null', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'score', { setDefault: null }),
		).toEqual('ALTER TABLE "embeddings" ALTER COLUMN "score" SET DEFAULT NULL');
	});

	it('alter column with schema scope', () => {
		expect(
			generateAlterColumnSQL(
				'embeddings',
				'vector',
				{ type: 'vector(384)' },
				'tenant_42',
			),
		).toEqual(
			'ALTER TABLE "tenant_42"."embeddings" ALTER COLUMN "vector" TYPE vector(384)',
		);
	});

	it('multiple clauses produce multiple statements joined by semicolon', () => {
		const sql = generateAlterColumnSQL('embeddings', 'vector', {
			type: 'vector(384)',
			setNotNull: true,
		});
		expect(sql).toEqual(
			'ALTER TABLE "embeddings" ALTER COLUMN "vector" TYPE vector(384);\n' +
				'ALTER TABLE "embeddings" ALTER COLUMN "vector" SET NOT NULL',
		);
	});

	it('throws when no options specified', () => {
		expect(() => generateAlterColumnSQL('embeddings', 'vector', {})).toThrow(
			'generateAlterColumnSQL: at least one option must be specified',
		);
	});

	it('rejects unsafe type names', () => {
		expect(() =>
			generateAlterColumnSQL('embeddings', 'vector', {
				type: "'; DROP TABLE users; --",
			}),
		).toThrow();
	});
});

// ===========================================================================
// CREATE INDEX
// ===========================================================================

describe('generateCreateIndexSQL', () => {
	it('basic index', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_model',
				columns: ['model'],
			}),
		).toEqual('CREATE INDEX "idx_model" ON "embeddings" ("model")');
	});

	it('HNSW index with opclass and WITH params', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_vec',
				columns: ['vector'],
				method: 'hnsw',
				opclass: { vector: 'vector_cosine_ops' },
				with: { m: 16, ef_construction: 64 },
			}),
		).toEqual(
			'CREATE INDEX "idx_vec" ON "embeddings" USING hnsw ("vector" vector_cosine_ops) WITH (m = 16, ef_construction = 64)',
		);
	});

	it('unique index', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_uniq',
				columns: ['model', 'symbol_id'],
				unique: true,
			}),
		).toEqual(
			'CREATE UNIQUE INDEX "idx_uniq" ON "embeddings" ("model", "symbol_id")',
		);
	});

	it('partial index with WHERE clause', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_active',
				columns: ['status'],
				where: "status = 'active'",
			}),
		).toEqual(
			'CREATE INDEX "idx_active" ON "embeddings" ("status") WHERE status = \'active\'',
		);
	});

	it('create index CONCURRENTLY', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_conc',
				columns: ['model'],
				concurrently: true,
			}),
		).toEqual('CREATE INDEX CONCURRENTLY "idx_conc" ON "embeddings" ("model")');
	});

	it('create index IF NOT EXISTS', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_safe',
				columns: ['model'],
				ifNotExists: true,
			}),
		).toEqual(
			'CREATE INDEX IF NOT EXISTS "idx_safe" ON "embeddings" ("model")',
		);
	});

	it('create unique index CONCURRENTLY IF NOT EXISTS', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_all',
				columns: ['model'],
				unique: true,
				concurrently: true,
				ifNotExists: true,
			}),
		).toEqual(
			'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_all" ON "embeddings" ("model")',
		);
	});

	it('index with schema scope', () => {
		expect(
			generateCreateIndexSQL(
				'embeddings',
				{ name: 'idx_t', columns: ['model'] },
				'tenant_42',
			),
		).toEqual('CREATE INDEX "idx_t" ON "tenant_42"."embeddings" ("model")');
	});

	it('covering index with INCLUDE', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_cover',
				columns: ['model'],
				include: ['symbol_id', 'vector'],
			}),
		).toEqual(
			'CREATE INDEX "idx_cover" ON "embeddings" ("model") INCLUDE ("symbol_id", "vector")',
		);
	});

	it('expression index', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_lower',
				columns: [{ expression: 'lower(name)' }],
			}),
		).toEqual('CREATE INDEX "idx_lower" ON "embeddings" (lower(name))');
	});

	it('expression index with opclass', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_expr_op',
				columns: [{ expression: 'lower(email)', opclass: 'text_pattern_ops' }],
			}),
		).toEqual(
			'CREATE INDEX "idx_expr_op" ON "embeddings" (lower(email) text_pattern_ops)',
		);
	});

	it('multi-column index with per-column opclass', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_multi',
				columns: ['a', 'b'],
				opclass: { a: 'text_pattern_ops', b: 'varchar_ops' },
			}),
		).toEqual(
			'CREATE INDEX "idx_multi" ON "embeddings" ("a" text_pattern_ops, "b" varchar_ops)',
		);
	});

	it('BM25 index method', () => {
		expect(
			generateCreateIndexSQL('embeddings', {
				name: 'idx_bm25',
				columns: ['content'],
				method: 'bm25',
			}),
		).toEqual('CREATE INDEX "idx_bm25" ON "embeddings" USING bm25 ("content")');
	});

	it('rejects invalid index method', () => {
		expect(() =>
			generateCreateIndexSQL('embeddings', {
				name: 'idx_x',
				columns: ['y'],
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
				method: 'invalid' as any,
			}),
		).toThrow('Invalid index method');
	});
});

// ===========================================================================
// DROP INDEX
// ===========================================================================

describe('generateDropIndexSQL', () => {
	it('basic drop', () => {
		expect(generateDropIndexSQL('idx_vec')).toEqual('DROP INDEX "idx_vec"');
	});

	it('drop if exists', () => {
		expect(generateDropIndexSQL('idx_vec', { ifExists: true })).toEqual(
			'DROP INDEX IF EXISTS "idx_vec"',
		);
	});

	it('drop with cascade', () => {
		expect(generateDropIndexSQL('idx_vec', { cascade: true })).toEqual(
			'DROP INDEX "idx_vec" CASCADE',
		);
	});

	it('drop if exists with cascade', () => {
		expect(
			generateDropIndexSQL('idx_vec', { ifExists: true, cascade: true }),
		).toEqual('DROP INDEX IF EXISTS "idx_vec" CASCADE');
	});

	it('drop concurrently', () => {
		expect(generateDropIndexSQL('idx_vec', { concurrently: true })).toEqual(
			'DROP INDEX CONCURRENTLY "idx_vec"',
		);
	});

	it('drop with schema (global orm.ddl.dropIndex)', () => {
		expect(
			generateDropIndexSQL('idx_name', { ifExists: true, schema: 'tenant_42' }),
		).toEqual('DROP INDEX IF EXISTS "tenant_42"."idx_name"');
	});

	it('quotes index name with embedded double-quotes', () => {
		expect(generateDropIndexSQL('my"index')).toEqual('DROP INDEX "my""index"');
	});
});
