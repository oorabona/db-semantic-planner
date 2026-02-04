/**
 * NQL Audit Script — Compiles all NQL queries from nql-reference.md
 * and dumps SQL + planner decisions for automated review.
 *
 * Detects common bugs:
 * - Quoted dot-separated identifiers (alias not stripped)
 * - Quoted star ("*" instead of *)
 * - Empty count() without agg_star
 * - Lost conditions in EXISTS subqueries
 * - Repeated parameters
 *
 * Usage: npx tsx scripts/audit-nql.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InsertFromIntent, ModelIR, PlanDecision } from '@dbsp/core';
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

async function loadExampleSchema(
	name: string,
): Promise<{ model: ModelIR }> {
	const schemaPath = resolve(ROOT_DIR, `examples/${name}.schema.ts`);
	const mod = await import(schemaPath);
	return mod.default;
}

function sectionToSchema(
	sectionNum: number,
	nql: string,
): 'blog' | 'ecommerce' | 'hierarchy' {
	if (sectionNum === 10) return 'hierarchy';
	const hierarchyRe = /\b(employees|departments|projects)\b/;
	if (hierarchyRe.test(nql)) return 'hierarchy';
	const ecommerceRe =
		/\b(products|orders|orderItems|customers|addresses|variants|categories)\b/;
	if (ecommerceRe.test(nql)) return 'ecommerce';
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
		current.push(trimmed.replace(/\s+#\s.*$/, ''));
	}
	if (current.length > 0) queries.push(current.join('\n'));
	return queries;
}

function isCompilableNql(nql: string): boolean {
	const t = nql.trim();
	if (t.includes('| operator')) return false;
	if (
		t.includes('<table>') ||
		t.includes('<col>') ||
		t.includes('<val>') ||
		t.includes('<column>')
	)
		return false;
	if (
		t.startsWith('function()') ||
		t.startsWith('.') ||
		t.startsWith('!') ||
		t.startsWith('let ')
	)
		return false;
	if (
		t.includes('| bind ') ||
		t.includes('where exists (') ||
		t.startsWith('companies')
	)
		return false;
	if (/^insert\s+into\s+\w+\s+from\b/i.test(t)) return false;
	if (/\|\s*where\s+(count|sum|avg|min|max)\s*\(/i.test(t)) return false;
	if (/^"[^"]*"$/.test(t) || !/^[a-zA-Z]/.test(t)) return false;
	return true;
}

interface AuditEntry {
	index: number;
	line: number;
	section: string;
	schema: string;
	nql: string;
	status: 'OK' | 'ERROR';
	sql?: string;
	params?: readonly unknown[];
	decisions?: Array<{
		type: string;
		context: string;
		choice: string;
		reasoning: string;
	}>;
	warnings?: string[];
	error?: string;
	flags: string[];
}

function flagIssues(entry: AuditEntry): string[] {
	const flags: string[] = [];
	const sql = entry.sql ?? '';

	// Check for quoted dot-separated identifiers (alias bug pattern)
	const quotedDotPattern = /"[a-z]+\.[a-z_]+"/gi;
	const dotMatches = sql.match(quotedDotPattern);
	if (dotMatches) {
		flags.push(`QUOTED_DOT_COLUMN: ${dotMatches.join(', ')}`);
	}

	// Check for quoted star (wildcard bug)
	if (sql.includes('"*"')) {
		flags.push('QUOTED_STAR: "*" should be unquoted *');
	}

	// Check for empty count() without star
	if (/count\(\s*\)/i.test(sql) && !sql.includes('count(*)')) {
		flags.push('EMPTY_COUNT: count() should be count(*)');
	}

	// Check for missing EXISTS conditions (relation filter with condition but only FK correlation)
	if (entry.nql.match(/\b(some|none|every)\([^)]*,\s*[^)]+\)/)) {
		const existsBlocks =
			sql.match(/EXISTS\s*\(SELECT\s+1[\s\S]*?\)/gi) ?? [];
		for (const sub of existsBlocks) {
			const andCount = (sub.match(/\bAND\b/gi) ?? []).length;
			if (andCount === 0) {
				flags.push(
					'MISSING_FILTER_IN_EXISTS: Relation filter has condition but EXISTS only has FK correlation',
				);
			}
		}
	}

	// Check for duplicate parameters (> 2 is suspicious)
	const paramCounts = new Map<string, number>();
	for (const p of entry.params ?? []) {
		const key = JSON.stringify(p);
		paramCounts.set(key, (paramCounts.get(key) ?? 0) + 1);
	}
	for (const [key, count] of paramCounts) {
		if (count > 2) {
			flags.push(`PARAM_REPEATED_${count}x: ${key}`);
		}
	}

	return flags;
}

async function main() {
	const schemas = {
		blog: await loadExampleSchema('blog'),
		ecommerce: await loadExampleSchema('ecommerce'),
		hierarchy: await loadExampleSchema('hierarchy'),
	};

	const markdown = readFileSync(DOC_PATH, 'utf-8');
	const lines = markdown.split('\n');

	let currentSectionNum = 0;
	let currentSectionTitle = '';
	let inCodeBlock = false;
	let codeBlockLang = '';
	let codeBlockContent: string[] = [];
	let codeBlockStartLine = 0;
	let inDetailsBlock = false;

	const entries: AuditEntry[] = [];
	let index = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		// Skip existing enrichment blocks
		if (
			line.trim() === '<details>' &&
			lines[i + 1]?.trim().startsWith('<summary>Compiled SQL')
		) {
			inDetailsBlock = true;
			continue;
		}
		if (inDetailsBlock) {
			if (line.trim() === '</details>') inDetailsBlock = false;
			continue;
		}

		const headerMatch = line.match(/^##\s+(\d+)\.?\s*(.*)/);
		if (headerMatch) {
			currentSectionNum = parseInt(headerMatch[1]!, 10);
			currentSectionTitle = headerMatch[2]!.trim();
		}

		if (line.startsWith('```') && !inCodeBlock) {
			inCodeBlock = true;
			codeBlockLang = line.slice(3).trim().toLowerCase();
			codeBlockContent = [];
			codeBlockStartLine = i + 1;
			continue;
		}

		if (line.startsWith('```') && inCodeBlock) {
			inCodeBlock = false;

			if (
				[
					'bash',
					'typescript',
					'ts',
					'sql',
					'json',
					'jsonc',
					'javascript',
					'js',
					'markdown',
				].includes(codeBlockLang)
			) {
				continue;
			}

			const content = codeBlockContent.join('\n').trim();
			const queries = splitNqlQueries(content).filter(isCompilableNql);

			for (const nql of queries) {
				const schemaName = sectionToSchema(currentSectionNum, nql);
				const schemaObj = schemas[schemaName];
				const entry: AuditEntry = {
					index: index++,
					line: codeBlockStartLine,
					section: `§${currentSectionNum} ${currentSectionTitle}`,
					schema: schemaName,
					nql,
					status: 'OK',
					flags: [],
				};

				try {
					const isMutation =
						/^\s*(insert|update|delete|upsert)\b/i.test(nql);
					if (isMutation) {
						const compiled = compile(nql, schemaObj.model);
						if (!compiled.success || !compiled.ast?.mutation) {
							throw new Error(
								`Parse failed: ${compiled.errors.map((e: { message: string }) => e.message).join(', ')}`,
							);
						}
						const mutation = compiled.ast.mutation;
						const adapter = createPgsqlCompileOnlyAdapter();
						const options = { model: schemaObj.model };
						let result: {
							sql: string;
							parameters: readonly unknown[];
						};
						if (isInsertIntent(mutation))
							result = adapter.compileInsert(mutation, options);
						else if (isUpdateIntent(mutation))
							result = adapter.compileUpdate(mutation, options);
						else if (isDeleteIntent(mutation))
							result = adapter.compileDelete(mutation, options);
						else if (isUpsertIntent(mutation))
							result = adapter.compileUpsert(mutation, options);
						else if (
							(mutation as InsertFromIntent).type ===
							'insert_from'
						)
							result = adapter.compileInsertFrom(
								mutation as InsertFromIntent,
								options,
							);
						else throw new Error('Unknown mutation type');
						entry.sql = result.sql;
						entry.params = result.parameters;
					} else {
						const compiled = compile(nql, schemaObj.model);
						if (!compiled.success || !compiled.ast?.query) {
							throw new Error(
								`Parse failed: ${compiled.errors.map((e: { message: string }) => e.message).join(', ')}`,
							);
						}
						const planReport = plan(
							compiled.ast.query,
							schemaObj.model,
							{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
						);
						const adapter = createPgsqlCompileOnlyAdapter();
						const result = adapter.compile(planReport, {
							model: schemaObj.model,
						});
						entry.sql = result.sql;
						entry.params = result.parameters;
						entry.decisions = planReport.decisions.map(
							(d: PlanDecision) => ({
								type: d.type,
								context: d.context.target
									? `${d.context.sourceTable} → ${d.context.target}`
									: d.context.sourceTable,
								choice: d.choice,
								reasoning: d.reasoning,
							}),
						);
						entry.warnings = (
							(planReport as Record<string, unknown>)
								.warnings as Array<{
								message?: string;
							}> | null
						)?.map(
							(w: { message?: string }) =>
								w.message ?? String(w),
						) ?? [];
					}
				} catch (err) {
					entry.status = 'ERROR';
					entry.error = (err as Error).message;
				}

				entry.flags = flagIssues(entry);
				entries.push(entry);
			}
			continue;
		}

		if (inCodeBlock) codeBlockContent.push(line);
	}

	// Output summary
	const ok = entries.filter((e) => e.status === 'OK');
	const errored = entries.filter((e) => e.status === 'ERROR');
	const flagged = entries.filter((e) => e.flags.length > 0);

	console.log('\n=== NQL AUDIT REPORT ===');
	console.log(`Total queries: ${entries.length}`);
	console.log(`  OK: ${ok.length}`);
	console.log(`  ERROR: ${errored.length}`);
	console.log(`  FLAGGED: ${flagged.length}`);

	if (errored.length > 0) {
		console.log('\n--- ERRORS ---');
		for (const e of errored) {
			console.log(
				`\n  #${e.index} [${e.section}] (line ${e.line}, schema: ${e.schema})`,
			);
			console.log(`  NQL: ${e.nql}`);
			console.log(`  Error: ${e.error}`);
		}
	}

	if (flagged.length > 0) {
		console.log('\n--- FLAGGED QUERIES ---');
		for (const e of flagged) {
			console.log(
				`\n  #${e.index} [${e.section}] (line ${e.line}, schema: ${e.schema})`,
			);
			console.log(`  NQL: ${e.nql}`);
			console.log(`  FLAGS: ${e.flags.join('; ')}`);
			console.log(`  SQL: ${e.sql}`);
		}
	}

	// Dump all entries as JSON for detailed review
	console.log('\n--- FULL DUMP (JSON) ---');
	for (const e of entries) {
		console.log(
			JSON.stringify({
				i: e.index,
				s: e.section,
				schema: e.schema,
				nql: e.nql,
				status: e.status,
				sql: e.sql,
				params: e.params,
				decisions: e.decisions,
				warnings: e.warnings,
				flags: e.flags,
				error: e.error,
			}),
		);
	}

	// Exit code based on flags/errors
	if (errored.length > 0 || flagged.length > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
