import type { DeclaredNameResolver } from './declared-name-resolver.js';

const sqlIdentifierBrand: unique symbol = Symbol('SqlIdentifier');

/**
 * A SQL identifier whose authority has been established by the adapter.
 *
 * The brand is intentionally private: this module is the only place that can
 * cross an untyped spelling into the SQL-identifier vocabulary.
 */
export type SqlIdentifier = string & {
	readonly [sqlIdentifierBrand]: 'SqlIdentifier';
};

function identifier(value: string): SqlIdentifier {
	return value as SqlIdentifier;
}

function required(value: string | undefined, address: string): SqlIdentifier {
	if (value === undefined) {
		throw new Error(`Declared ${address} is absent from the physical model.`);
	}
	return identifier(value);
}

/** Resolve a declared logical table address through the physical inventory. */
export function declaredTable(
	resolver: DeclaredNameResolver,
	logicalTable: string,
): SqlIdentifier {
	return required(resolver.table(logicalTable), `table '${logicalTable}'`);
}

/** Resolve a declared logical column address through the physical inventory. */
export function declaredColumn(
	resolver: DeclaredNameResolver,
	logicalTable: string,
	logicalColumn: string,
): SqlIdentifier {
	return required(
		resolver.column(logicalTable, logicalColumn),
		`column '${logicalTable}.${logicalColumn}'`,
	);
}

/** Resolve a declared logical constraint address through the physical inventory. */
export function declaredConstraint(
	resolver: DeclaredNameResolver,
	logicalTable: string,
	logicalConstraint: string,
): SqlIdentifier {
	return required(
		resolver.constraint(logicalTable, logicalConstraint),
		`constraint '${logicalTable}.${logicalConstraint}'`,
	);
}

/** Resolve a declared logical index address through the physical inventory. */
export function declaredIndex(
	resolver: DeclaredNameResolver,
	logicalTable: string,
	logicalIndex: string,
): SqlIdentifier {
	return required(
		resolver.index(logicalTable, logicalIndex),
		`index '${logicalTable}.${logicalIndex}'`,
	);
}

/**
 * Brand a query-local spelling (aliases, CTE/bind names, and output labels)
 * without changing it. Query-local identifiers are already SQL authority.
 */
export function queryLocal(name: string): SqlIdentifier {
	return identifier(name);
}

/**
 * Brand a physical catalog spelling returned by PostgreSQL or supplied to a
 * catalog/DDL helper. Planner compilation must not import this factory.
 */
export function catalogName(name: string): SqlIdentifier {
	return identifier(name);
}

/** Unwrap an established identifier for a pgsql AST string field. */
export function identifierText(identifier: SqlIdentifier): string {
	return identifier;
}
