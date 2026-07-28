/** Provenance for expressions PostgreSQL deparsed from its own parse tree. */
import type { CheckConstraintIR } from '@dbsp/types';

const ENGINE_CANONICAL_EXPRESSION: unique symbol = Symbol(
	'dbsp.pgsql.engine-canonical-expression',
);

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

export function engineCanonicalSqlDefault(
	expression: EngineCanonicalExpression,
): EngineCanonicalSqlDefault {
	const value = { sql: expression } as EngineCanonicalSqlDefault;
	Object.defineProperty(value, ENGINE_CANONICAL_EXPRESSION, {
		value: ENGINE_CANONICAL_EXPRESSION,
	});
	return Object.freeze(value);
}

export function markEngineCanonicalCheck(
	check: CheckConstraintIR,
): EngineCanonicalCheck {
	Object.defineProperty(check, ENGINE_CANONICAL_EXPRESSION, {
		value: ENGINE_CANONICAL_EXPRESSION,
	});
	return Object.freeze(check) as EngineCanonicalCheck;
}

export function isEngineCanonicalCheck(
	check: CheckConstraintIR,
): check is EngineCanonicalCheck {
	return (
		(check as EngineCanonicalCheck)[ENGINE_CANONICAL_EXPRESSION] ===
		ENGINE_CANONICAL_EXPRESSION
	);
}

export function isEngineCanonicalSqlDefault(
	value: unknown,
): value is EngineCanonicalSqlDefault {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as EngineCanonicalSqlDefault)[ENGINE_CANONICAL_EXPRESSION] ===
			ENGINE_CANONICAL_EXPRESSION
	);
}
