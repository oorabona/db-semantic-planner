/**
 * generate-builder-ts.ts
 *
 * Walks a QueryIntent (IntentAST) and emits the equivalent fluent
 * @dbsp/core builder code. Used by the Playground TypeScript output tab
 * to show users the ORM API equivalent of their NQL query.
 *
 * Coverage targets: the 9 example queries in ALL_EXAMPLES. Mutations
 * (insert/update/delete) currently fail at the NQL tagged-template level
 * and never reach this generator.
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
 * Returns a string of TypeScript source (no trailing newline after the last
 * chain call so callers can append `.all()` or a semicolon).
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
	chain.push(`  .select('${intent.from}')`);

	// distinct / distinctOn
	if (intent.distinctOn && intent.distinctOn.length > 0) {
		const cols = intent.distinctOn.map((c) => `'${c}'`).join(', ');
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

	// groupBy
	if (intent.groupBy && intent.groupBy.length > 0) {
		const fields = intent.groupBy.map((f) => `'${f}'`).join(', ');
		chain.push(`  .groupBy(${fields})`);
	}

	// having
	if (intent.having) {
		const havingStr = buildWhereExpr(intent.having, imports);
		chain.push(`  .having(${havingStr})`);
	}

	// select
	if (intent.select) {
		const selectStr = buildSelectCall(intent.select, imports);
		if (selectStr !== null) {
			chain.push(selectStr);
		}
	}

	// orderBy
	if (intent.orderBy && intent.orderBy.length > 0) {
		for (const ob of intent.orderBy) {
			chain.push(`  .orderBy('${ob.field}', '${ob.direction}')`);
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

function buildSelectCall(
	select: QueryIntent['select'],
	imports: Set<string>,
): string | null {
	if (!select) return null;

	switch (select.type) {
		case 'all':
			// Default — no explicit .select() needed
			return null;

		case 'fields': {
			const sf = select as SelectFieldsIntent;
			const arr = sf.fields.map((f) => `'${f}'`).join(', ');
			return `  .select([${arr}])`;
		}

		case 'aggregate': {
			const sa = select as SelectAggregateIntent;
			return buildAggregateSelect(sa, imports);
		}

		case 'expressions': {
			const se = select as SelectWithExpressionsIntent;
			return buildExpressionsSelect(se, imports);
		}

		default:
			return '  /* unsupported select type — see Dump tab for IR */';
	}
}

function buildAggregateSelect(
	sa: SelectAggregateIntent,
	imports: Set<string>,
): string {
	const entries: string[] = [];

	// Non-aggregate fields first
	if (sa.fields) {
		for (const f of sa.fields) {
			entries.push(`    '${f}': true`);
		}
	}

	for (const agg of sa.aggregates) {
		const fn = agg.function;
		const alias = agg.as ?? fn;

		if (fn === 'count' && (!agg.field || agg.field === '*')) {
			imports.add('count');
			entries.push(`    ${alias}: count()`);
		} else if (agg.field && agg.field !== '*') {
			imports.add(fn);
			entries.push(`    ${alias}: ${fn}('${agg.field}')`);
		} else {
			imports.add('count');
			entries.push(`    ${alias}: count()`);
		}
	}

	if (entries.length === 0) return '  /* empty aggregate select */';
	return `  .select({\n${entries.join(',\n')},\n  })`;
}

function buildExpressionsSelect(
	se: SelectWithExpressionsIntent,
	imports: Set<string>,
): string {
	// If all columns are plain column refs, emit as array
	const allSimple = se.columns.every((c) => c.kind === 'column' && !c.as);

	if (allSimple) {
		const arr = se.columns
			.map((c) => `'${(c as { kind: string; column: string }).column}'`)
			.join(', ');
		return `  .select([${arr}])`;
	}

	// Mixed: emit object form
	const entries: string[] = [];
	for (const col of se.columns) {
		const entry = buildExpressionEntry(col, imports);
		if (entry !== null) {
			entries.push(`    ${entry}`);
		}
	}

	if (entries.length === 0) {
		return '  /* complex expressions — see Dump tab for IR */';
	}

	return `  .select({\n${entries.join(',\n')},\n  })`;
}

function buildExpressionEntry(
	expr: ExpressionIntent,
	imports: Set<string>,
): string | null {
	switch (expr.kind) {
		case 'column': {
			const alias = expr.as ?? expr.column;
			return `${alias}: '${expr.column}'`;
		}
		case 'columnAlias':
			return `${expr.alias}: '${expr.column}'`;
		case 'aggregate': {
			const ae = expr as AggregateExpressionIntent;
			const fn = ae.function;
			const alias = ae.as ?? fn;
			if (fn === 'count' && (!ae.field || ae.field === '*')) {
				imports.add('count');
				return `${alias}: count()`;
			}
			if (ae.field && ae.field !== '*') {
				imports.add(fn);
				return `${alias}: ${fn}('${ae.field}')`;
			}
			imports.add('count');
			return `${alias}: count()`;
		}
		case 'raw':
			return `/* raw: ${expr.sql} */`;
		case 'relationColumn':
			return `'${expr.as}': '${expr.relation}.${expr.column}'`;
		default:
			return `/* complex expr(${expr.kind}) — see Dump */`;
	}
}

// ---------------------------------------------------------------------------
// INCLUDE clause builder
// ---------------------------------------------------------------------------

function buildIncludeCall(inc: IncludeIntent, imports: Set<string>): string {
	// Simple include with no extra options
	const hasWhere = !!inc.where;
	const hasSelect = !!inc.select;

	if (!hasWhere && !hasSelect) {
		return `  .include('${inc.relation}')`;
	}

	// Build options object
	const opts: string[] = [];
	if (hasWhere && inc.where) {
		opts.push(`where: ${buildWhereExpr(inc.where, imports)}`);
	}
	if (hasSelect && inc.select?.type === 'fields') {
		const fields = (inc.select as SelectFieldsIntent).fields
			.map((f) => `'${f}'`)
			.join(', ');
		opts.push(`select: [${fields}]`);
	} else if (hasSelect) {
		opts.push('/* select: complex — see Dump */');
	}

	return `  .include('${inc.relation}', { ${opts.join(', ')} })`;
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
			return `${helper}('${wc.field}', ${val})`;
		}

		case 'like': {
			const wl = where as WhereLikeIntent;
			// No dedicated like() helper in @dbsp/core public API — emit comment
			return `/* like('${wl.field}', '${wl.pattern}') — use WhereLike intent */`;
		}

		case 'in': {
			const wi = where as import('@dbsp/core').WhereInIntent;
			// inArray isn't a named export in core; emit as comment
			if (wi.values.length > 0) {
				const vals = wi.values.map(formatValue).join(', ');
				return `/* in('${wi.field}', [${vals}]) */`;
			}
			return `/* in('${wi.field}', subquery) */`;
		}

		case 'null': {
			const wn = where as import('@dbsp/core').WhereNullIntent;
			if (wn.operator === 'isNull') {
				imports.add('isNull');
				return `isNull('${wn.field}')`;
			}
			imports.add('isNotNull');
			return `isNotNull('${wn.field}')`;
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
	ne: 'ne',
	gt: 'gt',
	lt: 'lt',
	gte: 'gte',
	lte: 'lte',
};

function formatValue(val: unknown): string {
	if (val === null) return 'null';
	if (val === undefined) return 'undefined';
	if (typeof val === 'string') return `'${val.replace(/'/g, "\\'")}'`;
	if (typeof val === 'boolean' || typeof val === 'number') return String(val);
	return JSON.stringify(val);
}
