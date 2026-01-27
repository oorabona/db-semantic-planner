/**
 * Dynamic assertion runner for all example files.
 *
 * Scans examples/ for triplets (*.schema.ts, *.dbsp, *.assert.dbsp)
 * and runs them programmatically via executeBatch from @dbsp/cli.
 *
 * When DATABASE_URL is available (testcontainers via globalSetup),
 * examples are executed with --db for full assertion coverage including db.* assertions.
 * The .dbsp files handle schema setup via dot commands (.use, .import, etc.).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeBatch } from '../../packages/cli/src/repl/batch.js';
import { loadSchema } from '../../packages/cli/src/utils/schema-loader.js';

const ROOT_DIR = resolve(import.meta.dirname, '../..');
const EXAMPLES_DIR = resolve(ROOT_DIR, 'examples');

// ---------------------------------------------------------------------------
// Discovery: find all (schema, input, assert) triplets
// ---------------------------------------------------------------------------

interface ExampleTriplet {
	name: string;
	schemaPath: string;
	inputPath: string;
	assertPath: string;
}

function discoverExamples(): ExampleTriplet[] {
	const files = readdirSync(EXAMPLES_DIR);
	const assertFiles = files.filter((f) => f.endsWith('.assert.dbsp'));
	const triplets: ExampleTriplet[] = [];

	for (const assertFile of assertFiles) {
		const baseName = assertFile.replace('.assert.dbsp', '');

		const inputFile = `${baseName}.dbsp`;
		if (!files.includes(inputFile)) continue;

		// Schema: try "<base>.schema.ts", then strip "test-" prefix
		let schemaFile = `${baseName}.schema.ts`;
		if (!files.includes(schemaFile)) {
			const stripped = baseName.replace(/^test-/, '');
			schemaFile = `${stripped}.schema.ts`;
		}
		if (!files.includes(schemaFile)) continue;

		triplets.push({
			name: baseName,
			schemaPath: resolve(EXAMPLES_DIR, schemaFile),
			inputPath: resolve(EXAMPLES_DIR, inputFile),
			assertPath: resolve(EXAMPLES_DIR, assertFile),
		});
	}

	return triplets.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse a .dbsp input file into a list of queries/commands.
 * Same logic as the CLI repl command: split lines, trim, skip empty/comments.
 */
function parseInputFile(filePath: string): string[] {
	const content = readFileSync(filePath, 'utf-8');
	return content
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const examples = discoverExamples();

describe('Example Assertions (dynamic)', () => {
	it('should discover at least one example triplet', () => {
		expect(examples.length).toBeGreaterThan(0);
	});

	for (const example of examples) {
		describe(example.name, () => {
			it('should pass all assertions', async () => {
				const schema = await loadSchema(example.schemaPath);
				const queries = parseInputFile(example.inputPath);

				const dbUrl = process.env.DATABASE_URL;
				const { assertionSummary } = await executeBatch({
					queries,
					schema,
					schemaPath: example.schemaPath,
					format: 'text',
					assertFile: example.assertPath,
					...(dbUrl && { databaseUrl: dbUrl }),
				});

				expect(
					assertionSummary,
					`${example.name}: no assertion summary returned`,
				).toBeDefined();

				const summary = assertionSummary!;
				const failedDetails = summary.results
					.filter((r) => !r.passed)
					.map((r) => {
						const failures = r.assertions
							.filter((a) => !a.passed && !a.skipped)
							.map(
								(a) =>
									`  ${a.type}: expected ${JSON.stringify(a.expected)}, got ${JSON.stringify(a.actual)}`,
							)
							.join('\n');
						return `❌ Query ${r.queryIndex}: ${r.query.slice(0, 60)}\n${failures}`;
					})
					.join('\n');

				expect(
					summary.failed,
					`${example.name}: ${summary.passed}/${summary.total} passed\n${failedDetails}`,
				).toBe(0);
			});
		});
	}
});
