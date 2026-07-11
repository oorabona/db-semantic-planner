/**
 * Schema-scope guard.
 *
 * `generateDDL` / `generateMigrationSQL` / `generateDownSQL` throw iff the SQL
 * they are about to return would be internally schema-inconsistent: custom
 * types or managed enums would be qualified with a non-default schema while
 * table SQL stays unqualified. Omitting `schemaName` has always meant "target
 * the session's current_schema"; the guard only closes the case where generated
 * type SQL points somewhere else.
 *
 * That inconsistency can only be proven from target-scoped column types
 * (`ColumnIR.originalDbTypeSchemaScope === 'target'`) and managed enums
 * (`EnumIR.schema`), so those are exactly the fields collected here.
 *
 * Type and enum statements are self-qualifying: they carry their own schema in
 * the type name. A migration or model that emits only CREATE/ALTER/DROP TYPE
 * is therefore coherent without `schemaName`. Schema scope becomes hazardous
 * only when the same emitted set also contains table SQL, because table names
 * are the objects left to PostgreSQL's `current_schema`.
 *
 * Declared bounds:
 * - DOWN generation still guards on emitted changes' metadata, not only on the
 *   exact SQL text that DOWN re-emits. A rollback that emits unqualified
 *   DROP/ALTER TABLE for schema-scoped metadata has the same wrong-schema
 *   hazard as UP.
 * - Type/enum-only changes (`create_enum`, `alter_enum_add_value`, and
 *   `drop_enum` without dependent-column casts) do not require `schemaName`.
 *   `drop_enum` can emit ALTER TABLE casts when `referencingColumns` is present;
 *   that is table SQL and remains guarded.
 * - Legacy qualified `originalDbType` strings, such as `'"tenant_1".status'`,
 *   deliberately do not trigger this guard. The structural schema fields have
 *   not shipped yet, and treating legacy strings as model-scope proof would
 *   make previously working released models start throwing.
 * - Changes with no target type provenance remain undetectable: `drop_table`,
 *   `drop_column`, nullable/default/PK/FK/index/comment/RLS changes, and other
 *   table-only metadata cannot prove schema scope. `SchemaChange` and `TableIR`
 *   do not record which schema a TABLE belongs to (`TableIR` has no `schema`
 *   field), so detecting that requires IR-level table schema provenance and
 *   managed-vs-external ownership, tracked separately in #303.
 *
 * @module ddl/schema-scope
 */

import type { ColumnIR, EnumIR, ModelIR, TableIR } from '@dbsp/types';
import type { SchemaChange } from './schema-diff.js';

type ColumnScopeFields = {
	readonly originalDbTypeSchema?: unknown;
	readonly originalDbTypeSchemaScope?: unknown;
};

type EnumScopeFields = {
	readonly schema?: unknown;
};

type ModelScopeCollectionOptions = {
	readonly includeEnums?: boolean;
};

/** Names the entry point and the emitted artifact, so the error points at the right call. */
export type SchemaScopeSubject = {
	readonly entryPoint: string;
	readonly noun: string;
	readonly artifact: string;
};

export type SchemaScopeAccumulator = {
	readonly schemas: Set<string>;
	hasTableSql: boolean;
};

export const MODEL_SCHEMA_SCOPE_SUBJECT: SchemaScopeSubject = {
	entryPoint: 'generateDDL',
	noun: 'model',
	artifact: 'DDL',
};

export const MIGRATION_SCHEMA_SCOPE_SUBJECT: SchemaScopeSubject = {
	entryPoint: 'Migration SQL generation',
	noun: 'diff',
	artifact: 'migration',
};

/** Default-visible namespaces — objects there need no qualification. */
function isScopedSchema(schema: unknown): schema is string {
	return (
		typeof schema === 'string' &&
		schema !== '' &&
		schema !== 'public' &&
		schema !== 'pg_catalog'
	);
}

/**
 * A column proves the model is schema-scoped ONLY when its type is TARGET-scoped
 * (it moves with the model) AND lives in a non-default schema. `absolute` types
 * are external dependencies — they say nothing about where the model's own
 * objects belong.
 */
function columnScopeSchema(
	column: ColumnIR | ColumnScopeFields,
): string | undefined {
	return column.originalDbTypeSchemaScope === 'target' &&
		isScopedSchema(column.originalDbTypeSchema)
		? column.originalDbTypeSchema
		: undefined;
}

/** Enums in ModelIR.enums / change.meta.enum are MANAGED objects — their schema is the model's. */
function enumScopeSchema(
	enumDef: EnumIR | EnumScopeFields,
): string | undefined {
	return isScopedSchema(enumDef.schema) ? enumDef.schema : undefined;
}

export function collectModelScopeEvidence(
	model: ModelIR,
	options: ModelScopeCollectionOptions = {},
): SchemaScopeAccumulator {
	const accumulator = createSchemaScopeAccumulator();
	accumulator.hasTableSql = model.tables.size > 0;
	for (const table of model.tables.values()) {
		collectTableScopeSchemas(table, accumulator.schemas);
	}
	if (options.includeEnums !== false && model.enums) {
		for (const enumDef of model.enums.values()) {
			addScopeSchema(accumulator.schemas, enumScopeSchema(enumDef));
		}
	}
	return accumulator;
}

export function createSchemaScopeAccumulator(): SchemaScopeAccumulator {
	return {
		schemas: new Set<string>(),
		hasTableSql: false,
	};
}

export function collectChangeScopeEvidence(
	change: SchemaChange,
	accumulator: SchemaScopeAccumulator,
): void {
	if (changeEmitsTableSql(change)) {
		accumulator.hasTableSql = true;
	}

	const meta = change.meta;
	if (!isRecord(meta)) return;

	collectColumnScopeSchema(meta.column, accumulator.schemas);
	collectColumnScopeSchema(meta.fromColumn, accumulator.schemas);
	collectUnknownTableScopeSchemas(meta.table, accumulator.schemas);
	collectEnumScopeSchema(meta.enum, accumulator.schemas);
}

function collectTableScopeSchemas(table: TableIR, schemas: Set<string>): void {
	for (const column of table.columns) {
		addScopeSchema(schemas, columnScopeSchema(column));
	}
}

function collectUnknownTableScopeSchemas(
	value: unknown,
	schemas: Set<string>,
): void {
	if (!isRecord(value) || !Array.isArray(value.columns)) return;

	for (const column of value.columns) {
		collectColumnScopeSchema(column, schemas);
	}
}

function collectColumnScopeSchema(value: unknown, schemas: Set<string>): void {
	if (!isRecord(value)) return;

	addScopeSchema(schemas, columnScopeSchema(value));
}

function collectEnumScopeSchema(value: unknown, schemas: Set<string>): void {
	if (!isRecord(value)) return;

	addScopeSchema(schemas, enumScopeSchema(value));
}

function addScopeSchema(
	schemas: Set<string>,
	schema: string | undefined,
): void {
	if (schema !== undefined) {
		schemas.add(schema);
	}
}

export function assertSchemaName(
	accumulator: SchemaScopeAccumulator,
	schemaName: string | undefined,
	subject: SchemaScopeSubject,
): void {
	if (
		!accumulator.hasTableSql ||
		hasExplicitSchemaName(schemaName) ||
		accumulator.schemas.size === 0
	) {
		return;
	}

	throw new Error(
		buildSchemaNameRequiredMessage([...accumulator.schemas].sort(), subject),
	);
}

function hasExplicitSchemaName(schemaName: string | undefined): boolean {
	return schemaName !== undefined && schemaName !== '';
}

function buildSchemaNameRequiredMessage(
	schemas: readonly string[],
	subject: SchemaScopeSubject,
): string {
	const list = schemas.map((schema) => JSON.stringify(schema)).join(', ');
	return (
		`${subject.entryPoint} requires an explicit schemaName: this ${subject.noun} is schema-scoped — ` +
		`its custom types/enums live in ${list}. ` +
		`Pass options.schemaName with the schema this ${subject.artifact} targets ` +
		'(the source schema to re-emit it as-is, or another schema to retarget it).'
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null;
}

function changeEmitsTableSql(change: SchemaChange): boolean {
	return change.table !== '' || hasReferencingColumns(change.meta);
}

function hasReferencingColumns(meta: unknown): boolean {
	if (!isRecord(meta)) return false;

	const refs = meta.referencingColumns;
	return Array.isArray(refs) && refs.length > 0;
}
