/**
 * Verify all NQL examples in packages/docs/nql/index.md
 *
 * Parses the markdown to extract NQL queries and their expected SQL,
 * then compiles each through the real pipeline and compares.
 *
 * Usage: npx tsx scripts/verify-nql-guide.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeSQL } from '@dbsp/core';

const ROOT = resolve(import.meta.dirname, '..');

interface Example {
	lineNum: number;
	schema: string;
	nql: string;
	expectedSql: string;
	expectedParams: string | null;
	section: string;
}

/**
 * Parse all NQL examples from the markdown guide.
 *
 * Pattern in the markdown:
 *   **blog:**            ← schema label
 *   ```                  ← bare code fence (no language tag)
 *   some nql query       ← NQL (1-3 lines)
 *   ```                  ← close fence
 *                        ← optional blank lines
 *   <details>            ← details block
 *   ...
 *   ```sql               ← SQL code block
 *   SELECT ...           ← expected SQL
 *   ```
 *   **Parameters:** ...
 *   </details>
 */
function parseExamples(content: string): Example[] {
	const lines = content.split('\n');
	const examples: Example[] = [];
	let currentSection = '';
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		// Track section headers
		if (/^#{2,4}\s/.test(line)) {
			currentSection = line.replace(/^#+\s*/, '').replace(/\s*$/, '');
		}

		// Look for schema label immediately before a code block
		const schemaMatch = line.match(/^\*\*(blog|ecommerce|hierarchy):\*\*\s*$/i);
		if (schemaMatch) {
			const schema = schemaMatch[1]!.toLowerCase();
			const nextLine = lines[i + 1];

			// Next line must be bare code fence
			if (nextLine && nextLine.trim() === '```') {
				i += 2; // skip schema label + opening fence
				const nqlLines: string[] = [];
				while (i < lines.length && lines[i]!.trim() !== '```') {
					nqlLines.push(lines[i]!);
					i++;
				}
				const rawBlock = nqlLines.join('\n').trim();
			const nqlBlockEnd = i;
				i++; // skip closing fence

				// Skip things that aren't NQL
				if (!rawBlock || rawBlock.includes('import ') || rawBlock.includes('schema(')) {
					continue;
				}

				// Handle multi-line blocks:
				// - If block has # comments → multiple examples, take first query only
				// - If block has no # comments → single multi-line query (e.g. CASE)
				const hasComments = rawBlock.split('\n').some(l => l.trim().startsWith('#'));
				let nql: string;
				if (hasComments) {
					// Take first non-comment, non-empty line as a single NQL query
					const firstQuery = rawBlock
						.split('\n')
						.find(l => l.trim() && !l.trim().startsWith('#'));
					nql = firstQuery?.trim() ?? '';
				} else {
					// Treat entire block as one multi-line query (join lines)
					nql = rawBlock;
				}
				if (!nql) continue;

				// Now search for <details> block within next 8 lines
				let expectedSql: string | null = null;
				let expectedParams: string | null = null;
				let j = i;
				const searchLimit = Math.min(i + 8, lines.length);

				while (j < searchLimit) {
					if (lines[j]!.includes('<details>')) {
						// Found it — parse the details block
						let k = j;
						while (k < lines.length && !lines[k]!.includes('</details>')) {
							if (lines[k]!.trim() === '```sql') {
								k++;
								const sqlLines: string[] = [];
								while (k < lines.length && lines[k]!.trim() !== '```') {
									sqlLines.push(lines[k]!);
									k++;
								}
								expectedSql = sqlLines.join('\n').trim();
							}
							if (lines[k]!.startsWith('**Parameters:**')) {
								const paramMatch = lines[k]!.match(
									/\*\*Parameters:\*\*\s*`(.+?)`/,
								);
								if (paramMatch) {
									expectedParams = paramMatch[1]!;
								} else if (lines[k]!.includes('_none_')) {
									expectedParams = '[]';
								}
							}
							k++;
						}
						break;
					}
					j++;
				}

				if (expectedSql) {
					examples.push({
						lineNum: nqlBlockEnd - nqlLines.length,
						schema,
						nql,
						expectedSql,
						expectedParams,
						section: currentSection,
					});
				}
				continue;
			}
		}

		i++;
	}

	return examples;
}

async function main() {
	const mdPath = resolve(ROOT, 'packages/docs/nql/index.md');
	const content = readFileSync(mdPath, 'utf-8');
	const examples = parseExamples(content);

	console.log(`Found ${examples.length} NQL examples with expected SQL\n`);

	// Show a few examples to verify parsing
	for (const ex of examples.slice(0, 3)) {
		console.log(`  L${ex.lineNum} [${ex.schema}] ${ex.section}: "${ex.nql.substring(0, 60)}"`);
	}
	console.log('');

	// Lazy imports
	const { loadSchema } = await import(
		'../packages/cli/src/utils/schema-loader.js'
	);
	const { plan } = await import('@dbsp/core');
	const { compile: compileNql } = await import('@dbsp/nql');
	const { createPgsqlCompileOnlyAdapter } = await import(
		'@dbsp/adapter-pgsql'
	);

	// Load schemas
	type ModelIR = Parameters<typeof plan>[1];
	const schemas: Record<string, ModelIR> = {};
	const schemaMap: Record<string, string> = {
		blog: 'examples/blog.schema.ts',
		ecommerce: 'examples/ecommerce.schema.ts',
		hierarchy: 'examples/hierarchy.schema.ts',
	};

	for (const [name, path] of Object.entries(schemaMap)) {
		try {
			const loaded = await loadSchema(resolve(ROOT, path));
			schemas[name] = loaded.model;
			console.log(`✅ Loaded schema: ${name}`);
		} catch (err) {
			console.error(`❌ Failed to load schema ${name}: ${err}`);
		}
	}
	console.log('');

	const adapter = createPgsqlCompileOnlyAdapter();

	let passed = 0;
	let failed = 0;
	let skipped = 0;
	const failures: {
		example: Example;
		actual: string;
		error?: string;
	}[] = [];

	for (const ex of examples) {
		const model = schemas[ex.schema];
		if (!model) {
			skipped++;
			continue;
		}

		try {
			const result = compileNql(ex.nql, model);
			if (!result.success || !result.ast) {
				failures.push({
					example: ex,
					actual: '',
					error: `Parse/compile error: ${result.errors.map((e: any) => e.message).join('; ')}`,
				});
				failed++;
				continue;
			}

			const compiled = result.ast as any;
			let sql: string;
			let params: readonly unknown[];

			if (compiled.query) {
				const planReport = plan(compiled.query, model, {
					dialectCapabilities: adapter.dialectCapabilities,
				});
				const compiledQuery = adapter.compile(planReport, { model });
				sql = compiledQuery.sql;
				params = compiledQuery.parameters;
			} else if (compiled.mutation) {
				const mutation = compiled.mutation;
				let compiledMutation: any;
				switch (mutation.type) {
					case 'insert':
						compiledMutation = adapter.compileInsert(mutation);
						break;
					case 'update':
						compiledMutation = adapter.compileUpdate(mutation);
						break;
					case 'delete':
						compiledMutation = adapter.compileDelete(mutation);
						break;
					case 'upsert':
						compiledMutation = adapter.compileUpsert(mutation);
						break;
					default:
						skipped++;
						continue;
				}
				sql = compiledMutation.sql;
				params = compiledMutation.parameters;
			} else {
				skipped++;
				continue;
			}

			const actualNorm = normalizeSQL(sql);
			const expectedNorm = normalizeSQL(ex.expectedSql);

			if (actualNorm === expectedNorm) {
				passed++;
			} else {
				failures.push({ example: ex, actual: sql });
				failed++;
			}
		} catch (err) {
			failures.push({
				example: ex,
				actual: '',
				error: err instanceof Error ? err.message : String(err),
			});
			failed++;
		}
	}

	console.log(`${'='.repeat(60)}`);
	console.log(
		`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped (of ${examples.length})`,
	);
	console.log(`${'='.repeat(60)}\n`);

	if (failures.length > 0) {
		console.log('FAILURES:\n');
		for (const f of failures) {
			console.log(
				`--- L${f.example.lineNum} [${f.example.schema}] ${f.example.section}`,
			);
			console.log(`NQL: ${f.example.nql}`);
			if (f.error) {
				console.log(`ERROR: ${f.error}`);
			} else {
				console.log(`EXPECTED: ${normalizeSQL(f.example.expectedSql)}`);
				console.log(`ACTUAL:   ${normalizeSQL(f.actual)}`);
			}
			console.log('');
		}
	}
}

main().catch(console.error);
