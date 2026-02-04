/**
 * NQL Reference Guide — Doc Enrichment Script
 *
 * Extracts NQL queries from docs/guides/nql-reference.md,
 * compiles each against its schema, and enriches the document
 * with collapsible SQL + plan details + pedagogical explanations.
 *
 * Usage: npx tsx scripts/enrich-nql-reference.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
	InsertFromIntent,
	ModelIR,
	PlanDecision,
	PlanReport,
	UpsertFromIntent,
} from '@dbsp/core';
import {
	isDeleteIntent,
	isInsertIntent,
	isUpdateIntent,
	isUpsertIntent,
	POSTGRESQL_CAPABILITIES,
	plan,
} from '@dbsp/core';
import { compile } from '@dbsp/nql';
import { createPgsqlCompileOnlyAdapter } from '../packages/adapter-pgsql/src/pgsql-adapter.js';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const DOC_PATH = resolve(ROOT_DIR, 'docs/guides/nql-reference.md');

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

async function loadExampleSchema(
	name: string,
): Promise<{ model: ModelIR }> {
	const schemaPath = resolve(ROOT_DIR, `examples/${name}.schema.ts`);
	const mod = await import(schemaPath);
	return mod.default;
}

// ---------------------------------------------------------------------------
// NQL block extraction (same logic as tests/e2e/nql-reference-plans.test.ts)
// ---------------------------------------------------------------------------

function sectionToSchema(
	sectionNum: number,
	_subsection: number,
	nql: string,
): 'blog' | 'ecommerce' | 'hierarchy' {
	if (sectionNum === 10) return 'hierarchy';

	const hierarchyTablesRe = /\b(employees|departments|projects)\b/;
	if (hierarchyTablesRe.test(nql)) return 'hierarchy';

	const ecommerceTablesRe =
		/\b(products|orders|orderItems|customers|addresses|variants|categories)\b/;
	if (ecommerceTablesRe.test(nql)) return 'ecommerce';

	return 'blog';
}

function splitNqlQueries(content: string): string[] {
	const lines = content.split('\n');
	const queries: string[] = [];
	let current: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		if (!trimmed) {
			if (current.length > 0) {
				queries.push(current.join('\n'));
				current = [];
			}
			continue;
		}

		if (trimmed.startsWith('#')) continue;

		const withoutComment = trimmed.replace(/\s+#\s.*$/, '');
		current.push(withoutComment);
	}

	if (current.length > 0) {
		queries.push(current.join('\n'));
	}

	return queries;
}

function isCompilableNql(nql: string): boolean {
	const trimmed = nql.trim();

	if (trimmed.includes('| operator')) return false;
	if (trimmed.includes('<table>')) return false;
	if (trimmed.includes('<col>')) return false;
	if (trimmed.includes('<val>')) return false;
	if (trimmed.includes('<column>')) return false;
	if (trimmed.startsWith('function()')) return false;
	if (trimmed.startsWith('.')) return false;
	if (trimmed.startsWith('!')) return false;
	if (trimmed.startsWith('let ')) return false;
	if (trimmed.includes('| bind ')) return false;
	if (trimmed.includes('where exists (')) return false;
	if (trimmed.startsWith('companies')) return false;
	if (/^insert\s+into\s+\w+\s+from\b/i.test(trimmed)) return false;
	if (/\|\s*where\s+(count|sum|avg|min|max)\s*\(/i.test(trimmed)) return false;
	if (/^"[^"]*"$/.test(trimmed)) return false;
	if (!/^[a-zA-Z]/.test(trimmed)) return false;

	return true;
}

// ---------------------------------------------------------------------------
// Compilation helpers
// ---------------------------------------------------------------------------

interface CompileResult {
	sql: string;
	params: readonly unknown[];
	planReport?: PlanReport;
}

function compileQuery(
	nql: string,
	schemaObj: { model: ModelIR },
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
	schemaObj: { model: ModelIR },
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
	if ((mutation as InsertFromIntent).type === 'insert_from') {
		const result = adapter.compileInsertFrom(
			mutation as InsertFromIntent,
			options,
		);
		return { sql: result.sql, params: result.parameters };
	}
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
// Pedagogical explanations per query category
// ---------------------------------------------------------------------------

function getPedagogicalNote(
	nql: string,
	sql: string,
	decisions: readonly PlanDecision[],
): string {
	const nqlLen = nql.length;
	const sqlLen = sql.length;

	// Detect query category from NQL content
	const hasInclude = /\|\s*include\b/.test(nql);
	const hasGroupBy = /\|\s*group\s+by\b/.test(nql);
	const hasWindow = /\b(row_number|rank|dense_rank|lag|lead|sum|count|avg)\s*\(\)\s*over\b/i.test(nql);
	const hasCaseWhen = /\|\s*select\b.*\bcase\b/i.test(nql);
	const isMutation = /^\s*(insert|update|delete|upsert)\b/i.test(nql);
	const hasSubquery = /\bin\s*\(/.test(nql) && /\|\s*select\b/.test(nql);
	const hasRecursive = /\brecursive\b/i.test(nql);
	const hasLateral = decisions.some(
		(d) => d.choice === 'lateral-join' || d.choice === 'lateral',
	);
	const hasJsonAgg = decisions.some(
		(d) => d.choice === 'json_agg' || d.choice === 'json-subquery',
	);
	const hasCte = decisions.some((d) => d.type === 'cte-extraction');
	const hasWhere = /\|\s*where\b/.test(nql);
	const hasOrderLimit = /\|\s*order\s+by\b/.test(nql) || /\|\s*limit\b/.test(nql);

	// Build focused pedagogical note based on what's interesting
	if (hasRecursive) {
		return (
			'Recursive hierarchies in raw SQL require `WITH RECURSIVE` — a pattern that\'s easy to get wrong ' +
			'(missing base case, infinite loops). NQL\'s `include recursive` handles the recursion depth, ' +
			'base/step separation, and cycle prevention automatically.'
		);
	}

	if (hasInclude && hasLateral) {
		return (
			'This include uses a `LATERAL` subquery — one of PostgreSQL\'s most powerful features. ' +
			'LATERAL allows per-parent row limits on child collections. Writing LATERAL joins by hand ' +
			'requires careful correlation and aliasing. NQL generates it from a simple `| limit <relation> N`.'
		);
	}

	if (hasInclude && hasJsonAgg) {
		return (
			'The planner chose `json_agg` to nest child rows into a single JSON array per parent — ' +
			'avoiding the "row explosion" that happens with regular JOINs on one-to-many relations. ' +
			'In raw SQL, you\'d need `json_agg(jsonb_build_object(...))` with a subquery or GROUP BY. ' +
			'NQL handles this with a simple `| include`.'
		);
	}

	if (hasInclude) {
		return (
			'`include` replaces the manual work of writing JOINs, choosing the right join type, ' +
			'qualifying column names across tables, and handling nullable foreign keys. ' +
			'The planner picks the optimal strategy (JOIN, json_agg, LATERAL, or CTE) ' +
			'based on the relation type and query shape.'
		);
	}

	if (hasWindow) {
		return (
			'Window functions in raw SQL require the full `OVER (PARTITION BY ... ORDER BY ...)` clause ' +
			'on each expression. NQL\'s pipe syntax makes the window definition read naturally ' +
			'as part of the select list, and the planner validates partition/order columns exist.'
		);
	}

	if (hasGroupBy) {
		return (
			'The planner automatically validates that all non-aggregate columns appear in the GROUP BY clause — ' +
			'a common SQL error. NQL\'s pipe syntax keeps the grouping, filtering, and aggregation ' +
			'steps visually separated, making the query intent clear at a glance.'
		);
	}

	if (hasCaseWhen) {
		return (
			'CASE expressions in the SELECT list let you compute derived columns inline. ' +
			'The planner ensures the expression is well-formed and parameter binds any literal values, ' +
			'preventing SQL injection even in conditional logic.'
		);
	}

	if (isMutation) {
		const mutationType = nql.match(/^\s*(insert|update|delete|upsert)\b/i)?.[1]?.toUpperCase();
		if (mutationType === 'UPSERT') {
			return (
				'`UPSERT` compiles to `INSERT ... ON CONFLICT DO UPDATE` — PostgreSQL\'s atomic ' +
				'"insert-or-update" operation. NQL makes the conflict resolution readable in one line ' +
				'instead of the multi-clause SQL pattern.'
			);
		}
		return (
			`\`${mutationType}\` mutations are automatically parameterized — every value becomes a \`$N\` ` +
			'placeholder, preventing SQL injection. Column names are validated against the schema ' +
			'and double-quoted in the output SQL.'
		);
	}

	if (hasSubquery) {
		return (
			'Subqueries in NQL compose naturally — the inner query is just another NQL pipe expression ' +
			'inside parentheses. The planner compiles it as a correlated or uncorrelated subquery ' +
			'depending on context, handling aliasing and parameter numbering automatically.'
		);
	}

	if (hasCte) {
		return (
			'The planner extracted a Common Table Expression (CTE) to make the query more efficient ' +
			'and readable. CTEs are a powerful SQL pattern, but writing them manually requires ' +
			'careful scoping. NQL generates them when the query structure benefits from it.'
		);
	}

	if (hasWhere && hasOrderLimit) {
		return (
			`NQL's pipe syntax reads like a sentence: "start from table, filter, sort, take N." ` +
			`The equivalent SQL requires WHERE, ORDER BY, and LIMIT clauses in specific positions. ` +
			`All values are automatically parameter-bound (\`$1\`, \`$2\`, ...) for safety.`
		);
	}

	if (hasWhere) {
		return (
			'Filter values are automatically parameter-bound (`$1`, `$2`, ...) — never interpolated ' +
			'into the SQL string. The planner also qualifies column names with table aliases, ' +
			'so you never need to worry about ambiguous references.'
		);
	}

	// Basic table scan / select
	if (nqlLen < 30 && !hasWhere) {
		return (
			'Even the simplest query benefits from the planner: table names are double-quoted ' +
			'(safe for reserved words), aliases are generated, and the result is a fully ' +
			'parameterized query ready for `pg.Pool.query()`.'
		);
	}

	// Generic fallback
	const ratio = sqlLen > 0 ? (sqlLen / nqlLen).toFixed(1) : '?';
	return (
		`This ${nqlLen}-character NQL expression compiles to ${sqlLen} characters of SQL ` +
		`(${ratio}× expansion). The planner handles identifier quoting, table aliasing, ` +
		'parameter binding, and column qualification automatically.'
	);
}

// ---------------------------------------------------------------------------
// SQL formatting
// ---------------------------------------------------------------------------

function formatSQL(sql: string): string {
	// Light formatting: add newlines before major SQL keywords for readability
	return sql
		.replace(/\bFROM\b/g, '\n  FROM')
		.replace(/\bWHERE\b/g, '\n  WHERE')
		.replace(/\bINNER JOIN\b/g, '\n  INNER JOIN')
		.replace(/\bLEFT JOIN\b/g, '\n  LEFT JOIN')
		.replace(/\bLATERAL\b/g, '\n  LATERAL')
		.replace(/\bORDER BY\b/g, '\n  ORDER BY')
		.replace(/\bGROUP BY\b/g, '\n  GROUP BY')
		.replace(/\bHAVING\b/g, '\n  HAVING')
		.replace(/\bLIMIT\b/g, '\n  LIMIT')
		.replace(/\bON CONFLICT\b/g, '\n  ON CONFLICT')
		.replace(/\bRETURNING\b/g, '\n  RETURNING')
		.replace(/\bWITH\b/g, 'WITH\n  ')
		.replace(/\bUNION ALL\b/g, '\nUNION ALL\n');
}

function formatParams(params: readonly unknown[]): string {
	if (params.length === 0) return '_none_';
	return `\`[${params.map((p) => JSON.stringify(p)).join(', ')}]\``;
}

// ---------------------------------------------------------------------------
// Decision table formatting
// ---------------------------------------------------------------------------

function formatDecisionsTable(decisions: readonly PlanDecision[]): string {
	if (decisions.length === 0) return '';

	const rows = decisions.map((d) => {
		const context = d.context.target
			? `${d.context.sourceTable} → ${d.context.target}`
			: d.context.sourceTable;
		return `| ${d.type} | ${context} | ${d.choice} | ${d.reasoning} |`;
	});

	return [
		'| Decision | Context | Choice | Reasoning |',
		'|----------|---------|--------|-----------|',
		...rows,
	].join('\n');
}

// ---------------------------------------------------------------------------
// Enrichment block generation
// ---------------------------------------------------------------------------

function generateEnrichmentBlock(result: CompileResult, nql: string, label?: string): string {
	const lines: string[] = [];
	const summary = label
		? `Compiled SQL & Plan — \`${label}\``
		: 'Compiled SQL & Plan';
	lines.push('');
	lines.push('<details>');
	lines.push(`<summary>${summary}</summary>`);
	lines.push('');

	// SQL
	lines.push('**SQL:**');
	lines.push('```sql');
	lines.push(formatSQL(result.sql));
	lines.push('```');
	lines.push('');

	// Parameters
	lines.push(`**Parameters:** ${formatParams(result.params)}`);
	lines.push('');

	// Decisions table (queries only)
	if (result.planReport && result.planReport.decisions.length > 0) {
		lines.push('**Planner decisions:**');
		lines.push(formatDecisionsTable(result.planReport.decisions));
		lines.push('');
	}

	// Pedagogical note
	const note = getPedagogicalNote(
		nql,
		result.sql,
		result.planReport?.decisions ?? [],
	);
	lines.push(`**Why NQL?** ${note}`);
	lines.push('');
	lines.push('</details>');
	lines.push('');

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main enrichment logic
// ---------------------------------------------------------------------------

async function main() {
	console.log('Loading schemas...');
	const schemas = {
		blog: await loadExampleSchema('blog'),
		ecommerce: await loadExampleSchema('ecommerce'),
		hierarchy: await loadExampleSchema('hierarchy'),
	};

	const markdown = readFileSync(DOC_PATH, 'utf-8');
	const lines = markdown.split('\n');
	const output: string[] = [];

	let currentSectionNum = 0;
	let currentSubsection = 0;

	let inCodeBlock = false;
	let codeBlockLang = '';
	let codeBlockContent: string[] = [];
	let codeBlockStartIdx = 0;

	// Track existing enrichment blocks to avoid duplicates on re-run
	let inDetailsBlock = false;

	let compiled = 0;
	let skipped = 0;
	let errors = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		// Skip existing enrichment blocks (idempotent re-run)
		if (line.trim() === '<details>' && i + 1 < lines.length) {
			const nextLine = lines[i + 1]?.trim() ?? '';
			if (nextLine.startsWith('<summary>Compiled SQL')) {
				inDetailsBlock = true;
				continue;
			}
		}
		if (inDetailsBlock) {
			if (line.trim() === '</details>') {
				inDetailsBlock = false;
				// Skip the blank line after </details> if present
				if (i + 1 < lines.length && lines[i + 1]?.trim() === '') {
					i++;
				}
			}
			continue;
		}

		// Track section headers
		const headerMatch = line.match(/^##\s+(\d+)\.?\s*(.*)/);
		if (headerMatch) {
			currentSectionNum = parseInt(headerMatch[1]!, 10);
			currentSubsection = 0;
		}

		const subHeaderMatch = line.match(/^###\s+(\d+)\.(\d+)\s*(.*)/);
		if (subHeaderMatch) {
			currentSectionNum = parseInt(subHeaderMatch[1]!, 10);
			currentSubsection = parseInt(subHeaderMatch[2]!, 10);
		}

		// Track code blocks
		if (line.startsWith('```') && !inCodeBlock) {
			inCodeBlock = true;
			codeBlockLang = line.slice(3).trim().toLowerCase();
			codeBlockContent = [];
			codeBlockStartIdx = i;
			output.push(line);
			continue;
		}

		if (line.startsWith('```') && inCodeBlock) {
			inCodeBlock = false;
			output.push(line);

			// Only process blocks explicitly tagged as NQL
			if (codeBlockLang !== 'nql') {
				continue;
			}

			const content = codeBlockContent.join('\n').trim();
			const queries = splitNqlQueries(content);
			const compilableQueries = queries.filter(isCompilableNql);

			if (compilableQueries.length === 0) {
				skipped++;
				continue;
			}

			// Compile and generate enrichment for ALL compilable queries in the block
			const isMultiQuery = compilableQueries.length > 1;
			let blockCompiled = 0;
			for (const nql of compilableQueries) {
				const schemaName = sectionToSchema(
					currentSectionNum,
					currentSubsection,
					nql,
				);
				const schemaObj = schemas[schemaName];

				try {
					const isMutation = /^\s*(insert|update|delete|upsert)\b/i.test(nql);
					const result = isMutation
						? compileMutation(nql, schemaObj)
						: compileQuery(nql, schemaObj);

					// For multi-query blocks, add a truncated NQL label to distinguish enrichments
					const label = isMultiQuery
						? nql.replace(/\n/g, ' ').slice(0, 60) + (nql.length > 60 ? '…' : '')
						: undefined;
					const enrichment = generateEnrichmentBlock(result, nql, label);
					output.push(enrichment);
					blockCompiled++;
				} catch (err) {
					errors++;
					console.error(
						`  ❌ Failed to compile (line ${codeBlockStartIdx + 1}): ${nql.slice(0, 60)}`,
					);
					console.error(`     ${(err as Error).message}`);
				}
			}
			compiled += blockCompiled;

			continue;
		}

		if (inCodeBlock) {
			codeBlockContent.push(line);
		}

		output.push(line);
	}

	// Write enriched document
	const enrichedContent = output.join('\n');
	writeFileSync(DOC_PATH, enrichedContent, 'utf-8');

	console.log('');
	console.log('✅ Enrichment complete:');
	console.log(`   Compiled: ${compiled} blocks`);
	console.log(`   Skipped:  ${skipped} blocks (non-compilable NQL)`);
	console.log(`   Errors:   ${errors} blocks`);
	console.log(`   Output:   ${DOC_PATH}`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
