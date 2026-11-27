import { NotYetSupportedError } from './include-errors.js';
import type { QueryIntent } from './intent-ast.js';

/** Open issue of every not-yet condition-body construct (ADR 0010). */
const CONDITION_BODY_ISSUE = 1087;
/** A scalar body names the issue the expression scalar body names for the same construct. */
const SCALAR_BODY_ISSUES: Readonly<Record<string, number>> = {
	joins: 1039,
	batchValuesSource: 1031,
	'flat include': 1030,
};

/**
 * Refuse the clauses a condition subquery body (rawExists, IN, scalar
 * comparison) cannot carry. A construct with no meaning in the body is a
 * semantic refusal (a plain `Error`); a meaningful one whose path does not
 * exist yet is a `NotYetSupportedError` naming the first such construct.
 * Semantic refusals win, except under `existsWrap`, whose output replaces the
 * whole projection with one boolean. Aggregate and expressions lists are not
 * counted: their arity is decided where the body is realised.
 */
export function assertNoUnsupportedSubqueryModifiers(
	subquery: QueryIntent,
	context: 'IN' | 'scalar' | 'scalar-direct' | 'rawExists',
): void {
	const label =
		context === 'IN' ? 'IN' : context === 'rawExists' ? 'rawExists' : 'scalar';
	const notYet: string[] = [];
	const semantic: string[] = [];

	// The resolved root SELECT WHERE body contract refuses unsupported modifiers
	// at plan(); legacy direct routes (including mutations) refuse at compilation.
	if (subquery.groupBy && subquery.groupBy.length > 0) notYet.push('GROUP BY');
	if (subquery.having) notYet.push('HAVING');
	if (subquery.offset != null) notYet.push('OFFSET');
	if (subquery.distinct) notYet.push('DISTINCT');
	if (subquery.distinctOn && subquery.distinctOn.length > 0)
		notYet.push('DISTINCT ON');
	if (subquery.include && subquery.include.length > 0) {
		// An include joins and filters an existence test; in a body compared
		// with a value, only a flat include (a join) has a reading.
		if (label === 'rawExists') notYet.push('include');
		else if (subquery.include.every((include) => include.strategy === 'flat'))
			notYet.push('flat include');
		else semantic.push('include (relation hydration)');
	}
	if (subquery.joins && subquery.joins.length > 0) notYet.push('joins');

	// Additional structural modifiers that have no path through buildSubqueryFromIntent.
	if (subquery.existsWrap) notYet.push('existsWrap');
	if (subquery.lock) notYet.push('lock');
	if (subquery.batchValuesSource) notYet.push('batchValuesSource');

	// rawExists and scalar-direct: buildSubqueryFromIntent emits ONLY
	// SELECT/FROM/WHERE — it does NOT emit sortClause or limitCount.
	// The resolved root WHERE scalar body contract retains LIMIT and field ORDER BY;
	// legacy scalar-direct routes cannot emit them.
	if (context === 'rawExists' || context === 'scalar-direct') {
		if (subquery.limit != null) notYet.push('LIMIT');
	}

	// rawExists and scalar-direct: buildSubqueryFromIntent also drops orderBy
	// entirely (no sortClause emitted), so both field-based and expression-based
	// ORDER BY produce silently wrong results on the direct path.
	// The resolved root WHERE scalar body contract retains field ORDER BY;
	// legacy scalar-direct routes cannot emit it.
	if (context === 'rawExists' || context === 'scalar-direct') {
		if (subquery.orderBy && subquery.orderBy.length > 0) {
			notYet.push('ORDER BY');
		}
	} else if (subquery.orderBy && subquery.orderBy.length > 0) {
		// On the resolved root WHERE / legacy IN routes: only expression-based orderBy is unsupported
		// (field references are faithfully emitted there).
		const hasExpressionSort = subquery.orderBy.some(
			(o) => !('field' in o) || (o as { field?: unknown }).field == null,
		);
		if (hasExpressionSort) notYet.push('ORDER BY with an expression');
	}

	// IN-subquery-specific SELECT validation
	if (context === 'IN') {
		const select = subquery.select as
			| { type?: string; fields?: readonly string[] }
			| undefined;
		if (!select) {
			// No select clause — would compile to SELECT * which is invalid inside
			// an ANY subquery (PostgreSQL requires a single column expression).
			semantic.push(
				'missing select (IN subquery must project exactly one named column)',
			);
		} else if (select.type === 'aggregate') {
			// The IN path extracts fields only; the arity is decided once realised.
			notYet.push('aggregate SELECT');
		} else if (select.type === 'expressions') {
			// SelectWithExpressionsIntent is not emitted by buildScalarSubquery.
			notYet.push('expressions SELECT');
		} else if (select.type === 'all') {
			// SELECT * inside ANY(...) is rejected by PostgreSQL (cannot compare
			// a row value to a scalar lhs).
			semantic.push(
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
				semantic.push(
					'empty fields list (IN subquery must project exactly one named column)',
				);
			} else if (select.fields.length > 1) {
				// Multi-field projection is silently truncated to fields[0] — the
				// extra columns are dropped without error, producing incorrect SQL
				// (the IN matches only the first column, silently ignoring the rest).
				semantic.push(
					`multi-field projection [${select.fields.join(', ')}] (IN subquery must project exactly one named column — use a single field)`,
				);
			} else if (typeof select.fields[0] !== 'string') {
				// A single-element fields array whose element is not a string (e.g.
				// an object, number, or null) bypasses the length checks above and
				// produces `selectColumn = <object>` after lowering — which compiles
				// as a broken column reference or falls back to SELECT *.
				// Explicitly reject any non-string element so the caller gets a clear
				// error instead of invalid SQL.
				semantic.push(
					`non-string field element ${JSON.stringify(select.fields[0])} (IN subquery fields must contain a plain column name string)`,
				);
			}
		}
	}

	// Scalar SELECT validation — applies to the resolved root WHERE body contract ('scalar') and
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
			notYet.push('expressions SELECT');
		} else if (
			select?.type === 'fields' &&
			select.fields != null &&
			select.fields.length > 1
		) {
			// Multi-field projection is silently truncated to fields[0] —
			// the extra columns are dropped without error, producing incorrect SQL
			// (the scalar comparison uses only the first column).
			semantic.push(
				`multi-field projection [${select.fields.join(', ')}] (scalar subquery must project exactly one column — use a single field)`,
			);
		} else if (
			select?.type === 'aggregate' &&
			select.aggregates != null &&
			select.aggregates.length > 1
		) {
			// The legacy scalar compiler takes only aggregates[0] and the direct
			// path emits every aggregate, so both refuse the list. Its length is not
			// the arity (the compiler deduplicates repeated aggregates); the path
			// that realises the body decides it.
			notYet.push('aggregate SELECT');
		}
	}

	if (semantic.length > 0 && !subquery.existsWrap)
		throw new Error(
			`${label} subquery with ${semantic.join(', ')} is not supported.`,
		);
	const construct = notYet[0];
	if (construct !== undefined)
		throw new NotYetSupportedError(
			construct,
			`${label} subquery body`,
			(label === 'scalar' ? SCALAR_BODY_ISSUES[construct] : undefined) ??
				CONDITION_BODY_ISSUE,
		);
}
