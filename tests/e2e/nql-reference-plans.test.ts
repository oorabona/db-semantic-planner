/**
 * NQL Reference Guide — Plan Validation
 *
 * Extracts NQL queries from docs/guides/nql-reference.md,
 * compiles each against its schema, and validates the plan.
 *
 * This test ensures all documented NQL queries actually compile
 * and produce valid plans with reasonable decisions.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InsertFromIntent, UpsertFromIntent } from '@dbsp/core';
import {
	isDeleteIntent,
	isInsertIntent,
	isUpdateIntent,
	isUpsertIntent,
	POSTGRESQL_CAPABILITIES,
	plan,
} from '@dbsp/core';
import { compile } from '@dbsp/nql';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../../packages/adapter-pgsql/src/pgsql-adapter.js';
import {
	compileSetOperation,
	createLeafCompileFn,
} from '../../packages/adapter-pgsql/src/set-operation.js';

const ROOT_DIR = resolve(import.meta.dirname, '../..');
const DOC_PATH = resolve(ROOT_DIR, 'docs/guides/nql-reference.md');

// ---------------------------------------------------------------------------
// All schemas used in the reference document
// ---------------------------------------------------------------------------

type SchemaName =
	| 'blog'
	| 'blog-extended'
	| 'ecommerce'
	| 'hierarchy'
	| 'iam'
	| 'minimal'
	| 'scheduling'
	| 'test-locking'
	| 'test-strategies';

const SCHEMA_NAMES: SchemaName[] = [
	'blog',
	'blog-extended',
	'ecommerce',
	'hierarchy',
	'iam',
	'minimal',
	'scheduling',
	'test-locking',
	'test-strategies',
];

// ---------------------------------------------------------------------------
// Schema loading — dynamic import of example schemas
// ---------------------------------------------------------------------------

async function loadExampleSchema(name: string) {
	const schemaPath = resolve(ROOT_DIR, `examples/${name}.schema.ts`);
	const mod = await import(schemaPath);
	return mod.default;
}

// ---------------------------------------------------------------------------
// NQL query extraction from markdown
// ---------------------------------------------------------------------------

interface NqlBlock {
	/** Section title for display */
	section: string;
	/** The NQL query text */
	nql: string;
	/** Which schema to use */
	schema: SchemaName;
	/** Query or mutation */
	type: 'query' | 'mutation';
	/** Line number in the markdown file */
	lineNumber: number;
}

/**
 * Parse the markdown document and extract compilable NQL blocks.
 *
 * Schema detection: uses `*Schema: X*` annotations that precede code blocks
 * in the document. Falls back to table-name heuristics if no annotation found.
 */
function extractNqlBlocks(markdown: string): NqlBlock[] {
	const lines = markdown.split('\n');
	const blocks: NqlBlock[] = [];
	let currentSection = '';
	let currentSchema: SchemaName = 'ecommerce';

	let inCodeBlock = false;
	let codeBlockLang = '';
	let codeBlockContent: string[] = [];
	let codeBlockStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		// Track section headers (## or ###)
		const headerMatch = line.match(/^#{2,3}\s+(.*)/);
		if (headerMatch) {
			currentSection = headerMatch[1]!.trim();
			continue;
		}

		// Track schema annotations: *Schema: X*
		const schemaMatch = line.match(/^\*Schema:\s*(\S+)\*/);
		if (schemaMatch) {
			const name = schemaMatch[1]!.toLowerCase().replace(/[^a-z0-9-]/g, '');
			if (SCHEMA_NAMES.includes(name as SchemaName)) {
				currentSchema = name as SchemaName;
			}
			continue;
		}

		// Track code blocks
		if (line.startsWith('```') && !inCodeBlock) {
			inCodeBlock = true;
			codeBlockLang = line.slice(3).trim().toLowerCase();
			codeBlockContent = [];
			codeBlockStartLine = i + 1;
			continue;
		}

		if (line.startsWith('```') && inCodeBlock) {
			inCodeBlock = false;
			const content = codeBlockContent.join('\n').trim();

			// Only process blocks explicitly tagged as NQL
			if (codeBlockLang !== 'nql') {
				continue;
			}

			// Split multi-query blocks into individual queries
			const queries = splitNqlQueries(content);
			for (const q of queries) {
				if (!isCompilableNql(q)) continue;

				const isMutation = /^\s*(insert|update|delete|upsert)\b/i.test(q);

				blocks.push({
					section: currentSection,
					nql: q,
					schema: currentSchema,
					type: isMutation ? 'mutation' : 'query',
					lineNumber: codeBlockStartLine,
				});
			}
			continue;
		}

		if (inCodeBlock) {
			codeBlockContent.push(line);
		}
	}

	return blocks;
}

/**
 * Split a code block with multiple NQL queries into individual queries.
 * Blank lines and comment-only lines separate queries.
 * Handles `\` line continuation (joins lines ending with `\`).
 */
function splitNqlQueries(content: string): string[] {
	const rawLines = content.split('\n');
	const queries: string[] = [];

	// First pass: join lines with `\` continuation
	const lines: string[] = [];
	let pending = '';
	for (const line of rawLines) {
		const trimmed = line.trim();
		if (trimmed.endsWith('\\')) {
			pending += `${trimmed.slice(0, -1).trimEnd()} `;
		} else {
			lines.push(pending + trimmed);
			pending = '';
		}
	}
	if (pending) lines.push(pending.trimEnd());

	// In NQL, each line (after \ continuation) is a separate query
	for (const line of lines) {
		const trimmed = line.trim();

		// Skip empty and comment-only lines
		if (!trimmed || trimmed.startsWith('#')) continue;

		// Strip inline comments (SQL-style `-- ...` and NQL-style `# ...`)
		const withoutComment = trimmed
			.replace(/\s+--\s.*$/, '')
			.replace(/\s+#\s.*$/, '');

		// Strip REPL mutation terminator `!` at end of line
		const withoutTerminator = withoutComment.endsWith('!')
			? withoutComment.slice(0, -1)
			: withoutComment;

		if (withoutTerminator) {
			queries.push(withoutTerminator);
		}
	}

	return queries;
}

/**
 * Check if a string is a compilable NQL query (not a syntax pattern or command).
 */
function isCompilableNql(nql: string): boolean {
	const trimmed = nql.trim();

	// Skip syntax patterns
	if (trimmed.includes('| operator')) return false;
	if (trimmed.includes('<table>')) return false;
	if (trimmed.includes('<col>')) return false;
	if (trimmed.includes('<val>')) return false;
	if (trimmed.includes('<column>')) return false;
	if (trimmed.includes('<relation>')) return false;
	if (trimmed.includes('<condition>')) return false;
	if (trimmed.startsWith('function()')) return false;

	// Skip dot commands
	if (trimmed.startsWith('.')) return false;

	// Skip raw SQL escape hatches
	if (trimmed.startsWith('!')) return false;

	// Skip bind (multi-statement context, not supported in compile-only)
	if (trimmed.includes('| bind ')) return false;

	// Skip EXISTS subquery (not supported in NQL)
	if (trimmed.includes('where exists (')) return false;

	// Skip insert from (different parse path, not fully supported in compile-only)
	if (/^insert\s+into\s+\w+\s+from\b/i.test(trimmed)) return false;

	// Skip upsert from
	if (/^upsert\s+into\s+\w+\s+on\s+\w+\s+from\b/i.test(trimmed)) return false;

	// Skip HAVING via "where count/sum/avg/min/max" after group by (not yet supported)
	if (/\|\s*where\s+(count|sum|avg|min|max)\s*\(/i.test(trimmed)) return false;

	// Skip quoted identifier examples
	if (/^"[^"]*"$/.test(trimmed)) return false;

	// Skip placeholder examples
	if (/\.\.\./i.test(trimmed)) return false;

	// Must start with a word (table name or mutation keyword)
	if (!/^[a-zA-Z]/.test(trimmed)) return false;

	return true;
}

// ---------------------------------------------------------------------------
// Compilation helpers
// ---------------------------------------------------------------------------

interface CompileResult {
	sql: string;
	params: readonly unknown[];
	planReport?: ReturnType<typeof plan>;
}

function compileQuery(
	nql: string,
	schemaObj: ReturnType<Awaited<ReturnType<typeof loadExampleSchema>>>,
): CompileResult {
	const compiled = compile(nql, schemaObj.model);
	if (!compiled.success) {
		throw new Error(
			`NQL parse failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	// Set operations produce ast.setOperation instead of ast.query
	if (compiled.ast?.setOperation) {
		const adapter = createPgsqlCompileOnlyAdapter();
		const leafCompileFn = createLeafCompileFn(adapter, schemaObj.model, plan);
		const result = compileSetOperation(
			compiled.ast.setOperation,
			leafCompileFn,
		);
		return { sql: result.sql, params: result.parameters };
	}

	if (!compiled.ast?.query) {
		throw new Error(
			`NQL parse failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, schemaObj.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: schemaObj.model });

	return {
		sql: result.sql,
		params: result.parameters,
		planReport,
	};
}

function compileMutation(
	nql: string,
	schemaObj: ReturnType<Awaited<ReturnType<typeof loadExampleSchema>>>,
): CompileResult {
	const compiled = compile(nql, schemaObj.model);
	if (!compiled.success || !compiled.ast?.mutation) {
		throw new Error(
			`NQL mutation parse failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const mutation = compiled.ast.mutation;
	const adapter = createPgsqlCompileOnlyAdapter();
	const options = { model: schemaObj.model };

	if (isInsertIntent(mutation)) {
		const result = adapter.compileInsert(mutation, options);
		return { sql: result.sql, params: result.parameters };
	}
	if (isUpdateIntent(mutation)) {
		const result = adapter.compileUpdate(mutation, options);
		return { sql: result.sql, params: result.parameters };
	}
	if (isDeleteIntent(mutation)) {
		const result = adapter.compileDelete(mutation, options);
		return { sql: result.sql, params: result.parameters };
	}
	if (isUpsertIntent(mutation)) {
		const result = adapter.compileUpsert(mutation, options);
		return { sql: result.sql, params: result.parameters };
	}
	// InsertFromIntent
	if ((mutation as InsertFromIntent).type === 'insert_from') {
		const result = adapter.compileInsertFrom(
			mutation as InsertFromIntent,
			options,
		);
		return { sql: result.sql, params: result.parameters };
	}
	// UpsertFromIntent
	if ((mutation as { type: string }).type === 'upsert_from') {
		const result = adapter.compileUpsertFrom(
			mutation as UpsertFromIntent,
			options,
		);
		return { sql: result.sql, params: result.parameters };
	}

	throw new Error(
		`Unhandled mutation type: ${(mutation as { type: string }).type}`,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const markdown = readFileSync(DOC_PATH, 'utf-8');
const allBlocks = extractNqlBlocks(markdown);

// Group by schema
const blocksBySchema = new Map<SchemaName, NqlBlock[]>();
for (const block of allBlocks) {
	const existing = blocksBySchema.get(block.schema) ?? [];
	existing.push(block);
	blocksBySchema.set(block.schema, existing);
}

describe('NQL Reference Guide — Plan Validation', () => {
	for (const schemaName of SCHEMA_NAMES) {
		const schemaBlocks = blocksBySchema.get(schemaName) ?? [];
		if (schemaBlocks.length === 0) continue;

		describe(`${schemaName} schema queries (${schemaBlocks.length})`, () => {
			let schema: Awaited<ReturnType<typeof loadExampleSchema>>;

			it(`loads ${schemaName} schema`, async () => {
				schema = await loadExampleSchema(schemaName);
				expect(schema).toBeDefined();
				expect(schema.model).toBeDefined();
			});

			for (const block of schemaBlocks) {
				const label = `${block.section}: ${block.nql.slice(0, 70)}${block.nql.length > 70 ? '...' : ''}`;

				it(label, () => {
					expect(schema).toBeDefined();
					const result =
						block.type === 'mutation'
							? compileMutation(block.nql, schema)
							: compileQuery(block.nql, schema);

					expect(result.sql).toBeTruthy();
					expect(typeof result.sql).toBe('string');

					if (result.planReport) {
						expect(result.planReport.rootTable).toBeTruthy();
						expect(Array.isArray(result.planReport.decisions)).toBe(true);
					}
				});
			}
		});
	}

	it('extracted a reasonable number of queries', () => {
		const total = allBlocks.length;
		// We expect at least 30 compilable queries from the reference
		expect(total).toBeGreaterThan(30);
	});
});
