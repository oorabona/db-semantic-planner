/** Provenance for expressions PostgreSQL deparsed from its own parse tree. */
import type { CheckConstraintIR, IndexIR } from '@dbsp/types';

const ENGINE_CANONICAL_EXPRESSION: unique symbol = Symbol(
	'dbsp.pgsql.engine-canonical-expression',
);

// Provenance is identity-based. A symbol property can be forged by a Proxy
// which returns the symbol key from every symbol-valued `get`; private WeakSet
// membership cannot be observed or reproduced outside this module.
const engineCanonicalSqlDefaults = new WeakSet<object>();
const engineCanonicalChecks = new WeakSet<object>();
const engineCanonicalIndexes = new WeakSet<object>();

/** A string minted only after PostgreSQL deparsed one expression. */
export type EngineCanonicalExpression = string & {
	readonly [ENGINE_CANONICAL_EXPRESSION]: typeof ENGINE_CANONICAL_EXPRESSION;
};

/** A raw default wrapper whose SQL was produced by PostgreSQL's deparser. */
export type EngineCanonicalSqlDefault = {
	readonly sql: EngineCanonicalExpression;
	readonly [ENGINE_CANONICAL_EXPRESSION]: typeof ENGINE_CANONICAL_EXPRESSION;
};

type EngineCanonicalCheck = CheckConstraintIR & {
	readonly [ENGINE_CANONICAL_EXPRESSION]: typeof ENGINE_CANONICAL_EXPRESSION;
};

/** An index whose predicate was read from PostgreSQL's deparser. */
type EngineCanonicalIndex = Omit<IndexIR, 'where'> & {
	readonly where: EngineCanonicalExpression;
	readonly [ENGINE_CANONICAL_EXPRESSION]: typeof ENGINE_CANONICAL_EXPRESSION;
};

export function engineCanonicalSqlDefault(
	expression: EngineCanonicalExpression,
): EngineCanonicalSqlDefault {
	const value = { sql: expression } as EngineCanonicalSqlDefault;
	engineCanonicalSqlDefaults.add(value);
	return Object.freeze(value);
}

export function markEngineCanonicalCheck(
	check: CheckConstraintIR,
): EngineCanonicalCheck {
	engineCanonicalChecks.add(check);
	return Object.freeze(check) as EngineCanonicalCheck;
}

export function isEngineCanonicalCheck(
	check: CheckConstraintIR,
): check is EngineCanonicalCheck {
	return engineCanonicalChecks.has(check);
}

/**
 * Attach non-serializable deparser provenance to the cloned index which owns
 * this predicate. Call this only with text read from PostgreSQL's deparser.
 */
export function markEngineCanonicalIndex(
	index: Omit<IndexIR, 'where'> & { readonly where: EngineCanonicalExpression },
): EngineCanonicalIndex {
	engineCanonicalIndexes.add(index);
	return Object.freeze(index) as EngineCanonicalIndex;
}

export function isEngineCanonicalIndex(
	index: IndexIR | undefined,
): index is EngineCanonicalIndex {
	return index !== undefined && engineCanonicalIndexes.has(index);
}

export function isEngineCanonicalSqlDefault(
	value: unknown,
): value is EngineCanonicalSqlDefault {
	return (
		typeof value === 'object' &&
		value !== null &&
		engineCanonicalSqlDefaults.has(value)
	);
}
