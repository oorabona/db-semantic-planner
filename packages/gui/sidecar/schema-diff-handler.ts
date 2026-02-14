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
	type SchemaDiff,
} from '@dbsp/adapter-pgsql';
import { introspectConnection } from './connection-manager.js';
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
}

export interface SchemaDiffResult {
	readonly changes: readonly SchemaDiffChange[];
	readonly hasDestructive: boolean;
	readonly summary: DiffSummary;
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

	// 5. Serialize (strip meta from changes for JSON transport)
	return {
		changes: diff.changes.map((c) => ({
			kind: c.kind,
			table: c.table,
			column: c.column,
			destructive: c.destructive,
			details: c.details,
		})),
		hasDestructive: diff.hasDestructive,
		summary: diff.summary,
	};
}
