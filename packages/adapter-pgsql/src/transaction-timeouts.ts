import type { TransactionOptions } from '@dbsp/types';

export type PgsqlTransactionTimeoutParameter =
	| 'lock_timeout'
	| 'statement_timeout';

export interface PgsqlTransactionTimeoutStatement {
	readonly parameter: PgsqlTransactionTimeoutParameter;
	readonly sql: string;
}

const DEFAULT_TRANSACTION_TIMEOUT_MS = 5000;
const MAX_TRANSACTION_TIMEOUT_MS = 600_000;

export function clampTransactionTimeoutMs(timeoutMs: number): number {
	if (!Number.isFinite(timeoutMs)) {
		return DEFAULT_TRANSACTION_TIMEOUT_MS;
	}
	return Math.max(
		1,
		Math.min(Math.trunc(timeoutMs), MAX_TRANSACTION_TIMEOUT_MS),
	);
}

export function hasTransactionLockTimeoutOption(
	options: TransactionOptions | undefined,
): boolean {
	return options?.lockTimeoutMs !== undefined;
}

export function hasTransactionStatementTimeoutOption(
	options: TransactionOptions | undefined,
): boolean {
	return options?.statementTimeoutMs !== undefined;
}

export function hasTransactionTimeoutOptions(
	options: TransactionOptions | undefined,
): boolean {
	return (
		hasTransactionLockTimeoutOption(options) ||
		hasTransactionStatementTimeoutOption(options)
	);
}

export function quotePgLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function setLocalTransactionTimeoutSql(
	parameter: PgsqlTransactionTimeoutParameter,
	value: string,
): string {
	return `SET LOCAL ${parameter} = ${quotePgLiteral(value)}`;
}

export function transactionTimeoutStatements(
	options: TransactionOptions | undefined,
): readonly PgsqlTransactionTimeoutStatement[] {
	const statements: PgsqlTransactionTimeoutStatement[] = [];
	if (options?.lockTimeoutMs !== undefined) {
		statements.push({
			parameter: 'lock_timeout',
			sql: setLocalTransactionTimeoutSql(
				'lock_timeout',
				`${clampTransactionTimeoutMs(options.lockTimeoutMs)}ms`,
			),
		});
	}
	if (options?.statementTimeoutMs !== undefined) {
		statements.push({
			parameter: 'statement_timeout',
			sql: setLocalTransactionTimeoutSql(
				'statement_timeout',
				`${clampTransactionTimeoutMs(options.statementTimeoutMs)}ms`,
			),
		});
	}
	return statements;
}
