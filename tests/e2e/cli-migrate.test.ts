import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPgReinitializePreflight } from '@dbsp/adapter-pgsql';
import { afterEach, describe, expect, it } from 'vitest';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';

const schemas: string[] = [];
const directories: string[] = [];
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function testSchema(): string {
	return `cli_migrate_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function readOnlyDatabaseUrl(databaseUrl: string): string {
	const url = new URL(databaseUrl);
	url.searchParams.set('options', '-c default_transaction_read_only=on');
	return url.toString();
}

function execute(directory: string, args: readonly string[]) {
	const cliPath = fileURLToPath(
		new URL('../../packages/cli/src/index.ts', import.meta.url),
	);
	return spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
		cwd: directory,
		encoding: 'utf8',
		env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: undefined },
	});
}

function schemaSource(includeExtraIndex = false): string {
	return `import { ModelIRImpl, schema } from '@dbsp/core';
const base = schema({});
const parent = {
  name: 'cli_migrate_parent',
  columns: [{ name: 'id', type: 'integer', nullable: false }],
  primaryKey: 'id', foreignKeys: [], indexes: ${includeExtraIndex ? "[{ name: 'cli_migrate_parent_extra_index', columns: ['id'] }]" : '[]'},
};
const child = {
  name: 'cli_migrate_child',
  columns: [{ name: 'id', type: 'integer', nullable: false }, { name: 'parent_id', type: 'integer', nullable: false }],
  primaryKey: 'id',
  foreignKeys: [{ columns: ['parent_id'], references: { table: 'cli_migrate_parent', columns: ['id'] } }],
  indexes: [{ name: 'cli_migrate_child_parent_id_index', columns: ['parent_id'] }],
};
export default { ...base, model: new ModelIRImpl(new Map([['cli_migrate_parent', parent], ['cli_migrate_child', child]]), new Map(), new Map()) };
`;
}

function externalOnlySource(): string {
	return `import { ModelIRImpl, schema } from '@dbsp/core';
const base = schema({});
export default { ...base, model: new ModelIRImpl(new Map([['declared_table', { name: 'declared_table', columns: [{ name: 'id', type: 'integer', nullable: false }], primaryKey: 'id', foreignKeys: [], indexes: [] }]]), new Map(), new Map()) };
`;
}

async function prepared() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('DATABASE_URL is required for CLI E2E');
	const schema = testSchema();
	const directory = await mkdtemp(join(repositoryRoot, '.dbsp-cli-migrate-'));
	const pool = await getTestPool();
	schemas.push(schema);
	directories.push(directory);
	await createSchema(schema);
	await runPgReinitializePreflight({
		pool,
		schemas: [schema],
		declarations: {
			version: 1,
			digest: `cli-migrate-${schema}`,
			declarations: [],
		},
		writeAdoptionFile: async () => {},
	});
	const schemaFile = join(directory, 'schema.ts');
	await writeFile(schemaFile, schemaSource(), 'utf8');
	return { databaseUrl, directory, pool, schema, schemaFile };
}

afterEach(async () => {
	const pool = await getTestPool();
	for (const schema of schemas.splice(0)) await dropSchema(schema);
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
	await pool.query('RESET search_path');
});

describe('dbsp migrate CLI convergence', { concurrent: false }, () => {
	it('creates related tables, the declared index and foreign key, then reports no drift', async () => {
		const { databaseUrl, directory, pool, schema } = await prepared();
		const args = [
			'migrate',
			'./schema.ts',
			'--db',
			databaseUrl,
			'--schema',
			schema,
			'--format',
			'json',
		];
		const first = execute(directory, args);
		expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
		expect(JSON.parse(first.stdout)).toMatchObject({
			outcome: 'applied',
			exitCode: 0,
			schema,
		});
		const tables = await pool.query(
			"SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 AND tablename IN ('cli_migrate_parent', 'cli_migrate_child') ORDER BY tablename",
			[schema],
		);
		expect(tables.rows.map((row) => row.tablename)).toEqual([
			'cli_migrate_child',
			'cli_migrate_parent',
		]);
		const index = await pool.query(
			'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3) AS exists',
			[schema, 'cli_migrate_child', 'cli_migrate_child_parent_id_index'],
		);
		expect(index.rows[0]?.exists).toBe(true);
		const foreignKey = await pool.query(
			'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = $3) AS exists',
			[schema, 'cli_migrate_child', 'f'],
		);
		expect(foreignKey.rows[0]?.exists).toBe(true);
		const second = execute(directory, args);
		expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
		expect(JSON.parse(second.stdout)).toMatchObject({
			outcome: 'no-drift',
			exitCode: 0,
		});
	});

	it('refuses an uninitialized ledger before creating declared tables', async () => {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) throw new Error('DATABASE_URL is required for CLI E2E');
		const schema = testSchema();
		const directory = await mkdtemp(join(repositoryRoot, '.dbsp-cli-migrate-'));
		const pool = await getTestPool();
		schemas.push(schema);
		directories.push(directory);
		await createSchema(schema);
		await writeFile(join(directory, 'schema.ts'), schemaSource(), 'utf8');
		const completed = execute(directory, [
			'migrate',
			'./schema.ts',
			'--db',
			databaseUrl,
			'--schema',
			schema,
			'--format',
			'json',
		]);
		expect(completed.status, `${completed.stdout}\n${completed.stderr}`).toBe(
			71,
		);
		expect(JSON.parse(completed.stdout)).toMatchObject({
			outcome: 'ledger-absent',
			exitCode: 71,
		});
		const table = await pool.query('SELECT to_regclass($1) AS table_name', [
			`${schema}.cli_migrate_parent`,
		]);
		expect(table.rows[0]?.table_name).toBeNull();
	});

	it('reports database-read-only before creating declared tables', async () => {
		const { databaseUrl, directory, pool, schema } = await prepared();
		const completed = execute(directory, [
			'migrate',
			'./schema.ts',
			'--db',
			readOnlyDatabaseUrl(databaseUrl),
			'--schema',
			schema,
			'--format',
			'json',
		]);

		expect(completed.status, `${completed.stdout}\n${completed.stderr}`).toBe(
			34,
		);
		expect(JSON.parse(completed.stdout)).toMatchObject({
			outcome: 'database-read-only',
			exitCode: 34,
		});
		const table = await pool.query('SELECT to_regclass($1) AS table_name', [
			`${schema}.cli_migrate_parent`,
		]);
		expect(table.rows[0]?.table_name).toBeNull();
	});

	it('refuses an additional managed-table index after convergence', async () => {
		const { databaseUrl, directory, pool, schema, schemaFile } =
			await prepared();
		expect(
			execute(directory, [
				'migrate',
				'./schema.ts',
				'--db',
				databaseUrl,
				'--schema',
				schema,
				'--format',
				'json',
			]).status,
		).toBe(0);
		await writeFile(schemaFile, schemaSource(true), 'utf8');
		const completed = execute(directory, [
			'migrate',
			'./schema.ts',
			'--db',
			databaseUrl,
			'--schema',
			schema,
			'--format',
			'json',
		]);
		expect(completed.status, `${completed.stdout}\n${completed.stderr}`).toBe(
			74,
		);
		expect(JSON.parse(completed.stdout)).toMatchObject({
			outcome: 'unsupported-change',
			exitCode: 74,
		});
		const index = await pool.query('SELECT to_regclass($1) AS index_name', [
			`${schema}.cli_migrate_parent_extra_index`,
		]);
		expect(index.rows[0]?.index_name).toBeNull();
	});

	it('adopts a hand-created index only when it is declared external', async () => {
		const { databaseUrl, directory, pool, schema } = await prepared();
		expect(
			execute(directory, [
				'migrate',
				'./schema.ts',
				'--db',
				databaseUrl,
				'--schema',
				schema,
				'--format',
				'json',
			]).status,
		).toBe(0);
		await pool.query(
			`CREATE INDEX ${quoteIdent('operator_created_index')} ON ${quoteIdent(schema)}.${quoteIdent('cli_migrate_parent')} (${quoteIdent('id')})`,
		);
		const refused = execute(directory, [
			'migrate',
			'./schema.ts',
			'--db',
			databaseUrl,
			'--schema',
			schema,
			'--format',
			'json',
		]);
		expect(refused.status).toBe(74);
		expect(JSON.parse(refused.stdout)).toMatchObject({
			outcome: 'unsupported-change',
		});
		const accepted = execute(directory, [
			'migrate',
			'./schema.ts',
			'--db',
			databaseUrl,
			'--schema',
			schema,
			'--external-index',
			'cli_migrate_parent:operator_created_index',
			'--format',
			'json',
		]);
		expect(accepted.status, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
		expect(JSON.parse(accepted.stdout)).toMatchObject({ outcome: 'no-drift' });
		const externalIndex = await pool.query(
			'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3) AS exists',
			[schema, 'cli_migrate_parent', 'operator_created_index'],
		);
		expect(externalIndex.rows[0]?.exists).toBe(true);
	});

	it('redacts a wrong database password', async () => {
		const { databaseUrl, directory, schema } = await prepared();
		const url = new URL(databaseUrl);
		url.password = 'wrong-password-for-cli-migrate';
		const completed = execute(directory, [
			'migrate',
			'./schema.ts',
			'--db',
			url.toString(),
			'--schema',
			schema,
			'--format',
			'json',
		]);
		expect(completed.status).toBe(29);
		expect(JSON.parse(completed.stdout)).toMatchObject({
			outcome: 'migrate-failed',
			exitCode: 29,
		});
		expect(`${completed.stdout}\n${completed.stderr}`).not.toContain(
			'wrong-password-for-cli-migrate',
		);
	});

	it('rejects an external index table that the model does not declare', async () => {
		const { databaseUrl, directory, pool, schema, schemaFile } =
			await prepared();
		await writeFile(schemaFile, externalOnlySource(), 'utf8');
		const completed = execute(directory, [
			'migrate',
			'./schema.ts',
			'--db',
			databaseUrl,
			'--schema',
			schema,
			'--external-index',
			'missing_table:operator_index',
			'--format',
			'json',
		]);
		expect(completed.status, `${completed.stdout}\n${completed.stderr}`).toBe(
			70,
		);
		expect(JSON.parse(completed.stdout)).toMatchObject({
			outcome: 'invalid-options',
			exitCode: 70,
		});
		const table = await pool.query('SELECT to_regclass($1) AS table_name', [
			`${schema}.declared_table`,
		]);
		expect(table.rows[0]?.table_name).toBeNull();
	});
});
