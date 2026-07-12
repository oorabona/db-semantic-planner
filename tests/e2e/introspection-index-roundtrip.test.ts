/**
 * #245 — index intent survives introspection -> codegen -> schema() round-trip.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareSchemata, generateMigrationSQL } from '@dbsp/adapter-pgsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSchemaFileWithDiagnostics } from '../../packages/cli/src/generators/schema-codegen.js';
import { loadSchema } from '../../packages/cli/src/utils/schema-loader.js';
import {
	closeTestDb,
	createPgsqlAdapterForSchema,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'introspection_index_roundtrip_test';

describe('#245 introspection index intent round-trip (real PG)', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await pool.query(`
			CREATE TABLE ${SCHEMA}.index_roundtrip_users (
				id integer PRIMARY KEY,
				email_address text,
				status text NOT NULL,
				display_name text,
				search_text text,
				note text,
				deleted_at timestamp
			)
		`);
		await pool.query(
			`CREATE INDEX idx_rt_users_email ON ${SCHEMA}.index_roundtrip_users (email_address)`,
		);
		await pool.query(
			`CREATE UNIQUE INDEX uq_rt_users_email_status ON ${SCHEMA}.index_roundtrip_users (email_address, status)`,
		);
		await pool.query(
			`CREATE INDEX idx_rt_users_email_covering ON ${SCHEMA}.index_roundtrip_users (email_address) INCLUDE (display_name)`,
		);
		await pool.query(
			`CREATE INDEX idx_rt_users_active_email ON ${SCHEMA}.index_roundtrip_users (email_address) WHERE deleted_at IS NULL`,
		);
		await pool.query(
			`CREATE INDEX idx_rt_users_note_literal ON ${SCHEMA}.index_roundtrip_users (note) WHERE note = 'a;b'`,
		);
		await pool.query(
			`CREATE INDEX idx_rt_users_status_hash ON ${SCHEMA}.index_roundtrip_users USING hash (status)`,
		);
		await pool.query(
			`CREATE INDEX idx_rt_users_email_pattern ON ${SCHEMA}.index_roundtrip_users (email_address text_pattern_ops)`,
		);
		await pool.query(
			`CREATE INDEX idx_rt_users_lower_email ON ${SCHEMA}.index_roundtrip_users (lower(email_address))`,
		);
		await pool.query(`
			CREATE TABLE ${SCHEMA}.index_roundtrip_authors (
				id integer PRIMARY KEY
			)
		`);
		await pool.query(`
			CREATE TABLE ${SCHEMA}.index_roundtrip_posts (
				id integer PRIMARY KEY,
				author_id integer NOT NULL REFERENCES ${SCHEMA}.index_roundtrip_authors (id),
				body text
			)
		`);
		await pool.query(
			`CREATE INDEX my_lookup_idx ON ${SCHEMA}.index_roundtrip_posts (author_id)`,
		);
		await pool.query(`
			CREATE TABLE ${SCHEMA}.index_roundtrip_auto_posts (
				id integer PRIMARY KEY,
				author_id integer NOT NULL REFERENCES ${SCHEMA}.index_roundtrip_authors (id),
				body text
			)
		`);
		await pool.query(
			`CREATE INDEX idx_index_roundtrip_auto_posts_author_id ON ${SCHEMA}.index_roundtrip_auto_posts (author_id)`,
		);

		const version = await pool.query<{ server_version_num: string }>(
			'SHOW server_version_num',
		);
		const serverVersion = Number(version.rows[0]?.server_version_num ?? '0');
		if (serverVersion >= 150000) {
			await pool.query(
				`CREATE UNIQUE INDEX uq_rt_users_email_nnd ON ${SCHEMA}.index_roundtrip_users (email_address) NULLS NOT DISTINCT`,
			);
		}
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('regenerates FK-column indexes deliberately and leaves unmanaged indexes untouched', async () => {
		const adapter = await createPgsqlAdapterForSchema(SCHEMA);
		const dbModel = await adapter.introspect({ schema: SCHEMA });
		// The generator reads the model's own warnings; there is no option to pass
		// them back in, so a caller cannot drop them by forgetting to.
		const generated = generateSchemaFileWithDiagnostics(dbModel, {
			dbCasing: 'snake_case',
			includeDbTypeComments: true,
		});
		const warnings = generated.warnings;
		const generatedCode = generated.code;
		expect(warnings).toContainEqual(
			expect.stringContaining(
				'Expression index "idx_rt_users_lower_email" on table "index_roundtrip_users" cannot be represented in the schema and is not managed by dbsp.',
			),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining(
				'dbsp will neither drop nor recreate it; maintain it by hand.',
			),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining(
				'Index "idx_rt_users_note_literal" on table "index_roundtrip_users" cannot be represented in the schema and is not managed by dbsp because the DDL emitter rejected it',
			),
		);
		expect(generatedCode).toContain("name: 'my_lookup_idx'");
		expect(generatedCode).toContain(
			"name: 'idx_index_roundtrip_auto_posts_author_id'",
		);
		// PostgreSQL reports a partial-index predicate in its canonical, parenthesised
		// form, so that is what round-trips: the regenerated schema carries the same
		// text the catalog reports, which is why comparing it back yields no drift.
		expect(generatedCode).toContain("where: '(deleted_at IS NULL)'");
		expect(generatedCode).not.toContain('idx_rt_users_lower_email');
		expect(generatedCode).not.toContain('idx_rt_users_note_literal');
		const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-index-roundtrip-'));

		try {
			const schemaPath = join(tmpDir, 'dbsp.schema.ts');
			writeFileSync(schemaPath, generatedCode, 'utf8');
			const generated = await loadSchema(schemaPath);
			const diff = compareSchemata(generated.model, dbModel, {
				dbCasing: 'snake_case',
				ignoreUnmanagedExtensions: true,
			});
			expect(diff.changes).toEqual([]);
			expect(
				generateMigrationSQL(diff, {
					includeDestructive: false,
					schemaName: SCHEMA,
				}),
			).toEqual([]);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
