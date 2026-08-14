import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPgReinitializePreflight } from '@dbsp/adapter-pgsql';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(join(process.cwd(), 'guide/cli-usage.md'), 'utf8');

describe('CLI usage guide', () => {
	it('OBL-CLI5 documents commands with their required runnable arguments', () => {
		expect(guide).toContain(
			'dbsp plan ./schema.ts --db "$DATABASE_URL" --schema "$DBSP_SCHEMA"',
		);
		expect(guide).toContain(
			'dbsp apply "$RUN_ID" --db "$DATABASE_URL" --plan-digest "$PLAN_DIGEST" --accept operation-pack-semantics --accept external-ddl-exclusion',
		);
		expect(guide).toContain(
			'dbsp inspect table:users --db "$DATABASE_URL" --schema "$DBSP_SCHEMA" --format json',
		);
	});

	it('OBL-CLI5 executes every managed-workflow example as written', async () => {
		const databaseUrl =
			process.env.DATABASE_URL ?? 'postgres://dbsp:dbsp@127.0.0.1:54330/dbsp';
		const schema = `docs_cli_usage_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const directory = await mkdtemp(join(process.cwd(), '.cli-usage-'));
		const pool = new pg.Pool({ connectionString: databaseUrl });
		const quoteIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;
		const cliPath = join(process.cwd(), '../cli/src/index.ts');
		const tsxLoader = join(
			process.cwd(),
			'../../node_modules/tsx/dist/loader.mjs',
		);
		try {
			await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
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
			const execute = (args: readonly string[]) =>
				spawnSync(process.execPath, ['--import', tsxLoader, cliPath, ...args], {
					cwd: directory,
					encoding: 'utf8',
					env: {
						...process.env,
						DATABASE_URL: databaseUrl,
						DBSP_SCHEMA: schema,
					},
				});
			// The shell expands the guide variables; pass their concrete values to the
			// executable rather than relying on a shell parser in the docs suite.
			const planned = execute([
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
			const applied = execute([
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
			expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(56);
			expect(applied.stdout).toContain('execution-failed');
			const inspected = execute([
				'inspect',
				'table:users',
				'--db',
				databaseUrl,
				'--schema',
				schema,
				'--format',
				'json',
			]);
			expect(inspected.status).toBe(0);
			expect(JSON.parse(inspected.stdout)).toMatchObject({
				address: { schema, kind: 'table', name: 'users' },
			});
		} finally {
			await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
			await pool.end();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
