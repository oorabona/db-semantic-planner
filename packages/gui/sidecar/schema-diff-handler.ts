/**
 * Schema Diff Handler (GUI-011)
 *
 * Compares a local schema definition against a live database
 * and returns a structured diff for the GUI to display.
 */

import {
	type ChangeKind,
	compareSchemata,
	type DiffSummary,
	generateDownSQL,
	generateMigrationPlan,
	type SchemaDiff,
} from '@dbsp/adapter-pgsql';
import {
	getConnectionInfo,
	introspectConnection,
} from './connection-manager.js';
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

export interface SchemaDiffResult {
	readonly changes: readonly SchemaDiffChange[];
	readonly hasDestructive: boolean;
	readonly summary: DiffSummary;
	/** Execution artifact; never flatten these phases for apply. */
	readonly autocommitSQL: readonly string[];
	readonly mainSQL: readonly string[];
	readonly downSQL: readonly string[];
}

// ── Handler ─────────────────────────────────────────────────────

/**
 * Compare a schema file against the live database.
 *
 * @param params - Connection ID and optional schema path
 * @param getModel - Injected introspection function (testable)
 * @returns Structured diff result for JSON-RPC transport
 */
export async function handleSchemaDiff(
	params: SchemaDiffParams,
	getModel: typeof introspectConnection = introspectConnection,
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

	// 3. Introspect the live database
	const db = await getModel(connectionId);

	// 4. Compare
	const diff: SchemaDiff = compareSchemata(loaded.model, db);

	// A diff introspected from a non-default schema is schema-scoped: its custom
	// types and enums carry that schema, so the migration SQL must target it
	// explicitly. `public` keeps the unqualified output.
	const connectionSchema = getConnectionInfo(connectionId)?.schema;
	const sqlOptions =
		connectionSchema !== undefined && connectionSchema !== 'public'
			? { schemaName: connectionSchema }
			: undefined;

	// 5. Generate UP and DOWN SQL
	const plan =
		diff.changes.length > 0
			? generateMigrationPlan(diff, sqlOptions)
			: { autocommit: [], main: [] };
	const downSQL =
		diff.changes.length > 0 ? generateDownSQL(diff, sqlOptions) : [];

	// 6. Serialize for JSON transport
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
		autocommitSQL: plan.autocommit,
		mainSQL: plan.main,
		downSQL,
	};
}
