/**
 * DDL → Introspect Round-Trip E2E Test
 *
 * Tests the full cycle:
 * 1. Define a TypeScript schema
 * 2. Generate DDL from it
 * 3. Deploy to PostgreSQL
 * 4. Introspect the database
 * 5. Generate TypeScript schema from introspection
 * 6. Verify the generated schema matches the original
 */

// TODO(Phase-4): Re-enable when adapter-pgsql implements introspect()
// import { generateDDL } from '@dbsp/adapter-pgsql';  // generateDDL available
// introspect() is not yet implemented in adapter-pgsql (Phase 4)
import { ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSchemaFile } from '../../packages/cli/src/generators/schema-codegen.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';
import { sql } from './testkit/sql.js';

const SCHEMA = 'ddl_roundtrip_test';

// TODO(Phase-4): adapter-pgsql needs introspect() to run this test
describe.skip('DDL → Introspect Round-Trip [BLOCKED: adapter-pgsql Phase 4]', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('round-trips a simple schema through DDL and introspection', async () => {
		// 1. Define a TypeScript schema using new schema() + ref() API
		const originalSchema = schema({
			users: {
				id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
				email: 'string',
				name: { type: 'string', nullable: true },
				active: { type: 'boolean', default: 'true' },
				createdAt: { type: 'date', default: 'now()' },
			},
			posts: {
				id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
				title: 'string',
				content: { type: 'string', nullable: true },
				authorId: ref('users'),
				published: { type: 'boolean', default: 'false' },
			},
			comments: {
				id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
				postId: ref('posts'),
				authorId: ref('users'),
				body: 'string',
			},
		});
		const originalModel = originalSchema.model;

		// 2. Generate DDL from the schema
		const pool = await getTestPool();
		const ddlStatements = generateDDL(db, originalModel, {
			schemaName: SCHEMA,
		});

		expect(ddlStatements.length).toBeGreaterThan(0);

		// 3. Deploy to PostgreSQL
		for (const statement of ddlStatements) {
			await sql.raw(statement).execute(pool);
		}

		// 4. Introspect the database
		const introspectedModel = await introspect(db, {
			schema: SCHEMA,
		});

		// 5. Generate TypeScript schema from introspection
		const generatedCode = generateSchemaFile(introspectedModel, {
			sourceUrl: 'test://localhost/testdb',
			includeDbTypeComments: true,
		});

		// 6. Verify the generated schema
		// Check that all tables exist
		expect(introspectedModel.tables.size).toBe(3);
		expect(introspectedModel.tables.has('users')).toBe(true);
		expect(introspectedModel.tables.has('posts')).toBe(true);
		expect(introspectedModel.tables.has('comments')).toBe(true);

		// Check generated code structure (ARCH-005: new schema() + ref() API)
		expect(generatedCode).toContain("import { schema, ref } from '@dbsp/core'");
		expect(generatedCode).toContain('export const dbSchema = schema({');

		// Check tables appear in generated code
		expect(generatedCode).toContain('users: {');
		expect(generatedCode).toContain('posts: {');
		expect(generatedCode).toContain('comments: {');

		// Check column types are preserved (note: types may be mapped)
		const usersTable = introspectedModel.tables.get('users')!;
		expect(usersTable.columns.find((c) => c.name === 'id')?.type).toBe('uuid');
		expect(usersTable.columns.find((c) => c.name === 'email')?.type).toBe(
			'string',
		);
		expect(usersTable.columns.find((c) => c.name === 'active')?.type).toBe(
			'boolean',
		);

		// Check nullable is preserved
		expect(usersTable.columns.find((c) => c.name === 'name')?.nullable).toBe(
			true,
		);
		expect(usersTable.columns.find((c) => c.name === 'email')?.nullable).toBe(
			false,
		);

		// Check primary keys
		expect(usersTable.primaryKey).toBe('id');

		// Check foreign keys
		const postsTable = introspectedModel.tables.get('posts')!;
		expect(postsTable.foreignKeys.length).toBeGreaterThan(0);
		const authorFk = postsTable.foreignKeys.find((ref) =>
			ref.columns.includes('author_id'),
		);
		expect(authorFk).toBeDefined();
		expect(authorFk?.references.table).toBe('users');

		// Check generated code contains FK references (ARCH-005: ref() syntax)
		expect(generatedCode).toContain("ref('users')");
		expect(generatedCode).toContain("ref('posts')");
	});

	it('preserves column order', async () => {
		// Create a separate table to test column order
		const pool = await getTestPool();
		await sql`CREATE TABLE ${sql.ref(SCHEMA)}.ordered_test (
			first_col VARCHAR(100),
			second_col INTEGER,
			third_col BOOLEAN,
			id UUID PRIMARY KEY DEFAULT gen_random_uuid()
		)`.execute(pool);

		const introspectedModel = await introspect(db, {
			schema: SCHEMA,
			include: ['ordered_test'],
		});

		const table = introspectedModel.tables.get('ordered_test')!;
		const columnNames = table.columns.map((c) => c.name);

		// PostgreSQL maintains column order from definition
		expect(columnNames).toEqual(['first_col', 'second_col', 'third_col', 'id']);
	});

	it('handles nullable columns correctly', async () => {
		// NOTE: Kysely introspection provides `hasDefaultValue: boolean` but NOT
		// the actual default value string. Full default value capture would
		// require custom SQL queries to information_schema.columns.
		const pool = await getTestPool();
		await sql`CREATE TABLE ${sql.ref(SCHEMA)}.defaults_test (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			with_default VARCHAR(100) DEFAULT 'hello',
			without_default VARCHAR(100) NOT NULL,
			nullable_with_default VARCHAR(100) DEFAULT NULL,
			nullable_without_default VARCHAR(100)
		)`.execute(pool);

		const introspectedModel = await introspect(db, {
			schema: SCHEMA,
			include: ['defaults_test'],
		});

		const table = introspectedModel.tables.get('defaults_test')!;

		// Verify nullable is correctly detected
		const idCol = table.columns.find((c) => c.name === 'id')!;
		const withDefaultCol = table.columns.find(
			(c) => c.name === 'with_default',
		)!;
		const withoutDefaultCol = table.columns.find(
			(c) => c.name === 'without_default',
		)!;
		const nullableWithDefaultCol = table.columns.find(
			(c) => c.name === 'nullable_with_default',
		)!;
		const nullableWithoutDefaultCol = table.columns.find(
			(c) => c.name === 'nullable_without_default',
		)!;

		// UUID PK is not nullable
		expect(idCol.nullable).toBe(false);
		// NOT NULL columns are not nullable
		expect(withoutDefaultCol.nullable).toBe(false);
		// Nullable columns are detected
		expect(withDefaultCol.nullable).toBe(true);
		expect(nullableWithDefaultCol.nullable).toBe(true);
		expect(nullableWithoutDefaultCol.nullable).toBe(true);
	});
});
