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
	BasicAdapter,
	CompiledQuery,
	CompileOnlyAdapter,
	CompileOptions,
	CompileResultWithIncludes,
	CompilingAdapter,
	CreateIndexOptions,
	DbCasing,
	DDLGeneratingAdapter,
	DropIndexOptions,
	Dump,
	DumpMeta,
	ExecutingAdapter,
	IndexColumnDef,
	IndexInfo,
	IndexMethod,
	IntrospectingAdapter,
	IntrospectionOptions,
	IntrospectionResult,
	RawSqlAdapter,
	StreamingAdapter,
	SubqueryIncludeInfo,
	TableDDLGeneratorAdapter,
	TransactionalAdapter,
	TruncateOptions,
	VacuumOptions,
} from '@dbsp/types';

import type {
	Adapter,
	AdapterCapabilities,
	BaseAdapter,
	DDLGeneratingAdapter,
	ExecutingAdapter,
	IntrospectingAdapter,
	RawSqlAdapter,
	StreamingAdapter,
	TransactionalAdapter,
} from '@dbsp/types';

// ============================================================================
// Feature Detection Helpers (DX-104)
// ============================================================================

/**
 * Check if adapter supports execution.
 */
export function supportsExecution(
	adapter: BaseAdapter,
): adapter is ExecutingAdapter {
	return (
		'execute' in adapter &&
		'executeOne' in adapter &&
		typeof (adapter as ExecutingAdapter).execute === 'function'
	);
}

/**
 * Check if adapter supports streaming.
 */
export function supportsStreaming(
	adapter: BaseAdapter,
): adapter is StreamingAdapter {
	return (
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
