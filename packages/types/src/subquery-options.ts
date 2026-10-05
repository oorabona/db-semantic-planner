import type { QueryIntent } from './intent-ast.js';

export function assertNoUnsupportedSubqueryModifiers(
	subquery: QueryIntent,
	context: 'IN' | 'scalar' | 'scalar-direct' | 'rawExists',
): void {
	const unsupported: string[] = [];

	// Structural modifiers silently dropped on ALL subquery paths.
	if (subquery.groupBy && subquery.groupBy.length > 0)
		unsupported.push('GROUP BY');
	if (subquery.having) unsupported.push('HAVING');
	if (subquery.offset != null) unsupported.push('OFFSET');
	if (subquery.distinct) unsupported.push('DISTINCT');
	if (subquery.distinctOn && subquery.distinctOn.length > 0)
		unsupported.push('DISTINCT ON');
	if (subquery.include && subquery.include.length > 0)
		unsupported.push('include (relation hydration)');
	if (subquery.joins && subquery.joins.length > 0) unsupported.push('joins');

	// Additional structural modifiers that have no path through buildSubqueryFromIntent.
	if (subquery.existsWrap) unsupported.push('existsWrap');
	if (subquery.lock) unsupported.push('lock');
	if (subquery.batchValuesSource) unsupported.push('batchValuesSource');

	// rawExists and scalar-direct: buildSubqueryFromIntent emits ONLY
	// SELECT/FROM/WHERE — it does NOT emit sortClause or limitCount.
	// The decisions-path scalar context allows limit/orderBy because convertSubquery
	// faithfully propagates them via buildScalarSubquery; the direct path cannot.
	if (context === 'rawExists' || context === 'scalar-direct') {
		if (subquery.limit != null) unsupported.push('LIMIT');
	}

	// rawExists and scalar-direct: buildSubqueryFromIntent also drops orderBy
	// entirely (no sortClause emitted), so both field-based and expression-based
	// ORDER BY produce silently wrong results on the direct path.
	// The decisions-path scalar context allows field-orderBy because that path
	// emits it; the direct path cannot.
	if (context === 'rawExists' || context === 'scalar-direct') {
		if (subquery.orderBy && subquery.orderBy.length > 0) {
			unsupported.push('ORDER BY');
		}
	} else if (subquery.orderBy && subquery.orderBy.length > 0) {
		// On the decisions / IN path: only expression-based orderBy is unsupported
		// (field references are faithfully emitted there).
		const hasExpressionSort = subquery.orderBy.some(
			(o) => !('field' in o) || (o as { field?: unknown }).field == null,
		);
		if (hasExpressionSort)
			unsupported.push(
				'orderBy with expression (only field-based ORDER BY is supported)',
			);
	}

	// IN-subquery-specific SELECT validation
	if (context === 'IN') {
		const select = subquery.select as
			| { type?: string; fields?: readonly string[] }
			| undefined;
		if (!select) {
			// No select clause — would compile to SELECT * which is invalid inside
			// an ANY subquery (PostgreSQL requires a single column expression).
			unsupported.push(
				'missing select (IN subquery must project exactly one named column)',
			);
		} else if (select.type === 'aggregate') {
			// Aggregate SELECT is silently ignored in the IN path (only fields are
			// extracted); use a scalar subquery comparison instead.
			unsupported.push(
				'aggregate SELECT (use a scalar subquery comparison instead)',
			);
		} else if (select.type === 'expressions') {
			// SelectWithExpressionsIntent is not emitted by buildScalarSubquery.
			unsupported.push('expressions SELECT (not supported in IN subquery)');
		} else if (select.type === 'all') {
			// SELECT * inside ANY(...) is rejected by PostgreSQL (cannot compare
			// a row value to a scalar lhs).
			unsupported.push(
				'SELECT * / all (IN subquery must project exactly one named column)',
			);
		} else if (
			select.type === 'fields' ||
			Array.isArray(select.fields) ||
			// Also catch the typeless `{ fields: undefined | null }` shape: the
			// `fields` key is present (triggering isSelectWithFields in the compiler)
			// but the value is not a non-empty array.  Without this branch,
			// `{ fields: undefined }` falls through all checks and the compiler
			// silently falls back to SELECT *, producing wrong SQL.
			// Guard: `in` operator crashes on primitives; a string select like 'id'
			// is a valid single-column selector — only check for the `fields` key on
			// actual objects.
			(typeof select === 'object' &&
				select !== null &&
				'fields' in (select as object))
		) {
			// Both the typed shape `{ type: 'fields', fields: [...] }` and the
			// typeless shape `{ fields: [...] }` (no `type` property) are accepted
			// by the compiler via `isSelectWithFields`.  The guard must cover both
			// so that a typeless multi-field select (or a typeless select with
			// undefined/empty fields) is caught here rather than silently falling
			// back to SELECT * in the compiler.
			if (!select.fields || select.fields.length === 0) {
				// undefined, null, or empty fields list falls back to '*' in the
				// compiler — same problem as 'all'.
				unsupported.push(
					'empty fields list (IN subquery must project exactly one named column)',
				);
			} else if (select.fields.length > 1) {
				// Multi-field projection is silently truncated to fields[0] — the
				// extra columns are dropped without error, producing incorrect SQL
				// (the IN matches only the first column, silently ignoring the rest).
				unsupported.push(
					`multi-field projection [${select.fields.join(', ')}] (IN subquery must project exactly one named column — use a single field)`,
				);
			} else if (typeof select.fields[0] !== 'string') {
				// A single-element fields array whose element is not a string (e.g.
				// an object, number, or null) bypasses the length checks above and
				// produces `selectColumn = <object>` after lowering — which compiles
				// as a broken column reference or falls back to SELECT *.
				// Explicitly reject any non-string element so the caller gets a clear
				// error instead of invalid SQL.
				unsupported.push(
					`non-string field element ${JSON.stringify(select.fields[0])} (IN subquery fields must contain a plain column name string)`,
				);
			}
		}
	}

	// Scalar SELECT validation — applies to both the decisions path ('scalar') and
	// the direct compile-where path ('scalar-direct').  buildSubqueryFromIntent
	// (used by the direct path) emits only fields[0] from a multi-field list,
	// silently truncating the projection; expressions SELECT is not emitted at all.
	// 'scalar-direct' must be at least as strict as 'scalar' on projection checks.
	const isScalarContext = context === 'scalar' || context === 'scalar-direct';
	if (isScalarContext) {
		const select = subquery.select as
			| {
					type?: string;
					fields?: readonly string[];
					aggregates?: readonly unknown[];
			  }
			| undefined;
		if (select?.type === 'expressions') {
			// SelectWithExpressionsIntent is not emitted by buildScalarSubquery or
			// buildSubqueryFromIntent — dropped on both scalar paths.
			unsupported.push('expressions SELECT (not supported in scalar subquery)');
		} else if (
			select?.type === 'fields' &&
			select.fields != null &&
			select.fields.length > 1
		) {
			// Multi-field projection is silently truncated to fields[0] —
			// the extra columns are dropped without error, producing incorrect SQL
			// (the scalar comparison uses only the first column).
			unsupported.push(
				`multi-field projection [${select.fields.join(', ')}] (scalar subquery must project exactly one column — use a single field)`,
			);
		} else if (
			select?.type === 'aggregate' &&
			select.aggregates != null &&
			select.aggregates.length > 1
		) {
			// DEFECT 3 FIX: a scalar subquery must project exactly ONE column.
			// The decisions path takes only aggregates[0] — extra aggregates are
			// silently dropped. The direct compile-where path (buildSubqueryFromIntent)
			// emits ALL aggregates as separate ResTarget nodes, producing a multi-column
			// scalar subquery that PostgreSQL rejects at runtime.
			// Reject early on both paths so callers get a clear error.
			unsupported.push(
				`multi-aggregate projection (scalar subquery must project exactly one column — use a single aggregate)`,
			);
		}
	}

	if (unsupported.length > 0) {
		const label =
			context === 'IN'
				? 'IN'
				: context === 'rawExists'
					? 'rawExists'
					: 'scalar';
		throw new Error(
			`${label} subquery with ${unsupported.join(', ')} is not supported — ` +
				'it would silently change which rows match; restructure the query or use a CTE.',
		);
	}
}
