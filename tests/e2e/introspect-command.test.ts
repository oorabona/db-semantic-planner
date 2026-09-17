import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { introspectCommand } from '../../packages/cli/src/commands/introspect.js';
import { createBlogSchema, dropSchema } from './testkit/index.js';

const schemas: string[] = [];
const directories: string[] = [];
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function testSchema(): string {
	return `introspect_command_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

afterEach(async () => {
	for (const schema of schemas.splice(0)) await dropSchema(schema);
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

describe('dbsp introspect', { concurrent: false }, () => {
	it('writes a schema file from the live PostgreSQL fixture', async () => {
		const databaseUrl = process.env.DATABASE_URL;
		if (!databaseUrl) throw new Error('DATABASE_URL is required for CLI E2E');
		const schema = testSchema();
		const directory = await mkdtemp(
			join(repositoryRoot, '.dbsp-introspect-command-'),
		);
		const outputPath = join(directory, 'dbsp.schema.ts');
		schemas.push(schema);
		directories.push(directory);
		await createBlogSchema(schema);

		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
			throw new Error('introspect command attempted to exit');
		}) as typeof process.exit);
		try {
			await introspectCommand.parseAsync(
				['--db', databaseUrl, '--schema-name', schema, '--out', outputPath],
				{ from: 'user' },
			);
		} finally {
			exitSpy.mockRestore();
		}

		expect(exitSpy).not.toHaveBeenCalled();
		expect(existsSync(outputPath)).toBe(true);
		const generated = await readFile(outputPath, 'utf8');
		expect(generated).toContain('authors: {');
		expect(generated).toContain('posts: {');
		expect(generated).toContain("authorId: ref('authors')");
	});
});
