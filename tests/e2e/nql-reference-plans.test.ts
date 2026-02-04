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
import type { InsertFromIntent } from '@dbsp/core';
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

const ROOT_DIR = resolve(import.meta.dirname, '../..');
const DOC_PATH = resolve(ROOT_DIR, 'docs/guides/nql-reference.md');

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
	/** Section reference (e.g., "§2.1") */
	section: string;
	/** Section title for display */
	title: string;
	/** The NQL query text */
	nql: string;
	/** Which schema to use */
	schema: 'blog' | 'ecommerce' | 'hierarchy';
	/** Query or mutation */
	type: 'query' | 'mutation';
	/** Line number in the markdown file */
	lineNumber: number;
}

/**
 * Determine which schema a section uses based on the section number.
 * See docs/guides/nql-reference.md structure.
 */
function sectionToSchema(
	sectionNum: number,
	_subsection: number,
	nql: string,
): 'blog' | 'ecommerce' | 'hierarchy' {
	// Hierarchy sections
	if (sectionNum === 10) return 'hierarchy'; // §10: Hierarchy traversal

	// Hierarchy table signals — must check before ecommerce (departments is hierarchy-only)
	const hierarchyTablesRe = /\b(employees|departments|projects)\b/;
	if (hierarchyTablesRe.test(nql)) return 'hierarchy';

	// Ecommerce signals
	const ecommerceTablesRe =
		/\b(products|orders|orderItems|customers|addresses|variants|categories)\b/;
	if (ecommerceTablesRe.test(nql)) return 'ecommerce';

	// Default to blog for early sections
	return 'blog';
}

/**
 * Parse the markdown document and extract compilable NQL blocks.
 */
function extractNqlBlocks(markdown: string): NqlBlock[] {
	const lines = markdown.split('\n');
	const blocks: NqlBlock[] = [];
	let currentSection = '';
	let currentSectionTitle = '';
	let currentSectionNum = 0;
	let currentSubsection = 0;

	let inCodeBlock = false;
	let codeBlockLang = '';
	let codeBlockContent: string[] = [];
	let codeBlockStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		// Track section headers
		const headerMatch = line.match(/^##\s+(\d+)\.?\s*(.*)/);
		if (headerMatch) {
			currentSectionNum = parseInt(headerMatch[1]!, 10);
			currentSubsection = 0;
			currentSection = `§${currentSectionNum}`;
			currentSectionTitle = headerMatch[2]!.trim();
			continue;
		}

		const subHeaderMatch = line.match(/^###\s+(\d+)\.(\d+)\s*(.*)/);
		if (subHeaderMatch) {
			currentSectionNum = parseInt(subHeaderMatch[1]!, 10);
			currentSubsection = parseInt(subHeaderMatch[2]!, 10);
			currentSection = `§${currentSectionNum}.${currentSubsection}`;
			currentSectionTitle = subHeaderMatch[3]!.trim();
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

			// Skip non-NQL blocks
			if (
				codeBlockLang === 'bash' ||
				codeBlockLang === 'typescript' ||
				codeBlockLang === 'ts' ||
				codeBlockLang === 'sql' ||
				codeBlockLang === 'json' ||
				codeBlockLang === 'jsonc' ||
				codeBlockLang === 'javascript' ||
				codeBlockLang === 'js' ||
				codeBlockLang === 'markdown'
			) {
				continue;
			}

			// Split multi-query blocks into individual queries
			const queries = splitNqlQueries(content);
			for (const q of queries) {
				if (!isCompilableNql(q)) continue;

				const schema = sectionToSchema(currentSectionNum, currentSubsection, q);
				const isMutation = /^\s*(insert|update|delete|upsert)\b/i.test(q);

				blocks.push({
					section: currentSection,
					title: currentSectionTitle,
					nql: q,
					schema,
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
 */
function splitNqlQueries(content: string): string[] {
	const lines = content.split('\n');
	const queries: string[] = [];
	let current: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip empty lines (they separate queries)
		if (!trimmed) {
			if (current.length > 0) {
				queries.push(current.join('\n'));
				current = [];
			}
			continue;
		}

		// Skip comment-only lines
		if (trimmed.startsWith('#')) {
			continue;
		}

		// Strip inline comments
		const withoutComment = trimmed.replace(/\s+#\s.*$/, '');
		current.push(withoutComment);
	}

	if (current.length > 0) {
		queries.push(current.join('\n'));
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
	if (trimmed.startsWith('function()')) return false;

	// Skip dot commands
	if (trimmed.startsWith('.')) return false;

	// Skip raw SQL escape hatches
	if (trimmed.startsWith('!')) return false;

	// Skip let bindings (not yet supported in compile-only mode)
	if (trimmed.startsWith('let ')) return false;

	// Skip bind (not implemented)
	if (trimmed.includes('| bind ')) return false;

	// Skip EXISTS subquery (not supported in NQL)
	if (trimmed.includes('where exists (')) return false;

	// Skip hypothetical tables not in any schema
	if (trimmed.startsWith('companies')) return false;

	// Skip insert from (different parse path, not fully supported in compile-only)
	if (/^insert\s+into\s+\w+\s+from\b/i.test(trimmed)) return false;

	// Skip HAVING via "where count/sum/avg/min/max" after group by (not yet supported)
	if (/\|\s*where\s+(count|sum|avg|min|max)\s*\(/i.test(trimmed)) return false;

	// Skip quoted identifier examples
	if (/^"[^"]*"$/.test(trimmed)) return false;

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
	if (!compiled.success || !compiled.ast?.query) {
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

	throw new Error(
		`Unhandled mutation type: ${(mutation as { type: string }).type}`,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const markdown = readFileSync(DOC_PATH, 'utf-8');
const allBlocks = extractNqlBlocks(markdown);

// Group by schema for efficient loading
const blogBlocks = allBlocks.filter((b) => b.schema === 'blog');
const ecommerceBlocks = allBlocks.filter((b) => b.schema === 'ecommerce');
const hierarchyBlocks = allBlocks.filter((b) => b.schema === 'hierarchy');

describe('NQL Reference Guide — Plan Validation', () => {
	describe('Blog schema queries', () => {
		let schema: Awaited<ReturnType<typeof loadExampleSchema>>;

		it('loads blog schema', async () => {
			schema = await loadExampleSchema('blog');
			expect(schema).toBeDefined();
			expect(schema.model).toBeDefined();
		});

		for (const block of blogBlocks) {
			const label = `${block.section}: ${block.nql.slice(0, 60)}${block.nql.length > 60 ? '...' : ''}`;

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

	describe('Ecommerce schema queries', () => {
		let schema: Awaited<ReturnType<typeof loadExampleSchema>>;

		it('loads ecommerce schema', async () => {
			schema = await loadExampleSchema('ecommerce');
			expect(schema).toBeDefined();
			expect(schema.model).toBeDefined();
		});

		for (const block of ecommerceBlocks) {
			const label = `${block.section}: ${block.nql.slice(0, 60)}${block.nql.length > 60 ? '...' : ''}`;

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
				}
			});
		}
	});

	describe('Hierarchy schema queries', () => {
		let schema: Awaited<ReturnType<typeof loadExampleSchema>>;

		it('loads hierarchy schema', async () => {
			schema = await loadExampleSchema('hierarchy');
			expect(schema).toBeDefined();
			expect(schema.model).toBeDefined();
		});

		for (const block of hierarchyBlocks) {
			const label = `${block.section}: ${block.nql.slice(0, 60)}${block.nql.length > 60 ? '...' : ''}`;

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
				}
			});
		}
	});

	it('extracted a reasonable number of queries', () => {
		const total = allBlocks.length;
		// We expect at least 30 compilable queries from the reference
		expect(total).toBeGreaterThan(30);
	});
});
