/**
 * Schema Diff Handler (GUI-011)
 *
 * Compares a local schema definition against a live database
 * and returns a structured diff for the GUI to display.
 */

import {
	type ChangeKind,
	type ComparePgsqlDatabaseSchemaOptions,
	comparePgsqlDatabaseSchema,
	createPgsqlAdapter,
	type DiffSummary,
	type ExpressionCanonicalizationWarning,
	generateDownSQL,
	generateMigrationSQL,
	type SchemaDiff,
} from '@dbsp/adapter-pgsql';
import type { ModelIR } from '@dbsp/types';
import { getConnectionInfo, getPool } from './connection-manager.js';
import {
	findSchemaFile,
	loadSchema,
	SchemaLoadError,
} from './schema-loader.js';

// ── Request / Response types ────────────────────────────────────

export interface SchemaDiffParams {
	connectionId: string;
	schemaPath?: string;
}

export interface SchemaDiffChange {
	readonly kind: ChangeKind;
	readonly table: string;
	readonly column?: string;
	readonly destructive: boolean;
	readonly details: string;
	readonly meta?: Readonly<Record<string, unknown>>;
}

/** A JSON-safe record of an expression fallback or unpaired surface. */
export interface SchemaDiffComparisonWarning {
	readonly kind: 'check_constraint' | 'column_default';
	readonly table: string;
	readonly name: string;
	readonly outcome?: 'unavailable' | 'rejected' | 'refused';
	readonly comparison: 'raw' | 'unpaired';
	readonly side?: 'desired' | 'database';
	readonly message: string;
}

export interface SchemaDiffResult {
	readonly changes: readonly SchemaDiffChange[];
	readonly hasDestructive: boolean;
	readonly summary: DiffSummary;
	readonly upSQL: readonly string[];
	readonly downSQL: readonly string[];
	readonly warnings: readonly SchemaDiffComparisonWarning[];
}

// ── Handler ─────────────────────────────────────────────────────

/**
 * The smallest useful seam for the handler: one completed live comparison.
 * Tests can fake PostgreSQL's outcome without faking a PgsqlAdapter.
 */
export type SchemaDiffComparisonOperation = (
	connectionId: string,
	desired: ModelIR,
	options: ComparePgsqlDatabaseSchemaOptions,
) => Promise<SchemaDiff>;

/** Run the live comparison against the pool owned by the GUI connection. */
export const compareManagedSchema: SchemaDiffComparisonOperation = async (
	connectionId,
	desired,
	options,
) =>
	comparePgsqlDatabaseSchema(
		createPgsqlAdapter(getPool(connectionId)),
		desired,
		options,
	);

function serializeCanonicalizationWarning(
	warning: ExpressionCanonicalizationWarning,
): SchemaDiffComparisonWarning {
	const surface =
		warning.kind === 'column_default' ? 'column default' : 'CHECK constraint';
	const surfaceLabel =
		warning.kind === 'column_default' ? 'Column default' : 'CHECK constraint';
	const unpaired =
		warning.kind === 'column_default' && warning.comparison === 'unpaired';
	const outcome =
		warning.kind === 'column_default' && warning.outcome !== undefined
			? ` (${warning.outcome})`
			: '';
	return {
		kind: warning.kind,
		table: warning.table,
		name: warning.name,
		...(warning.kind === 'column_default' && warning.outcome !== undefined
			? { outcome: warning.outcome }
			: {}),
		comparison: unpaired ? 'unpaired' : 'raw',
		...(unpaired && warning.side !== undefined ? { side: warning.side } : {}),
		// Adapter diagnostics include the PostgreSQL error's message. Keep that
		// diagnostic in the sidecar only: the renderer gets an identity-based
		// explanation that cannot disclose database details embedded in `cause`.
		message: unpaired
			? `${surfaceLabel} ${warning.table}.${warning.name} had no ${warning.side === 'database' ? 'desired' : 'database'} default counterpart to compare against.`
			: `PostgreSQL could not canonicalize ${surface} ${warning.table}.${warning.name}${outcome}; it was compared as raw text.`,
	};
}

/**
 * Compare a schema file against the live database.
 *
 * @param params - Connection ID and optional schema path
 * @param compare - Injected completed live comparison (testable)
 * @returns Structured diff result for JSON-RPC transport
 */
export async function handleSchemaDiff(
	params: SchemaDiffParams,
	compare: SchemaDiffComparisonOperation = compareManagedSchema,
): Promise<SchemaDiffResult> {
	const { connectionId, schemaPath } = params;

	// 1. Resolve schema file path
	if (!schemaPath) {
		throw new SchemaLoadError(
			'No schema path provided. Open a project folder first.',
		);
	}

	const resolvedPath = findSchemaFile(schemaPath);
	if (!resolvedPath) {
		throw new SchemaLoadError(
			`No schema file found in ${schemaPath}. ` +
				`Expected: dbsp.schema.ts, schema.ts, dbsp.schema.js, or schema.js`,
		);
	}

	// 2. Load the schema definition
	const loaded = await loadSchema(resolvedPath);

	// A diff introspected from a non-default schema is schema-scoped: its custom
	// types and enums carry that schema, so the migration SQL must target it
	// explicitly. `public` keeps the unqualified output.
	const connectionSchema = getConnectionInfo(connectionId)?.schema;
	const warnings: SchemaDiffComparisonWarning[] = [];
	const compareOptions: ComparePgsqlDatabaseSchemaOptions = {
		...(connectionSchema !== undefined ? { schema: connectionSchema } : {}),
		...(loaded.dbCasing !== undefined ? { dbCasing: loaded.dbCasing } : {}),
		onExpressionCanonicalizationWarning: (warning) => {
			warnings.push(serializeCanonicalizationWarning(warning));
		},
	};

	// 3. Compare through PostgreSQL so desired and live expression surfaces use
	// the same canonical spelling as `dbsp push`.
	const diff = await compare(connectionId, loaded.model, compareOptions);

	const sqlOptions =
		connectionSchema !== undefined && connectionSchema !== 'public'
			? { schemaName: connectionSchema }
			: undefined;

	// 4. Generate UP and DOWN SQL
	const upSQL =
		diff.changes.length > 0 ? generateMigrationSQL(diff, sqlOptions) : [];
	const downSQL =
		diff.changes.length > 0 ? generateDownSQL(diff, sqlOptions) : [];

	// 5. Serialize for JSON transport
	return {
		changes: diff.changes.map((c) => ({
			kind: c.kind,
			table: c.table,
			column: c.column,
			destructive: c.destructive,
			details: c.details,
			meta: c.meta,
		})),
		hasDestructive: diff.hasDestructive,
		summary: diff.summary,
		upSQL,
		downSQL,
		warnings,
	};
}
