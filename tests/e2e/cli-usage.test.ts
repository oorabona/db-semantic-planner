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
	return `cli_usage_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
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

afterEach(async () => {
	const pool = await getTestPool();
	for (const schema of schemas.splice(0)) await dropSchema(schema);
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
	await pool.query('RESET search_path');
});

describe('OBL-CLI5 executable CLI usage guide', { concurrent: false }, () => {
	it('executes every managed-workflow example as written', async () => {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) throw new Error('DATABASE_URL is required for CLI E2E');
		const schema = testSchema();
		const directory = await mkdtemp(join(repositoryRoot, '.dbsp-cli-usage-'));
		const pool = await getTestPool();
		schemas.push(schema);
		directories.push(directory);
		await createSchema(schema);
		await pool.query(
			`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
		);
		await runPgReinitializePreflight({
			pool,
			schemas: [schema],
			declarations: {
				version: 1,
				digest: `docs-${schema}`,
				declarations: [],
			},
			writeAdoptionFile: async () => {},
		});
		await writeFile(
			join(directory, 'schema.ts'),
			`import { ModelIRImpl, schema } from '@dbsp/core';\nconst base = schema({});\nexport default { ...base, model: new ModelIRImpl(new Map(), new Map(), new Map([['status', { name: 'status', schema: '${schema}', values: ['active', 'pending'] }]])) };\n`,
			'utf8',
		);

		// The shell expands the guide variables; pass their concrete values to the
		// executable rather than relying on a shell parser in the E2E suite.
		const planned = execute(directory, [
			'plan',
			'./schema.ts',
			'--db',
			databaseUrl,
			'--schema',
			schema,
		]);
		expect(planned.status, `${planned.stdout}\n${planned.stderr}`).toBe(0);
		const runId = /Run id: ([^\n]+)/.exec(planned.stdout)?.[1];
		const planDigest = /Plan digest: ([^\n]+)/.exec(planned.stdout)?.[1];
		if (!runId || !planDigest)
			throw new Error(
				`guide plan did not print a run id and digest: ${planned.stdout}`,
			);
		const applied = execute(directory, [
			'apply',
			runId,
			'--db',
			databaseUrl,
			'--plan-digest',
			planDigest,
			'--accept',
			'operation-pack-semantics',
			'--accept',
			'external-ddl-exclusion',
		]);
		expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
		expect(applied.stdout).toContain('completed');
		const inspected = execute(directory, [
			'inspect',
			'table:users',
			'--db',
			databaseUrl,
			'--schema',
			schema,
			'--format',
			'json',
		]);
		expect(inspected.status, `${inspected.stdout}\n${inspected.stderr}`).toBe(
			0,
		);
		expect(JSON.parse(inspected.stdout)).toMatchObject({
			address: { schema, kind: 'table', name: 'users' },
		});
	});
});
