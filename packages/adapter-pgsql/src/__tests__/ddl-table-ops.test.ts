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
		expect(generateTruncateSQL('embeddings', 'public')).toEqual(
			'TRUNCATE "public"."embeddings"',
		);
	});

	it('truncate with cascade', () => {
		expect(
			generateTruncateSQL('embeddings', 'public', { cascade: true }),
		).toEqual('TRUNCATE "public"."embeddings" CASCADE');
	});

	it('truncate with restart identity', () => {
		expect(
			generateTruncateSQL('embeddings', 'public', { restartIdentity: true }),
		).toEqual('TRUNCATE "public"."embeddings" RESTART IDENTITY');
	});

	it('truncate with both cascade and restart identity', () => {
		expect(
			generateTruncateSQL('embeddings', 'public', {
				cascade: true,
				restartIdentity: true,
			}),
		).toEqual('TRUNCATE "public"."embeddings" RESTART IDENTITY CASCADE');
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

	it('rejects identifiers with embedded double-quotes (security: validateIdentifier)', () => {
		// S-2: validateIdentifier now rejects double-quotes in identifiers to prevent injection.
		// PostgreSQL table names with embedded double-quotes are rejected at the API boundary.
		expect(() => generateTruncateSQL('my"table', 'public')).toThrow(
			/Invalid.*identifier/i,
		);
	});

	it('throws before SQL generation when schema is missing or empty', () => {
		expect(() => generateTruncateSQL('embeddings', '')).toThrow(
			/Invalid.*schema.*identifier/i,
		);
		expect(() => generateTruncateSQL('embeddings', undefined as never)).toThrow(
			/Invalid schema identifier/i,
		);
	});
});

// ===========================================================================
// VACUUM
// ===========================================================================

describe('generateVacuumSQL', () => {
	it('basic vacuum', () => {
		expect(generateVacuumSQL('embeddings', 'public')).toEqual(
			'VACUUM "public"."embeddings"',
		);
	});

	it('vacuum full', () => {
		expect(generateVacuumSQL('embeddings', 'public', { full: true })).toEqual(
			'VACUUM FULL "public"."embeddings"',
		);
	});

	it('vacuum analyze', () => {
		expect(
			generateVacuumSQL('embeddings', 'public', { analyze: true }),
		).toEqual('VACUUM ANALYZE "public"."embeddings"');
	});

	it('vacuum full analyze', () => {
		expect(
			generateVacuumSQL('embeddings', 'public', { full: true, analyze: true }),
		).toEqual('VACUUM FULL ANALYZE "public"."embeddings"');
	});

	it('schema-qualifies the table', () => {
		// PostgreSQL VACUUM accepts an optionally schema-qualified table name.
		expect(generateVacuumSQL('embeddings', 'tenant_42')).toEqual(
			'VACUUM "tenant_42"."embeddings"',
		);
	});

	it('throws before SQL generation when schema is missing or empty', () => {
		expect(() => generateVacuumSQL('embeddings', '')).toThrow(
			/Invalid.*schema.*identifier/i,
		);
		expect(() => generateVacuumSQL('embeddings', undefined as never)).toThrow(
			/Invalid schema identifier/i,
		);
	});
});

// ===========================================================================
// ALTER COLUMN
// ===========================================================================

describe('generateAlterColumnSQL', () => {
	it('alter column type', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'vector', {
				type: 'vector(384)',
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "vector" TYPE vector(384)',
		);
	});

	it('alter column type with USING', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'vector', {
				type: 'vector(384)',
				using: 'vector::vector(384)',
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "vector" TYPE vector(384) USING vector::vector(384)',
		);
	});

	it('alter column set not null', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'model', {
				setNotNull: true,
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "model" SET NOT NULL',
		);
	});

	it('alter column drop not null', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'model', {
				setNotNull: false,
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "model" DROP NOT NULL',
		);
	});

	it('alter column drop default', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'model', {
				dropDefault: true,
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "model" DROP DEFAULT',
		);
	});

	it('alter column set default string', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'status', {
				setDefault: 'active',
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "status" SET DEFAULT \'active\'',
		);
	});

	it('alter column set default number', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'score', {
				setDefault: 0,
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "score" SET DEFAULT 0',
		);
	});

	it('alter column set default null', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'public', 'score', {
				setDefault: null,
			}),
		).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "score" SET DEFAULT NULL',
		);
	});

	it('alter column with schema scope', () => {
		expect(
			generateAlterColumnSQL('embeddings', 'tenant_42', 'vector', {
				type: 'vector(384)',
			}),
		).toEqual(
			'ALTER TABLE "tenant_42"."embeddings" ALTER COLUMN "vector" TYPE vector(384)',
		);
	});

	it('multiple clauses produce multiple statements joined by semicolon', () => {
		const sql = generateAlterColumnSQL('embeddings', 'public', 'vector', {
			type: 'vector(384)',
			setNotNull: true,
		});
		expect(sql).toEqual(
			'ALTER TABLE "public"."embeddings" ALTER COLUMN "vector" TYPE vector(384);\n' +
				'ALTER TABLE "public"."embeddings" ALTER COLUMN "vector" SET NOT NULL',
		);
	});

	it('throws when no options specified', () => {
		expect(() =>
			generateAlterColumnSQL('embeddings', 'public', 'vector', {}),
		).toThrow('generateAlterColumnSQL: at least one option must be specified');
	});

	it('rejects unsafe type names', () => {
		expect(() =>
			generateAlterColumnSQL('embeddings', 'public', 'vector', {
				type: "'; DROP TABLE users; --",
			}),
		).toThrow();
	});

	it('throws before SQL generation when schema is missing or empty', () => {
		expect(() =>
			generateAlterColumnSQL('embeddings', '', 'vector', {
				type: 'text',
			}),
		).toThrow(/Invalid.*schema.*identifier/i);
		expect(() =>
			generateAlterColumnSQL('embeddings', undefined as never, 'vector', {
				type: 'text',
			}),
		).toThrow(/Invalid schema identifier/i);
	});
});

// ===========================================================================
// CREATE INDEX
// ===========================================================================

describe('generateCreateIndexSQL', () => {
	it('basic index', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_model',
				columns: ['model'],
			}),
		).toEqual('CREATE INDEX "idx_model" ON "public"."embeddings" ("model")');
	});

	it('HNSW index with opclass and WITH params', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_vec',
				columns: ['vector'],
				method: 'hnsw',
				opclass: { vector: 'vector_cosine_ops' },
				with: { m: 16, ef_construction: 64 },
			}),
		).toEqual(
			'CREATE INDEX "idx_vec" ON "public"."embeddings" USING hnsw ("vector" vector_cosine_ops) WITH (m = 16, ef_construction = 64)',
		);
	});

	it('unique index', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_uniq',
				columns: ['model', 'symbol_id'],
				unique: true,
			}),
		).toEqual(
			'CREATE UNIQUE INDEX "idx_uniq" ON "public"."embeddings" ("model", "symbol_id")',
		);
	});

	it('unique index with NULLS NOT DISTINCT', () => {
		expect(
			generateCreateIndexSQL('users', 'public', {
				name: 'uk_users_email_nulls',
				columns: ['email'],
				unique: true,
				nullsNotDistinct: true,
			}),
		).toEqual(
			'CREATE UNIQUE INDEX "uk_users_email_nulls" ON "public"."users" ("email") NULLS NOT DISTINCT',
		);
	});

	it('partial index with WHERE clause', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_active',
				columns: ['status'],
				where: "status = 'active'",
			}),
		).toEqual(
			'CREATE INDEX "idx_active" ON "public"."embeddings" ("status") WHERE status = \'active\'',
		);
	});

	it('create index CONCURRENTLY', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_conc',
				columns: ['model'],
				concurrently: true,
			}),
		).toEqual(
			'CREATE INDEX CONCURRENTLY "idx_conc" ON "public"."embeddings" ("model")',
		);
	});

	it('create index IF NOT EXISTS', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_safe',
				columns: ['model'],
				ifNotExists: true,
			}),
		).toEqual(
			'CREATE INDEX IF NOT EXISTS "idx_safe" ON "public"."embeddings" ("model")',
		);
	});

	it('create unique index CONCURRENTLY IF NOT EXISTS', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_all',
				columns: ['model'],
				unique: true,
				concurrently: true,
				ifNotExists: true,
			}),
		).toEqual(
			'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_all" ON "public"."embeddings" ("model")',
		);
	});

	it('index with schema scope', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'tenant_42', {
				name: 'idx_t',
				columns: ['model'],
			}),
		).toEqual('CREATE INDEX "idx_t" ON "tenant_42"."embeddings" ("model")');
	});

	it('covering index with INCLUDE', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_cover',
				columns: ['model'],
				include: ['symbol_id', 'vector'],
			}),
		).toEqual(
			'CREATE INDEX "idx_cover" ON "public"."embeddings" ("model") INCLUDE ("symbol_id", "vector")',
		);
	});

	it('unique NULLS NOT DISTINCT covering index places INCLUDE first', () => {
		expect(
			generateCreateIndexSQL('users', 'public', {
				name: 'uk_users_email_nulls_cover',
				columns: ['email'],
				unique: true,
				nullsNotDistinct: true,
				include: ['id'],
			}),
		).toEqual(
			'CREATE UNIQUE INDEX "uk_users_email_nulls_cover" ON "public"."users" ("email") INCLUDE ("id") NULLS NOT DISTINCT',
		);
	});

	it('expression index', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_lower',
				columns: [{ expression: 'lower(name)' }],
			}),
		).toEqual(
			'CREATE INDEX "idx_lower" ON "public"."embeddings" (lower(name))',
		);
	});

	it('expression index with opclass', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_expr_op',
				columns: [{ expression: 'lower(email)', opclass: 'text_pattern_ops' }],
			}),
		).toEqual(
			'CREATE INDEX "idx_expr_op" ON "public"."embeddings" (lower(email) text_pattern_ops)',
		);
	});

	it('multi-column index with per-column opclass', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_multi',
				columns: ['a', 'b'],
				opclass: { a: 'text_pattern_ops', b: 'varchar_ops' },
			}),
		).toEqual(
			'CREATE INDEX "idx_multi" ON "public"."embeddings" ("a" text_pattern_ops, "b" varchar_ops)',
		);
	});

	it('BM25 index method', () => {
		expect(
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_bm25',
				columns: ['content'],
				method: 'bm25',
			}),
		).toEqual(
			'CREATE INDEX "idx_bm25" ON "public"."embeddings" USING bm25 ("content")',
		);
	});

	it('rejects invalid index method', () => {
		expect(() =>
			generateCreateIndexSQL('embeddings', 'public', {
				name: 'idx_x',
				columns: ['y'],
				method: 'invalid' as any,
			}),
		).toThrow('Invalid index method');
	});

	it('throws before SQL generation when schema is missing or empty', () => {
		expect(() =>
			generateCreateIndexSQL('embeddings', '', {
				name: 'idx_model',
				columns: ['model'],
			}),
		).toThrow(/Invalid.*schema.*identifier/i);
		expect(() =>
			generateCreateIndexSQL('embeddings', undefined as never, {
				name: 'idx_model',
				columns: ['model'],
			}),
		).toThrow(/Invalid schema identifier/i);
	});
});

// ===========================================================================
// DROP INDEX
// ===========================================================================

const dropIndexSchemaTypeLocks = () => {
	// @ts-expect-error schemaName is required; options cannot occupy argument 2.
	generateDropIndexSQL('idx_vec', { ifExists: true });
	// @ts-expect-error schemaName is required.
	generateDropIndexSQL('idx_vec');
};
void dropIndexSchemaTypeLocks;

describe('generateDropIndexSQL', () => {
	it('basic drop', () => {
		expect(generateDropIndexSQL('idx_vec', 'public')).toEqual(
			'DROP INDEX "public"."idx_vec"',
		);
	});

	it('drop if exists', () => {
		expect(
			generateDropIndexSQL('idx_vec', 'public', { ifExists: true }),
		).toEqual('DROP INDEX IF EXISTS "public"."idx_vec"');
	});

	it('drop with cascade', () => {
		expect(
			generateDropIndexSQL('idx_vec', 'public', { cascade: true }),
		).toEqual('DROP INDEX "public"."idx_vec" CASCADE');
	});

	it('drop if exists with cascade', () => {
		expect(
			generateDropIndexSQL('idx_vec', 'public', {
				ifExists: true,
				cascade: true,
			}),
		).toEqual('DROP INDEX IF EXISTS "public"."idx_vec" CASCADE');
	});

	it('drop concurrently', () => {
		expect(
			generateDropIndexSQL('idx_vec', 'public', { concurrently: true }),
		).toEqual('DROP INDEX CONCURRENTLY "public"."idx_vec"');
	});

	it('drop with schema (global orm.ddl.dropIndex)', () => {
		expect(
			generateDropIndexSQL('idx_name', 'tenant_42', { ifExists: true }),
		).toEqual('DROP INDEX IF EXISTS "tenant_42"."idx_name"');
	});

	it('rejects index names with embedded double-quotes (security: validateIdentifier)', () => {
		// S-2: validateIdentifier now rejects double-quotes in identifiers to prevent injection.
		expect(() => generateDropIndexSQL('my"index', 'public')).toThrow(
			/Invalid.*identifier/i,
		);
	});

	it('throws before SQL generation when schema is missing or empty', () => {
		expect(() => generateDropIndexSQL('idx_vec', '')).toThrow(
			/Invalid.*schema.*identifier/i,
		);
		expect(() => generateDropIndexSQL('idx_vec', undefined as never)).toThrow(
			/Invalid schema identifier/i,
		);
	});
});
