/**
 * generate-builder-ts.ts
 *
 * Walks a QueryIntent (IntentAST) and emits the equivalent fluent
 * @dbsp/core builder code. Used by the Playground TypeScript output tab
 * to show users the ORM API equivalent of their NQL query.
 *
 * This generator produces a complete, await-able assignment block that
 * includes an import line (when helpers are used), the `const result =
 * await orm` chain, and a terminating `.all();`. Content is rendered
 * read-only inside the playground TypeScript output tab. Some intent
 * shapes (correlated subqueries, batch values, raw expressions) fall back
 * to commented placeholders rather than crashing.
 *
 * Coverage targets: the 9 example queries in ALL_EXAMPLES. Mutations
 * (insert/update/delete) currently fail at the NQL tagged-template level
 * and never reach this generator.
 *
 * ---------------------------------------------------------------------------
 * API SURFACE REFERENCE (verified 2026-05-07 from sources cited below)
 *
 * Source files:
 *   packages/core/src/dx/query-builder.ts
 *   packages/core/src/dx/filters.ts
 *   packages/core/src/dx/expressions.ts
 *   packages/core/src/dx/index.ts
 *   packages/types/src/intent/select-intent.ts
 *   packages/types/src/intent/query-intent.ts
 *
 * QueryBuilderImpl methods (all return QueryBuilder<TResult>):
 *   .columns(columns: readonly ColumnSpec[])              // :185 — array ONLY
 *   .groupBy(fields: readonly string[])                   // :354 — array form
 *   .count(field?: string|DistinctField|AggregateOptions, as?: string) // :268
 *   .sum(field: string|DistinctField, as?: string)        // :304
 *   .avg(field: string|DistinctField, as?: string)        // :319
 *   .min(field: string, as?: string)                      // :334
 *   .max(field: string, as?: string)                      // :344
 *   .having(condition: WhereIntent)                       // :360
 *   .distinctOn(...columns: string[])                     // :387 — spread args
 *   .include(relation: string, options?)                  // :137
 *
 * Helpers exported from @dbsp/core (filters.ts):
 *   eq, neq, gt, gte, lt, lte, isDistinctFrom            // comparison
 *   and, or, not                                          // logical
 *   like(field, pattern, opts?)                           // string; opts: { caseInsensitive?, escape? }
 *   inArray(field, values[])                              // array
 *   isNull(field), isNotNull(field)                       // null
 *   col(column, alias)                                    // :834 — column alias helper
 *   distinct(field)                                       // :102 — DISTINCT modifier for aggregates
 *   relationColumn(relation, column, as)                  // :876 — all 3 args required
 *
 * Aggregation pattern (IMPORTANT):
 *   Aggregates are CHAINED builder methods, NOT entries in .columns([...]).
 *   Group-by fields → .columns(['field1', 'field2'])
 *   COUNT(*) no alias → .count()
 *   COUNT(*) AS alias → .count({ as: 'alias' })   ← options-object form
 *   COUNT(col) → .count('col', 'alias')
 *   COUNT(DISTINCT col) → .count(distinct('col'), 'alias')
 *   SUM(col) → .sum('col', 'alias')
 *   SUM(DISTINCT col) → .sum(distinct('col'), 'alias')
 * ---------------------------------------------------------------------------
 */

import type {
	AggregateExpressionIntent,
	ExpressionIntent,
	IncludeIntent,
	QueryIntent,
	SelectAggregateIntent,
	SelectFieldsIntent,
	SelectWithExpressionsIntent,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotIntent,
	WhereOrIntent,
} from '@dbsp/core';

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const HEADER = `// NOTE: this code is auto-generated from your NQL query.
// It shows the equivalent @dbsp/core builder API call.
//
// Both syntaxes compile to identical SQL via the same planner.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a QueryIntent and emit equivalent @dbsp/core fluent builder code.
 *
 * Returns a complete TypeScript code block that:
 * - Starts with an import line (when filter helpers are used)
 * - Declares `const result = await orm`
 * - Chains all builder methods mirroring the intent
 * - Terminates with `.all();`
 *
 * Unsupported intent shapes (correlated subqueries, batch values, etc.) are
 * emitted as inline comments rather than crashing. The output is read-only
 * and is NOT a complete @dbsp/core substitute — it is meant for display only.
 */
export function generateBuilderTs(intent: QueryIntent): string {
	// Guard: only select intents are supported at this level.
	if (intent.type !== 'select') {
		return [HEADER, '// Mutation builder TS view not yet implemented.'].join(
			'\n',
		);
	}

	const imports = new Set<string>();
	const lines: string[] = [];

	// Build the chain array — we'll join it with newline+indent later.
	const chain: string[] = [];

	// Entry call
	chain.push(`  .select(${tsString(intent.from)})`);

	// distinct / distinctOn
	if (intent.distinctOn && intent.distinctOn.length > 0) {
		const cols = intent.distinctOn.map((c) => tsString(c)).join(', ');
		chain.push(`  .distinctOn(${cols})`);
	} else if (intent.distinct) {
		chain.push('  .distinct()');
	}

	// include
	if (intent.include && intent.include.length > 0) {
		for (const inc of intent.include) {
			chain.push(buildIncludeCall(inc, imports));
		}
	}

	// explicit joins → comment-only
	if (intent.joins && intent.joins.length > 0) {
		chain.push('  /* explicit join — see Dump for IR */');
	}

	// where
	if (intent.where) {
		const whereStr = buildWhereExpr(intent.where, imports);
		chain.push(`  .where(${whereStr})`);
	}

	// groupBy — takes an array, not spread args
	if (intent.groupBy && intent.groupBy.length > 0) {
		const fields = intent.groupBy.map((f) => tsString(f)).join(', ');
		chain.push(`  .groupBy([${fields}])`);
	}

	// having
	if (intent.having) {
		const havingStr = buildWhereExpr(intent.having, imports);
		chain.push(`  .having(${havingStr})`);
	}

	// select — may push multiple chain entries (one .columns() + N aggregate methods)
	if (intent.select) {
		const selectEntries = buildSelectEntries(intent.select, imports);
		for (const entry of selectEntries) {
			chain.push(entry);
		}
	}

	// orderBy
	if (intent.orderBy && intent.orderBy.length > 0) {
		for (const ob of intent.orderBy) {
			if (ob.expression) {
				// Expression-form orderBy — too complex to reconstruct faithfully
				chain.push(
					`  /* .orderBy(<expression>, ${tsString(ob.direction)}) — see Dump tab for IR */`,
				);
			} else if (!ob.field) {
				// Neither field nor expression — emit safe comment
				chain.push(
					'  /* unsupported orderBy intent — neither field nor expression */',
				);
			} else {
				const nullsArg = ob.nulls ? `, { nulls: ${tsString(ob.nulls)} }` : '';
				chain.push(
					`  .orderBy(${tsString(ob.field)}, ${tsString(ob.direction)}${nullsArg})`,
				);
			}
		}
	}

	// limit / offset
	if (intent.limit !== undefined) {
		chain.push(`  .limit(${intent.limit})`);
	}
	if (intent.offset !== undefined) {
		chain.push(`  .offset(${intent.offset})`);
	}

	// unsupported fields — emit stubs
	if (intent.existsWrap) {
		chain.push('  /* unsupported in builder TS view: existsWrap */');
	}
	if (intent.lock) {
		chain.push('  /* unsupported in builder TS view: lock */');
	}
	if (intent.batchValuesSource) {
		chain.push('  /* unsupported in builder TS view: batchValuesSource */');
	}

	// Terminal
	chain.push('  .all()');

	// Assemble import line
	if (imports.size > 0) {
		const sorted = [...imports].sort();
		lines.push(`import { ${sorted.join(', ')} } from '@dbsp/core';`);
		lines.push('');
	}

	// Emit the chain as one expression: each line except the last has no terminator,
	// the last line (.all()) gets the semicolon.
	lines.push('const result = await orm');
	for (let i = 0; i < chain.length; i++) {
		const isLast = i === chain.length - 1;
		lines.push(isLast ? `${chain[i]};` : chain[i]);
	}

	return [HEADER, '', ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// SELECT clause builder
// ---------------------------------------------------------------------------

/**
 * Returns zero or more chain entries for the SELECT clause.
 * Aggregate intents produce multiple entries: one .columns() for non-aggregate
 * fields, then one chained aggregate method per aggregate.
 */
function buildSelectEntries(
	select: QueryIntent['select'],
	imports: Set<string>,
): string[] {
	if (!select) return [];

	switch (select.type) {
		case 'all':
			// Default — no explicit .columns() needed
			return [];

		case 'fields': {
			const sf = select as SelectFieldsIntent;
			const arr = sf.fields.map((f) => tsString(f)).join(', ');
			return [`  .columns([${arr}])`];
		}

		case 'aggregate': {
			const sa = select as SelectAggregateIntent;
			return buildAggregateEntries(sa, imports);
		}

		case 'expressions': {
			const se = select as SelectWithExpressionsIntent;
			const entry = buildExpressionsSelect(se, imports);
			return entry !== null ? [entry] : [];
		}

		default:
			return ['  /* unsupported select type — see Dump tab for IR */'];
	}
}

/**
 * Aggregate select → multiple chain entries.
 *
 * Non-aggregate fields go into `.columns([...fields])`.
 * Each aggregate becomes its own chained method:
 *   `.count()`, `.count({ as: 'alias' })`, `.count('field', 'alias')`, etc.
 * Aggregates are chained builder methods — they do NOT appear inside
 * `.columns([...])` and do NOT require any helper imports.
 *
 * COUNT(*) with alias uses the options-object form: `.count({ as: 'alias' })`
 * COUNT(field) uses: `.count('field', 'alias')`
 * COUNT(DISTINCT field) uses: `.count(distinct('field'), 'alias')`
 */
function buildAggregateEntries(
	sa: SelectAggregateIntent,
	imports: Set<string>,
): string[] {
	const entries: string[] = [];

	// Non-aggregate fields first → .columns([...fields])
	if (sa.fields && sa.fields.length > 0) {
		const arr = sa.fields.map((f) => tsString(f)).join(', ');
		entries.push(`  .columns([${arr}])`);
	}

	// Each aggregate → separate chained method call
	for (const agg of sa.aggregates) {
		const fn = agg.function;
		const alias = agg.as;

		switch (fn) {
			case 'count': {
				if (!agg.field || agg.field === '*') {
					// COUNT(*) — no field argument
					if (alias) {
						// COUNT(*) AS alias — use options-object form: .count({ as: 'alias' })
						entries.push(`  .count({ as: ${tsString(alias)} })`);
					} else {
						entries.push('  .count()');
					}
				} else if (agg.distinct) {
					// COUNT(DISTINCT field)
					imports.add('distinct');
					const aliasArg = alias ? `, ${tsString(alias)}` : '';
					entries.push(`  .count(distinct(${tsString(agg.field)})${aliasArg})`);
				} else {
					const aliasArg = alias ? `, ${tsString(alias)}` : '';
					entries.push(`  .count(${tsString(agg.field)}${aliasArg})`);
				}
				break;
			}
			case 'sum': {
				if (!agg.field || agg.field === '*') {
					entries.push(`  /* unsupported sum aggregate: missing field */`);
					break;
				}
				if (agg.distinct) {
					imports.add('distinct');
					const aliasArg = alias ? `, ${tsString(alias)}` : '';
					entries.push(`  .sum(distinct(${tsString(agg.field)})${aliasArg})`);
				} else {
					const aliasArg = alias ? `, ${tsString(alias)}` : '';
					entries.push(`  .sum(${tsString(agg.field)}${aliasArg})`);
				}
				break;
			}
			case 'avg': {
				if (!agg.field || agg.field === '*') {
					entries.push(`  /* unsupported avg aggregate: missing field */`);
					break;
				}
				if (agg.distinct) {
					imports.add('distinct');
					const aliasArg = alias ? `, ${tsString(alias)}` : '';
					entries.push(`  .avg(distinct(${tsString(agg.field)})${aliasArg})`);
				} else {
					const aliasArg = alias ? `, ${tsString(alias)}` : '';
					entries.push(`  .avg(${tsString(agg.field)}${aliasArg})`);
				}
				break;
			}
			case 'min': {
				if (!agg.field || agg.field === '*') {
					entries.push(`  /* unsupported min aggregate: missing field */`);
					break;
				}
				const aliasArg = alias ? `, ${tsString(alias)}` : '';
				entries.push(`  .min(${tsString(agg.field)}${aliasArg})`);
				break;
			}
			case 'max': {
				if (!agg.field || agg.field === '*') {
					entries.push(`  /* unsupported max aggregate: missing field */`);
					break;
				}
				const aliasArg = alias ? `, ${tsString(alias)}` : '';
				entries.push(`  .max(${tsString(agg.field)}${aliasArg})`);
				break;
			}
			default:
				entries.push(
					`  /* unsupported aggregate function: ${fn} — see Dump tab */`,
				);
		}
	}

	if (entries.length === 0) return ['  /* empty aggregate select */'];
	return entries;
}

function buildExpressionsSelect(
	se: SelectWithExpressionsIntent,
	imports: Set<string>,
): string | null {
	// If all columns are plain column refs with no alias, emit as string array
	const allSimple = se.columns.every((c) => c.kind === 'column' && !c.as);

	if (allSimple) {
		const arr = se.columns
			.map((c) => tsString((c as { kind: string; column: string }).column))
			.join(', ');
		return `  .columns([${arr}])`;
	}

	// Mixed: emit array form with each item serialized as appropriate
	const rawWarnings: string[] = [];
	const arrayItems: string[] = [];

	for (const col of se.columns) {
		if (col.kind === 'raw') {
			rawWarnings.push(
				`// NOTE: raw expression "${(col as { kind: string; sql: string }).sql}" omitted — use raw() from @dbsp/core directly`,
			);
			continue;
		}
		const item = buildExpressionArrayItem(col, imports);
		if (item !== null) {
			arrayItems.push(`    ${item}`);
		}
	}

	if (arrayItems.length === 0) {
		return [
			...rawWarnings,
			'  /* complex expressions — see Dump tab for IR */',
		].join('\n');
	}

	const arrayExpr = `  .columns([\n${arrayItems.join(',\n')},\n  ])`;
	if (rawWarnings.length > 0) {
		return [...rawWarnings, arrayExpr].join('\n');
	}
	return arrayExpr;
}

/**
 * Build a single array item for `.columns([...])`.
 *
 * - Plain column ref → `'colName'`
 * - relationColumn intent → `relationColumn('rel', 'col', 'alias')`
 *   (all 3 args required — alias is mandatory per filters.ts:876)
 * - Aggregate inside expressions → comment (use chained methods instead)
 * - Other → comment fallback
 */
function buildExpressionArrayItem(
	expr: ExpressionIntent,
	imports: Set<string>,
): string | null {
	switch (expr.kind) {
		case 'column': {
			if (expr.as) {
				// col(column, alias) — type-safe column alias helper (filters.ts:834)
				imports.add('col');
				return `col(${tsString(expr.column)}, ${tsString(expr.as)})`;
			}
			return tsString(expr.column);
		}
		case 'columnAlias': {
			// col(column, alias) — type-safe column alias helper (filters.ts:834)
			imports.add('col');
			return `col(${tsString(expr.column)}, ${tsString(expr.as)})`;
		}
		case 'aggregate': {
			// Aggregates in expressions select — point user to chained method form
			const ae = expr as AggregateExpressionIntent;
			const fn = ae.function;
			const alias = ae.as ?? fn;
			if (fn === 'count' && (!ae.field || ae.field === '*')) {
				return `/* use .count({ as: ${tsString(alias)} }) as a chained method instead */`;
			}
			return `/* use .${fn}(${tsString(ae.field)}, ${tsString(alias)}) as a chained method instead */`;
		}
		case 'raw':
			// raw() entries are handled at the buildExpressionsSelect level — never inline
			return null;
		case 'relationColumn': {
			// relationColumn(relation, column, as) — all 3 args required (filters.ts:876)
			const alias = expr.as ?? `${expr.relation}.${expr.column}`;
			imports.add('relationColumn');
			return `relationColumn(${tsString(expr.relation)}, ${tsString(expr.column)}, ${tsString(alias)})`;
		}
		default:
			return `/* complex expr(${expr.kind}) — see Dump */`;
	}
}

// ---------------------------------------------------------------------------
// INCLUDE clause builder
// ---------------------------------------------------------------------------

function buildIncludeCall(inc: IncludeIntent, imports: Set<string>): string {
	const hasWhere = !!inc.where;
	const hasSelect = !!inc.select;
	const hasVia = !!inc.via;
	const hasJoin = !!inc.join;
	const hasRecursive = !!inc.recursive;
	const hasNestedInclude = !!(inc.include && inc.include.length > 0);

	if (
		!hasWhere &&
		!hasSelect &&
		!hasVia &&
		!hasJoin &&
		!hasRecursive &&
		!hasNestedInclude
	) {
		return `  .include(${tsString(inc.relation)})`;
	}

	// Build options object
	const opts: string[] = [];

	if (hasWhere && inc.where) {
		opts.push(`where: ${buildWhereExpr(inc.where, imports)}`);
	}

	if (hasSelect && inc.select?.type === 'fields') {
		const fields = (inc.select as SelectFieldsIntent).fields
			.map((f) => tsString(f))
			.join(', ');
		// IncludeOptions.select is a SelectIntent — emit the structured object form
		opts.push(`select: { type: 'fields', fields: [${fields}] }`);
	} else if (hasSelect) {
		opts.push('/* select: complex — see Dump */');
	}

	if (hasVia && inc.via) {
		opts.push(`via: ${tsString(inc.via)}`);
	}

	if (hasJoin && inc.join) {
		opts.push(`join: ${tsString(inc.join)}`);
	}

	if (hasRecursive) {
		opts.push('recursive: true');
	}

	if (hasNestedInclude && inc.include) {
		// Serialize nested includes as a comment — full recursion is too verbose for display
		const names = inc.include.map((ni) => tsString(ni.relation)).join(', ');
		opts.push(`/* nested includes: [${names}] — see Dump tab for IR */`);
	}

	return `  .include(${tsString(inc.relation)}, { ${opts.join(', ')} })`;
}

// ---------------------------------------------------------------------------
// WHERE clause builder
// ---------------------------------------------------------------------------

function buildWhereExpr(where: WhereIntent, imports: Set<string>): string {
	switch (where.kind) {
		case 'comparison': {
			const wc = where as WhereComparisonIntent;
			const helper = COMPARISON_HELPERS[wc.operator];
			if (!helper) {
				return `/* unsupported operator: ${wc.operator} */`;
			}
			imports.add(helper);
			const val = formatValue(wc.value);
			return `${helper}(${tsString(wc.field)}, ${val})`;
		}

		case 'like': {
			const wl = where as WhereLikeIntent;
			imports.add('like');
			// Use formatValue so single quotes in pattern are properly escaped
			const escapedPattern = formatValue(wl.pattern);
			// Build options object for caseInsensitive / escape (filters.ts:230-250)
			const likeOpts: string[] = [];
			if (wl.caseInsensitive) likeOpts.push('caseInsensitive: true');
			if (wl.escape !== undefined)
				likeOpts.push(`escape: ${formatValue(wl.escape)}`);
			if (likeOpts.length > 0) {
				return `like(${tsString(wl.field)}, ${escapedPattern}, { ${likeOpts.join(', ')} })`;
			}
			return `like(${tsString(wl.field)}, ${escapedPattern})`;
		}

		case 'in': {
			const wi = where as import('@dbsp/core').WhereInIntent;
			if (wi.subquery) {
				// inSubquery — emit a comment since we can't reconstruct the subquery builder.
				// Do NOT add inSubquery to imports — the output does not actually call it.
				return `/* inSubquery(${tsString(wi.field)}, subquery(...)) — see Dump tab for IR */`;
			}
			imports.add('inArray');
			const vals = wi.values.map(formatValue).join(', ');
			return `inArray(${tsString(wi.field)}, [${vals}])`;
		}

		case 'null': {
			const wn = where as import('@dbsp/core').WhereNullIntent;
			if (wn.operator === 'isNull') {
				imports.add('isNull');
				return `isNull(${tsString(wn.field)})`;
			}
			imports.add('isNotNull');
			return `isNotNull(${tsString(wn.field)})`;
		}

		case 'and': {
			const wa = where as WhereAndIntent;
			imports.add('and');
			const parts = wa.conditions
				.map((c) => buildWhereExpr(c, imports))
				.join(', ');
			return `and(${parts})`;
		}

		case 'or': {
			const wo = where as WhereOrIntent;
			imports.add('or');
			const parts = wo.conditions
				.map((c) => buildWhereExpr(c, imports))
				.join(', ');
			return `or(${parts})`;
		}

		case 'not': {
			const wnot = where as WhereNotIntent;
			imports.add('not');
			return `not(${buildWhereExpr(wnot.condition, imports)})`;
		}

		default:
			// Complex WHERE types: emit a fallback comment
			return `/* complex WHERE(${(where as { kind: string }).kind}) — see Dump tab for IR */`;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPARISON_HELPERS: Record<string, string> = {
	eq: 'eq',
	neq: 'neq',
	gt: 'gt',
	lt: 'lt',
	gte: 'gte',
	lte: 'lte',
	isDistinctFrom: 'isDistinctFrom',
};

function formatValue(val: unknown): string {
	if (val === null) return 'null';
	if (val === undefined) return 'undefined';
	if (typeof val === 'string')
		return `'${val
			.replace(/\\/g, '\\\\')
			.replace(/'/g, "\\'")
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r')
			.replace(/\t/g, '\\t')}'`;
	if (typeof val === 'boolean' || typeof val === 'number') return String(val);
	return JSON.stringify(val);
}

/**
 * Emit a string as a safe TypeScript single-quoted literal.
 *
 * Used for IDENTIFIER positions (table names, field names, relation names,
 * aliases, group/order columns) where the value is a known string but
 * must be defence-in-depth escaped against control characters.
 *
 * In practice, identifier validation restricts names to safe chars, but
 * consistent use of this helper prevents any control-char injection.
 */
function tsString(s: string): string {
	return `'${s
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')}'`;
}
