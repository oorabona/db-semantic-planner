/**
 * Adapter interface for database adapters.
 *
 * Type definitions live in @dbsp/types. This module re-exports them
 * and provides runtime functions and error classes.
 *
 * @module adapter
 */

// Re-export all adapter types from @dbsp/types for backward compatibility
export type {
	Adapter,
	AdapterCapabilities,
	AdapterLogger,
	AdapterStreamOptions,
	AliasIncludedColumnsMode,
	AlterColumnOptions,
	BaseAdapter,
	CompiledQuery,
	CompileOnlyAdapter,
	CompileOptions,
	CompileResultWithIncludes,
	CompilingAdapter,
	ConnectionAvailability,
	CreateIndexOptions,
	DbCasing,
	DDLGeneratingAdapter,
	DropIndexOptions,
	Dump,
	DumpMeta,
	DumpSequenceStep,
	ExecutingAdapter,
	IndexColumnDef,
	IndexInfo,
	IndexMethod,
	IntrospectingAdapter,
	IntrospectionOptions,
	IntrospectionResult,
	NqlRuntimeBinding,
	RawSqlAdapter,
	StreamingAdapter,
	SubqueryIncludeInfo,
	TableDDLGeneratorAdapter,
	TransactionalAdapter,
	TransactionOptions,
	TruncateOptions,
	VacuumOptions,
} from '@dbsp/types';

import type {
	Adapter,
	AdapterCapabilities,
	BaseAdapter,
	CompiledQuery,
	DDLGeneratingAdapter,
	ExecutingAdapter,
	IntrospectingAdapter,
	RawSqlAdapter,
	StreamingAdapter,
	TransactionalAdapter,
} from '@dbsp/types';
import { ExecutionError } from './dx/errors.js';

// ============================================================================
// Feature Detection Helpers (DX-104)
// ============================================================================

/**
 * Check if adapter supports execution.
 */
export function supportsExecution(
	adapter: BaseAdapter,
): adapter is ExecutingAdapter {
	const connectionProvider = adapter as BaseAdapter & {
		getPoolInstance?: () => unknown;
	};
	if (typeof connectionProvider.getPoolInstance === 'function') {
		try {
			connectionProvider.getPoolInstance();
		} catch {
			return false;
		}
	}
	return (
		typeof (adapter as ExecutingAdapter).execute === 'function' &&
		typeof (adapter as ExecutingAdapter).executeOne === 'function' &&
		typeof (adapter as ExecutingAdapter).executeOneOrThrow === 'function'
	);
}

/**
 * Refuse execution for adapters that explicitly report no connection.
 *
 * The availability declaration is optional so existing third-party adapters
 * continue through the established capability checks unchanged.
 */
export function assertConnectionAvailable(
	adapter: BaseAdapter,
	operation: string,
): void {
	const availability = adapter.connectionAvailability;
	if (availability?.status === 'unavailable') {
		throw new ExecutionError({
			operation,
			reason: availability.reason,
			fix: availability.fix,
		});
	}
}

/**
 * The execution funnel for compiled queries.
 *
 * Every core terminal delegates to this function immediately before it reaches
 * an adapter's execute() method, so connectionless adapters are refused
 * consistently without each terminal owning an availability check.
 */
export function executeCompiledQuery<T>(
	adapter: Adapter,
	query: CompiledQuery<T>,
	operation: string,
): Promise<T[]> {
	assertConnectionAvailable(adapter, operation);
	return adapter.execute(query);
}

/**
 * Metadata-returning branch of the compiled-query execution funnel.
 */
export function executeCompiledQueryWithMeta(
	adapter: Adapter,
	query: CompiledQuery,
	operation: string,
): Promise<{
	readonly rows: readonly unknown[];
	readonly rowCount: number;
	readonly command?: string;
}> {
	assertConnectionAvailable(adapter, operation);
	if (typeof adapter.executeWithMeta !== 'function') {
		throw new ExecutionError({
			operation,
			reason: 'this adapter does not implement executeWithMeta',
			fix: 'Use an adapter that implements executeWithMeta.',
		});
	}
	return adapter.executeWithMeta(query);
}

/**
 * Check if adapter supports streaming.
 */
export function supportsStreaming(
	adapter: BaseAdapter,
): adapter is StreamingAdapter {
	return (
		adapter.capabilities?.supportsStreaming === true &&
		'stream' in adapter &&
		typeof (adapter as StreamingAdapter).stream === 'function'
	);
}

/**
 * Check if adapter supports introspection.
 */
export function supportsIntrospection(
	adapter: BaseAdapter,
): adapter is IntrospectingAdapter {
	return (
		'introspect' in adapter &&
		typeof (adapter as IntrospectingAdapter).introspect === 'function'
	);
}

/**
 * Check if adapter supports transactions.
 */
export function supportsTransactions<DB>(
	adapter: BaseAdapter,
): adapter is TransactionalAdapter<DB> {
	return (
		adapter.capabilities?.supportsTransactions === true &&
		'transaction' in adapter &&
		'withSchema' in adapter &&
		typeof (adapter as TransactionalAdapter<DB>).transaction === 'function'
	);
}

/**
 * Check if adapter supports raw SQL execution.
 */
export function supportsRawSql(adapter: BaseAdapter): adapter is RawSqlAdapter {
	return (
		'executeRaw' in adapter &&
		typeof (adapter as RawSqlAdapter).executeRaw === 'function'
	);
}

/**
 * Check if adapter supports DDL generation.
 */
export function supportsDDLGeneration(
	adapter: BaseAdapter,
): adapter is DDLGeneratingAdapter {
	return (
		'generateDDL' in adapter &&
		typeof (adapter as DDLGeneratingAdapter).generateDDL === 'function'
	);
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when an operation requires an adapter but none was provided.
 */
export class AdapterRequiredError extends Error {
	constructor(operation: string) {
		super(
			`Operation '${operation}' requires an adapter. ` +
				'Pass an adapter when creating the ORM: createOrm({ model, adapter })',
		);
		this.name = 'AdapterRequiredError';
	}
}

/**
 * Error thrown when an operation requires a capability the adapter doesn't support.
 */
export class UnsupportedCapabilityError extends Error {
	constructor(operation: string, capability: keyof AdapterCapabilities) {
		super(
			`Operation '${operation}' requires capability '${capability}' ` +
				'which is not supported by the current adapter.',
		);
		this.name = 'UnsupportedCapabilityError';
	}
}

/**
 * Assert that an adapter supports a required capability.
 */
export function assertCapability(
	adapter: Adapter,
	capability: keyof AdapterCapabilities,
	operation: string,
): void {
	if (!adapter.capabilities[capability]) {
		throw new UnsupportedCapabilityError(operation, capability);
	}
}
