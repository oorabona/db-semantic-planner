import { renderCheckConstraintClause } from '../check-expression.js';
import { dbTypesEqual } from '../db-type.js';
import { identityNaming } from '../naming-plugin.js';
import { validateCheckExpression, validateIdentifier } from '../validate.js';
import { generateCreateIndex } from './ddl-generator.js';
import type {
	GeneratedConstraintPostcondition,
	GeneratedIndexPostcondition,
	GeneratedPostcondition,
} from './managed-step-manifest.js';
import { quoteIdent } from './phases/utils.js';

type GeneratedPostconditionQuery = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

const generatedPostconditionSessionBrand = Symbol(
	'generatedPostconditionSessionBrand',
);
const mintedSessions = new WeakSet<object>();

/** An adapter-minted, exclusive PostgreSQL session for rollback-only proof. */
export type GeneratedPostconditionSession = GeneratedPostconditionQuery & {
	readonly [generatedPostconditionSessionBrand]: true;
};

/**
 * This mint is intentionally not re-exported from the adapter public surface.
 * Transition admission uses it for its already-pinned client; external callers
 * use withGeneratedPostconditionSession(), which checks out and releases one.
 */
export function mintGeneratedPostconditionSession(
	session: GeneratedPostconditionQuery,
): GeneratedPostconditionSession {
	const capability = Object.freeze({
		query: session.query.bind(session),
		[generatedPostconditionSessionBrand]: true as const,
	});
	mintedSessions.add(capability);
	return capability;
}

export async function withGeneratedPostconditionSession<T>(
	executor: {
		connect(): Promise<
			GeneratedPostconditionQuery & { release(error?: unknown): void }
		>;
	},
	work: (session: GeneratedPostconditionSession) => Promise<T>,
): Promise<T> {
	const client = await executor.connect();
	let failure: unknown;
	try {
		return await work(mintGeneratedPostconditionSession(client));
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		client.release(failure);
	}
}

export type GeneratedPostconditionTarget = {
	readonly schema: string;
	readonly table: string;
	readonly name: string;
};

type IndexProjection = {
	readonly schema: string;
	readonly table: string;
	readonly name: string;
	readonly method: string;
	readonly unique: boolean;
	readonly valid: boolean;
	readonly ready: boolean;
	readonly live: boolean;
	readonly nullsNotDistinct: boolean;
	readonly primary: boolean;
	readonly exclusion: boolean;
	readonly immediate: boolean;
	readonly constraintOwned: boolean;
	readonly keyColumns: readonly (string | null)[];
	readonly keyDefinitions: readonly string[];
	readonly includeColumns: readonly string[];
	readonly opclasses: readonly string[];
	readonly keyOptions: readonly string[];
	readonly reloptions: readonly string[];
	readonly predicate: string | null;
};

type CheckProjection = {
	readonly expression: string;
	readonly validated: boolean;
	readonly noInherit: boolean;
	readonly enforced: boolean;
	readonly isLocal: boolean;
	readonly inheritanceCount: number;
	readonly parentId: number;
};

type TableColumnProjection = {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly default: string | undefined;
	readonly collation: string | null;
	readonly identity: 'always' | 'byDefault' | null;
};

type TableProjection = {
	readonly columns: readonly TableColumnProjection[];
};

let scratchSequence = 0;

function nextScratchName(kind: string): string {
	scratchSequence += 1;
	return `dbsp_postcondition_${kind}_${Date.now()}_${scratchSequence}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replan(message: string): Error {
	return new Error(
		`${message}; replan to produce version 2 typed postconditions`,
	);
}

function exactKeys(
	value: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	const allowed = new Set(fields);
	return Object.keys(value).every((field) => allowed.has(field));
}

function stringList(value: unknown, message: string): readonly string[] {
	if (!Array.isArray(value)) throw replan(message);
	const snapshot = Array.from(value);
	const result: string[] = [];
	for (const item of snapshot) {
		if (typeof item !== 'string') throw replan(message);
		result.push(item);
	}
	return result;
}

function stringRecord(
	value: unknown,
	message: string,
): Readonly<Record<string, string>> {
	if (!isRecord(value)) throw replan(message);
	const entries = Object.entries(value);
	for (const [_key, item] of entries) {
		if (typeof item !== 'string') throw replan(message);
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

function strictString(value: unknown, message: string): string {
	if (typeof value !== 'string') throw replan(message);
	return value;
}

function strictBoolean(value: unknown, message: string): boolean {
	if (typeof value !== 'boolean') throw replan(message);
	return value;
}

function strictUnknownArray(
	value: unknown,
	message: string,
): readonly unknown[] {
	if (!Array.isArray(value)) throw replan(message);
	return Array.from(value);
}

function checkedIdentifier(
	value: unknown,
	type: 'table' | 'column' | 'schema' | 'alias',
	message: string,
): string {
	const identifier = strictString(value, message);
	try {
		validateIdentifier(identifier, type);
	} catch {
		throw replan(message);
	}
	return identifier;
}

/** Decode and snapshot the complete supported COLUMN projection of a v2 postcondition. */
export function decodeColumnPostcondition(
	value: unknown,
): Extract<GeneratedPostcondition, { readonly kind: 'column' }>['column'] {
	const unsupported = 'generated column postcondition is unsupported';
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			'name',
			'type',
			'nullable',
			'hasDefault',
			'default',
			'collation',
			'identity',
		])
	)
		throw replan(unsupported);
	const name = checkedIdentifier(value.name, 'column', unsupported);
	const type = value.type;
	const nullable = value.nullable;
	const hasDefault = value.hasDefault;
	const defaultValue = value.default;
	const collation = value.collation;
	const identity = value.identity;
	const decodedType =
		type === undefined ? undefined : strictString(type, unsupported);
	const decodedNullable =
		nullable === undefined ? undefined : strictBoolean(nullable, unsupported);
	const decodedHasDefault =
		hasDefault === undefined
			? undefined
			: strictBoolean(hasDefault, unsupported);
	let decodedDefault: string | undefined;
	if (decodedHasDefault === true) {
		if (defaultValue === undefined) throw replan(unsupported);
		decodedDefault = strictString(defaultValue, unsupported);
	} else if (defaultValue !== undefined) {
		throw replan(unsupported);
	}
	const decodedCollation =
		collation === undefined || collation === null
			? collation
			: strictString(collation, unsupported);
	let decodedIdentity: 'always' | 'byDefault' | null | undefined;
	if (identity === undefined || identity === null) decodedIdentity = identity;
	else if (identity === 'always' || identity === 'byDefault')
		decodedIdentity = identity;
	else throw replan(unsupported);
	return {
		name,
		...(decodedType === undefined ? {} : { type: decodedType }),
		...(decodedNullable === undefined ? {} : { nullable: decodedNullable }),
		...(decodedHasDefault === undefined
			? {}
			: { hasDefault: decodedHasDefault }),
		...(decodedDefault === undefined ? {} : { default: decodedDefault }),
		...(decodedCollation === undefined ? {} : { collation: decodedCollation }),
		...(decodedIdentity === undefined ? {} : { identity: decodedIdentity }),
	};
}

/**
 * Decode a v2 generated postcondition before a reader treats it as evidence.
 * Unsupported fields and relationships refuse into the existing replan path.
 */
export function decodeGeneratedPostcondition(
	value: unknown,
): GeneratedPostcondition {
	if (!isRecord(value))
		throw replan('generated postcondition format is unsupported');
	const postconditionVersion = value.postconditionVersion;
	const kind = value.kind;
	if (postconditionVersion !== 2 || typeof kind !== 'string')
		throw replan('generated postcondition format is unsupported');
	const unsupported = 'generated postcondition is unsupported';
	switch (kind) {
		case 'table': {
			if (!exactKeys(value, ['postconditionVersion', 'kind', 'columns']))
				throw replan(unsupported);
			const columns = strictUnknownArray(value.columns, unsupported).map(
				(column) => decodeColumnPostcondition(column),
			);
			const names = new Set<string>();
			for (const column of columns) {
				if (names.has(column.name)) throw replan(unsupported);
				names.add(column.name);
			}
			return { postconditionVersion, kind, columns };
		}
		case 'column': {
			if (!exactKeys(value, ['postconditionVersion', 'kind', 'column']))
				throw replan(unsupported);
			const column = decodeColumnPostcondition(value.column);
			return { postconditionVersion, kind, column };
		}
		case 'constraint': {
			if (!exactKeys(value, ['postconditionVersion', 'kind', 'constraint']))
				throw replan(unsupported);
			const constraint = value.constraint;
			if (!isRecord(constraint)) throw replan(unsupported);
			const type = constraint.type;
			if (type === 'c') {
				if (!exactKeys(constraint, ['type', 'expression', 'notValid']))
					throw replan(unsupported);
				const expression = strictString(constraint.expression, unsupported);
				const notValid = strictBoolean(constraint.notValid, unsupported);
				return {
					postconditionVersion,
					kind,
					constraint: { type: 'c', expression, notValid },
				};
			} else if (type === 'p' || type === 'u') {
				if (
					!exactKeys(constraint, [
						'type',
						'columns',
						'deferrable',
						'initiallyDeferred',
						'enforced',
					])
				)
					throw replan(unsupported);
				const columns = stringList(constraint.columns, unsupported);
				for (const name of columns)
					checkedIdentifier(name, 'column', unsupported);
				const deferrable = strictBoolean(constraint.deferrable, unsupported);
				const initiallyDeferred = strictBoolean(
					constraint.initiallyDeferred,
					unsupported,
				);
				const enforced = strictBoolean(constraint.enforced, unsupported);
				return {
					postconditionVersion,
					kind,
					constraint: {
						type,
						columns,
						deferrable,
						initiallyDeferred,
						enforced,
					},
				};
			} else if (type === 'f') {
				if (
					!exactKeys(constraint, [
						'type',
						'columns',
						'references',
						'onDelete',
						'onUpdate',
						'deferrable',
						'initiallyDeferred',
						'enforced',
						'notValid',
					])
				)
					throw replan(unsupported);
				const columns = stringList(constraint.columns, unsupported);
				for (const name of columns)
					checkedIdentifier(name, 'column', unsupported);
				const references = constraint.references;
				if (!isRecord(references)) throw replan(unsupported);
				if (!exactKeys(references, ['schema', 'table', 'columns']))
					throw replan(unsupported);
				const schema = checkedIdentifier(
					references.schema,
					'schema',
					unsupported,
				);
				const table = checkedIdentifier(references.table, 'table', unsupported);
				const referenceColumns = stringList(references.columns, unsupported);
				for (const name of referenceColumns)
					checkedIdentifier(name, 'column', unsupported);
				const onDelete = strictString(constraint.onDelete, unsupported);
				const onUpdate = strictString(constraint.onUpdate, unsupported);
				const deferrable = strictBoolean(constraint.deferrable, unsupported);
				const initiallyDeferred = strictBoolean(
					constraint.initiallyDeferred,
					unsupported,
				);
				const enforced = strictBoolean(constraint.enforced, unsupported);
				const notValid = strictBoolean(constraint.notValid, unsupported);
				return {
					postconditionVersion,
					kind,
					constraint: {
						type: 'f',
						columns,
						references: { schema, table, columns: referenceColumns },
						onDelete,
						onUpdate,
						deferrable,
						initiallyDeferred,
						enforced,
						notValid,
					},
				};
			} else throw replan(unsupported);
		}
		case 'index': {
			if (!exactKeys(value, ['postconditionVersion', 'kind', 'index']))
				throw replan(unsupported);
			const index = value.index;
			if (!isRecord(index)) throw replan(unsupported);
			if (
				!exactKeys(index, [
					'schema',
					'table',
					'name',
					'method',
					'unique',
					'valid',
					'ready',
					'live',
					'columns',
					'expressions',
					'include',
					'nullsNotDistinct',
					'opclass',
					'with',
					'where',
				])
			)
				throw replan(unsupported);
			const schema = checkedIdentifier(index.schema, 'schema', unsupported);
			const table = checkedIdentifier(index.table, 'table', unsupported);
			const name = checkedIdentifier(index.name, 'alias', unsupported);
			const method = strictString(index.method, unsupported);
			if (
				![
					'btree',
					'hash',
					'gist',
					'gin',
					'brin',
					'spgist',
					'hnsw',
					'ivfflat',
					'bm25',
					'bloom',
				].includes(method)
			)
				throw replan(unsupported);
			const unique = strictBoolean(index.unique, unsupported);
			if (index.valid !== true || index.ready !== true || index.live !== true)
				throw replan(unsupported);
			const nullsNotDistinct = strictBoolean(
				index.nullsNotDistinct,
				unsupported,
			);
			const columns = stringList(index.columns, unsupported);
			for (const column of columns)
				checkedIdentifier(column, 'column', unsupported);
			const expressionsValue = index.expressions;
			const includeValue = index.include;
			const opclassValue = index.opclass;
			const withValue = index.with;
			const expressions =
				expressionsValue === undefined
					? undefined
					: stringList(expressionsValue, unsupported);
			const include =
				includeValue === undefined
					? undefined
					: stringList(includeValue, unsupported);
			const opclass =
				opclassValue === undefined
					? undefined
					: stringRecord(opclassValue, unsupported);
			const withOptions =
				withValue === undefined
					? undefined
					: stringRecord(withValue, unsupported);
			const whereValue = index.where;
			const where =
				whereValue === undefined
					? undefined
					: strictString(whereValue, unsupported);
			const decodedIndex: GeneratedIndexPostcondition = {
				schema,
				table,
				name,
				method,
				unique,
				valid: true,
				ready: true,
				live: true,
				columns,
				...(expressions === undefined ? {} : { expressions }),
				...(include === undefined ? {} : { include }),
				nullsNotDistinct,
				...(opclass === undefined ? {} : { opclass }),
				...(withOptions === undefined ? {} : { with: withOptions }),
				...(where === undefined ? {} : { where }),
			};
			return { postconditionVersion, kind, index: decodedIndex };
		}
		case 'enum': {
			if (!exactKeys(value, ['postconditionVersion', 'kind', 'labels']))
				throw replan(unsupported);
			const labels = stringList(value.labels, unsupported);
			return { postconditionVersion, kind, labels };
		}
		case 'sequence': {
			if (
				!exactKeys(value, [
					'postconditionVersion',
					'kind',
					'startValue',
					'incrementBy',
					'minValue',
					'maxValue',
					'cycle',
				])
			)
				throw replan(unsupported);
			const startValue = value.startValue;
			const incrementBy = value.incrementBy;
			const minValue = value.minValue;
			const maxValue = value.maxValue;
			const cycle = value.cycle;
			const decodedStartValue =
				startValue === undefined
					? undefined
					: strictString(startValue, unsupported);
			const decodedIncrementBy =
				incrementBy === undefined
					? undefined
					: strictString(incrementBy, unsupported);
			const decodedMinValue =
				minValue === undefined
					? undefined
					: strictString(minValue, unsupported);
			const decodedMaxValue =
				maxValue === undefined
					? undefined
					: strictString(maxValue, unsupported);
			const decodedCycle =
				cycle === undefined ? undefined : strictBoolean(cycle, unsupported);
			return {
				postconditionVersion,
				kind,
				...(decodedStartValue === undefined
					? {}
					: { startValue: decodedStartValue }),
				...(decodedIncrementBy === undefined
					? {}
					: { incrementBy: decodedIncrementBy }),
				...(decodedMinValue === undefined ? {} : { minValue: decodedMinValue }),
				...(decodedMaxValue === undefined ? {} : { maxValue: decodedMaxValue }),
				...(decodedCycle === undefined ? {} : { cycle: decodedCycle }),
			};
		}
		case 'extension': {
			if (!exactKeys(value, ['postconditionVersion', 'kind', 'version']))
				throw replan(unsupported);
			const versionValue = value.version;
			const version =
				versionValue === undefined
					? undefined
					: strictString(versionValue, unsupported);
			return {
				postconditionVersion,
				kind,
				...(version === undefined ? {} : { version }),
			};
		}
		case 'absent':
			if (!exactKeys(value, ['postconditionVersion', 'kind']))
				throw replan(unsupported);
			return { postconditionVersion, kind };
		case 'exempt': {
			if (!exactKeys(value, ['postconditionVersion', 'kind', 'reason']))
				throw replan(unsupported);
			const reason = strictString(value.reason, unsupported);
			return { postconditionVersion, kind, reason };
		}
		default:
			throw replan(unsupported);
	}
}

function decodeIndexExpectation(
	value: unknown,
	target: GeneratedPostconditionTarget,
): GeneratedIndexPostcondition {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['postconditionVersion', 'kind', 'index'])
	)
		throw replan('generated index postcondition format is unsupported');
	if (
		value.postconditionVersion !== 2 ||
		value.kind !== 'index' ||
		!isRecord(value.index)
	)
		throw replan('generated index postcondition is unsupported');
	const index = value.index;
	if (
		!exactKeys(index, [
			'schema',
			'table',
			'name',
			'method',
			'unique',
			'valid',
			'ready',
			'live',
			'columns',
			'expressions',
			'include',
			'nullsNotDistinct',
			'opclass',
			'with',
			'where',
		]) ||
		typeof index.schema !== 'string' ||
		typeof index.table !== 'string' ||
		typeof index.name !== 'string' ||
		typeof index.method !== 'string' ||
		typeof index.unique !== 'boolean' ||
		index.valid !== true ||
		index.ready !== true ||
		index.live !== true ||
		typeof index.nullsNotDistinct !== 'boolean' ||
		(index.where !== undefined && typeof index.where !== 'string')
	)
		throw replan('generated index postcondition is unsupported');
	try {
		quoteIdent(index.schema, 'schema');
		quoteIdent(index.table, 'table');
		quoteIdent(index.name, 'alias');
		quoteIdent(index.method, 'alias');
	} catch {
		throw replan('generated index postcondition is unsupported');
	}
	const columns = stringList(
		index.columns,
		'generated index postcondition is unsupported',
	);
	if (columns.length === 0)
		throw replan('generated index postcondition is unsupported');
	try {
		for (const column of columns) quoteIdent(column, 'column');
	} catch {
		throw replan('generated index postcondition is unsupported');
	}
	const expressions =
		index.expressions === undefined
			? undefined
			: stringList(
					index.expressions,
					'generated index postcondition is unsupported',
				);
	const include =
		index.include === undefined
			? undefined
			: stringList(
					index.include,
					'generated index postcondition is unsupported',
				);
	const opclass =
		index.opclass === undefined
			? undefined
			: stringRecord(
					index.opclass,
					'generated index postcondition is unsupported',
				);
	const withOptions =
		index.with === undefined
			? undefined
			: stringRecord(
					index.with,
					'generated index postcondition is unsupported',
				);
	if (
		opclass &&
		Object.keys(opclass).some((column) => !columns.includes(column))
	)
		throw replan(
			'generated index postcondition opclass keys do not name emitted columns',
		);
	if (
		index.schema !== target.schema ||
		index.table !== target.table ||
		index.name !== target.name
	)
		throw new Error('generated index postcondition identity differs');
	return {
		schema: index.schema,
		table: index.table,
		name: index.name,
		method: index.method,
		unique: index.unique,
		valid: true,
		ready: true,
		live: true,
		columns,
		...(expressions === undefined ? {} : { expressions }),
		...(include === undefined ? {} : { include }),
		nullsNotDistinct: index.nullsNotDistinct,
		...(opclass === undefined ? {} : { opclass }),
		...(withOptions === undefined ? {} : { with: withOptions }),
		...(index.where === undefined ? {} : { where: index.where }),
	};
}

function decodeCheckExpectation(
	value: unknown,
): Extract<GeneratedConstraintPostcondition, { readonly type: 'c' }> {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['postconditionVersion', 'kind', 'constraint'])
	)
		throw replan('generated CHECK postcondition format is unsupported');
	if (
		value.postconditionVersion !== 2 ||
		value.kind !== 'constraint' ||
		!isRecord(value.constraint) ||
		!exactKeys(value.constraint, ['type', 'expression', 'notValid']) ||
		value.constraint.type !== 'c' ||
		typeof value.constraint.expression !== 'string' ||
		typeof value.constraint.notValid !== 'boolean'
	)
		throw replan('generated CHECK postcondition is unsupported');
	return {
		type: 'c',
		expression: value.constraint.expression,
		notValid: value.constraint.notValid,
	};
}

function nullableStringList(value: unknown): readonly (string | null)[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== 'string' && item !== null)
	)
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	return value;
}

function projectionStringList(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	return value;
}

function indexProjection(row: Record<string, unknown>): IndexProjection {
	if (
		typeof row.schema_name !== 'string' ||
		typeof row.table_name !== 'string' ||
		typeof row.index_name !== 'string' ||
		typeof row.method_name !== 'string' ||
		typeof row.is_unique !== 'boolean' ||
		typeof row.is_valid !== 'boolean' ||
		typeof row.is_ready !== 'boolean' ||
		typeof row.is_live !== 'boolean' ||
		typeof row.nulls_not_distinct !== 'boolean' ||
		typeof row.is_primary !== 'boolean' ||
		typeof row.is_exclusion !== 'boolean' ||
		typeof row.is_immediate !== 'boolean' ||
		typeof row.is_constraint_owned !== 'boolean' ||
		!Number.isInteger(row.key_count) ||
		(typeof row.predicate_expression !== 'string' &&
			row.predicate_expression !== null)
	)
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	return {
		schema: row.schema_name,
		table: row.table_name,
		name: row.index_name,
		method: row.method_name,
		unique: row.is_unique,
		valid: row.is_valid,
		ready: row.is_ready,
		live: row.is_live,
		nullsNotDistinct: row.nulls_not_distinct,
		primary: row.is_primary,
		exclusion: row.is_exclusion,
		immediate: row.is_immediate,
		constraintOwned: row.is_constraint_owned,
		keyColumns: nullableStringList(row.key_columns),
		keyDefinitions: projectionStringList(row.key_definitions),
		includeColumns: projectionStringList(row.include_columns),
		opclasses: projectionStringList(row.opclasses),
		keyOptions: projectionStringList(row.key_options),
		reloptions: [...projectionStringList(row.reloptions)].sort(),
		predicate: row.predicate_expression,
	};
}

const INDEX_PROJECTION_SELECT =
	"SELECT namespace.nspname AS schema_name, relation.relname AS table_name, index_relation.relname AS index_name, access_method.amname AS method_name, index_meta.indisunique AS is_unique, index_meta.indisvalid AS is_valid, index_meta.indisready AS is_ready, index_meta.indislive AS is_live, index_meta.indisprimary AS is_primary, index_meta.indisexclusion AS is_exclusion, index_meta.indimmediate AS is_immediate, constraint_item.oid IS NOT NULL AS is_constraint_owned, CASE WHEN index_meta_json.value ? 'indnullsnotdistinct' THEN (index_meta_json.value ->> 'indnullsnotdistinct')::boolean ELSE false END AS nulls_not_distinct, CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END AS key_count, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, position) LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = key_column.attnum WHERE key_column.position <= CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY key_column.position) AS key_columns, ARRAY(SELECT pg_catalog.pg_get_indexdef(index_meta.indexrelid, key_position, false) FROM pg_catalog.generate_series(1, CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END) AS key_position ORDER BY key_position) AS key_definitions, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS include_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = include_column.attnum WHERE include_column.position > CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY include_column.position) AS include_columns, ARRAY(SELECT opclass.opcname::text FROM unnest(index_meta.indclass) WITH ORDINALITY AS index_opclass(opclass_oid, position) JOIN pg_catalog.pg_opclass opclass ON opclass.oid = index_opclass.opclass_oid WHERE index_opclass.position <= CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY index_opclass.position) AS opclasses, ARRAY(SELECT index_option.option::text FROM unnest(index_meta.indoption) WITH ORDINALITY AS index_option(option, position) WHERE index_option.position <= CASE WHEN index_meta_json.value ? 'indnkeyatts' THEN (index_meta_json.value ->> 'indnkeyatts')::integer ELSE index_meta.indnatts END ORDER BY index_option.position) AS key_options, COALESCE(index_relation.reloptions, ARRAY[]::text[]) AS reloptions, pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid, false) AS predicate_expression FROM pg_catalog.pg_index index_meta CROSS JOIN LATERAL (SELECT pg_catalog.to_jsonb(index_meta) AS value) index_meta_json JOIN pg_catalog.pg_class relation ON relation.oid = index_meta.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam LEFT JOIN pg_catalog.pg_constraint constraint_item ON constraint_item.conindid = index_meta.indexrelid";

async function readLiveIndexProjection(
	session: GeneratedPostconditionSession,
	target: GeneratedPostconditionTarget,
): Promise<IndexProjection> {
	const row = (
		await session.query(
			`${INDEX_PROJECTION_SELECT} WHERE namespace.nspname = $1 AND relation.relname = $2 AND index_relation.relname = $3`,
			[target.schema, target.table, target.name],
		)
	).rows[0];
	if (!row) throw new Error(`generated index ${target.name} is absent`);
	return indexProjection(row);
}

async function readScratchIndexProjection(
	session: GeneratedPostconditionSession,
	table: string,
	index: string,
): Promise<IndexProjection> {
	const row = (
		await session.query(
			`${INDEX_PROJECTION_SELECT} WHERE relation.oid = $1::pg_catalog.regclass AND index_relation.relname = $2`,
			[table, index],
		)
	).rows[0];
	if (!row)
		throw new Error('generated index verifier could not read staged index');
	return indexProjection(row);
}

async function scratchScope<T>(
	session: GeneratedPostconditionSession,
	work: () => Promise<T>,
): Promise<T> {
	const savepoint = nextScratchName('scope');
	let savepointActive = false;
	let transactionStarted = false;
	let result: T | undefined;
	let workError: unknown;
	let workFailed = false;
	try {
		try {
			await session.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		} catch (error) {
			if (!isRecord(error) || error.code !== '25P01') throw error;
			await session.query('BEGIN');
			transactionStarted = true;
			await session.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		}
		result = await work();
	} catch (error) {
		workFailed = true;
		workError = error;
	}
	const cleanupErrors: unknown[] = [];
	const cleanup = async (sql: string) => {
		try {
			await session.query(sql);
		} catch (error) {
			cleanupErrors.push(error);
		}
	};
	if (savepointActive) {
		await cleanup(`ROLLBACK TO SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
		await cleanup(`RELEASE SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
	}
	if (transactionStarted) await cleanup('ROLLBACK');
	if (workFailed && cleanupErrors.length > 0)
		throw new AggregateError(
			[workError, ...cleanupErrors],
			'generated postcondition verification failed and scratch cleanup failed',
		);
	if (workFailed) throw workError;
	if (cleanupErrors.length > 0)
		throw new AggregateError(
			cleanupErrors,
			'generated postcondition scratch cleanup failed',
		);
	if (result === undefined)
		throw new Error(
			'generated postcondition scratch scope completed without a result',
		);
	return result;
}

function sameIndexStructure(
	left: IndexProjection,
	right: IndexProjection,
): boolean {
	return (
		left.method === right.method &&
		left.unique === right.unique &&
		left.valid === right.valid &&
		left.ready === right.ready &&
		left.live === right.live &&
		left.nullsNotDistinct === right.nullsNotDistinct &&
		left.primary === right.primary &&
		left.exclusion === right.exclusion &&
		left.immediate === right.immediate &&
		left.constraintOwned === right.constraintOwned &&
		JSON.stringify(left.keyColumns) === JSON.stringify(right.keyColumns) &&
		JSON.stringify(left.keyDefinitions) ===
			JSON.stringify(right.keyDefinitions) &&
		JSON.stringify(left.includeColumns) ===
			JSON.stringify(right.includeColumns) &&
		JSON.stringify(left.opclasses) === JSON.stringify(right.opclasses) &&
		JSON.stringify(left.keyOptions) === JSON.stringify(right.keyOptions) &&
		JSON.stringify([...left.reloptions].sort()) ===
			JSON.stringify([...right.reloptions].sort()) &&
		left.predicate === right.predicate
	);
}

function indexSource(expected: GeneratedIndexPostcondition, name: string) {
	return {
		name,
		columns: expected.columns,
		unique: expected.unique,
		method: expected.method,
		...(expected.expressions === undefined
			? {}
			: { expressions: expected.expressions }),
		...(expected.include === undefined ? {} : { include: expected.include }),
		nullsNotDistinct: expected.nullsNotDistinct,
		...(expected.opclass === undefined ? {} : { opclass: expected.opclass }),
		...(expected.with === undefined ? {} : { with: expected.with }),
		...(expected.where === undefined ? {} : { where: expected.where }),
	};
}

function requireGeneratedPostconditionSession(
	value: unknown,
): GeneratedPostconditionSession {
	if (!value || typeof value !== 'object' || !mintedSessions.has(value))
		throw new Error(
			'generated postcondition verifier requires an adapter-minted exclusive session capability',
		);
	return value as GeneratedPostconditionSession;
}

/** Refuse structural lookalikes before any proof or catalogue read. */
export function assertGeneratedPostconditionSession(
	value: unknown,
): GeneratedPostconditionSession {
	return requireGeneratedPostconditionSession(value);
}

function tableColumnProjection(
	row: Record<string, unknown>,
): TableColumnProjection {
	if (
		typeof row.column_name !== 'string' ||
		typeof row.column_type !== 'string' ||
		typeof row.is_not_null !== 'boolean' ||
		(typeof row.column_default !== 'string' && row.column_default !== null) ||
		(typeof row.collation_name !== 'string' && row.collation_name !== null) ||
		(row.identity_kind !== '' &&
			row.identity_kind !== 'a' &&
			row.identity_kind !== 'd')
	)
		throw new Error(
			'generated table verifier could not read a complete projection',
		);
	return {
		name: row.column_name,
		type: row.column_type,
		nullable: !row.is_not_null,
		default: row.column_default === null ? undefined : row.column_default,
		// PostgreSQL names the built-in collation `default`; DBSP represents no
		// explicit collation as null.
		collation: row.collation_name === 'default' ? null : row.collation_name,
		identity:
			row.identity_kind === 'a'
				? 'always'
				: row.identity_kind === 'd'
					? 'byDefault'
					: null,
	};
}

/**
 * Proves the supported COLUMN projection of a table, not every table property.
 * Inline primary keys, indexes, and constraints are proved by their own
 * postconditions and are never implied by this proof.
 */
export async function verifyGeneratedTablePostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{ readonly kind: 'table'; readonly projection: TableProjection }> {
	const postcondition = decodeGeneratedPostcondition(input.postcondition);
	if (postcondition.kind !== 'table')
		throw replan('generated table postcondition is unsupported');
	const session = requireGeneratedPostconditionSession(input.session);
	const rows = (
		await session.query(
			`SELECT relation.relkind AS relation_kind, attribute.attname AS column_name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type, attribute.attnotnull AS is_not_null, pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default, column_collation.collname AS collation_name, attribute.attidentity AS identity_kind FROM pg_catalog.pg_namespace namespace JOIN pg_catalog.pg_class relation ON relation.relnamespace = namespace.oid LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped LEFT JOIN pg_catalog.pg_attrdef default_value ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum LEFT JOIN pg_catalog.pg_collation column_collation ON column_collation.oid = attribute.attcollation WHERE namespace.nspname = $1 AND relation.relname = $2 ORDER BY attribute.attnum`,
			[input.target.schema, input.target.table],
		)
	).rows;
	const expected = postcondition.columns;
	if (rows.length === 0)
		throw new Error(`generated table ${input.target.name} is absent`);
	const relationKind = rows[0]?.relation_kind;
	if (typeof relationKind !== 'string')
		throw new Error(
			'generated table verifier could not read a complete projection',
		);
	if (relationKind !== 'r' && relationKind !== 'p')
		throw new Error(`generated table ${input.target.name} is not a table`);
	if (rows.some((row) => row.relation_kind !== relationKind))
		throw new Error(
			'generated table verifier could not read a complete projection',
		);
	const columnRows = rows.filter((row) => row.column_name !== null);
	if (columnRows.length !== expected.length)
		throw new Error(
			`generated table ${input.target.name} column postcondition differs: expected ${JSON.stringify(expected)}, live ${JSON.stringify(columnRows)}`,
		);
	const live = columnRows.map(tableColumnProjection);
	for (const [ordinal, specification] of expected.entries()) {
		const actual = live[ordinal];
		if (
			!actual ||
			actual.name !== specification.name ||
			(specification.type !== undefined &&
				!dbTypesEqual(actual.type, specification.type)) ||
			(specification.nullable !== undefined &&
				actual.nullable !== specification.nullable) ||
			(specification.hasDefault === true &&
				(actual.default === undefined ||
					specification.default === undefined ||
					actual.default !== specification.default)) ||
			(specification.hasDefault === false && actual.default !== undefined) ||
			(specification.collation !== undefined &&
				actual.collation !== specification.collation) ||
			(specification.identity !== undefined &&
				actual.identity !== specification.identity)
		)
			throw new Error(
				`generated table ${input.target.name} column postcondition differs: expected ${JSON.stringify(specification)}, live ${JSON.stringify(actual)}`,
			);
	}
	return { kind: 'table', projection: { columns: live } };
}

export async function verifyGeneratedIndexPostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{ readonly kind: 'index'; readonly projection: IndexProjection }> {
	const expected = decodeIndexExpectation(input.postcondition, input.target);
	const session = requireGeneratedPostconditionSession(input.session);
	const scratchTable = nextScratchName('table');
	const scratchIndex = nextScratchName('index');
	// Render before acquiring/using the capability: malformed index material must
	// refuse before any live catalogue query.
	const scratchSql = generateCreateIndex(
		scratchTable,
		indexSource(expected, scratchIndex),
		undefined,
		identityNaming,
	);
	return scratchScope(session, async () => {
		await session.query(
			`LOCK TABLE ${quoteIdent(expected.schema, 'schema')}.${quoteIdent(expected.table, 'table')} IN SHARE ROW EXCLUSIVE MODE`,
		);
		const live = await readLiveIndexProjection(session, input.target);
		if (
			live.schema !== expected.schema ||
			live.table !== expected.table ||
			live.name !== expected.name ||
			live.valid !== expected.valid ||
			live.ready !== expected.ready ||
			live.live !== expected.live
		)
			throw new Error(
				`generated index ${input.target.name} postcondition differs`,
			);
		const staged = await (async () => {
			await session.query(
				`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(expected.schema, 'schema')}.${quoteIdent(expected.table, 'table')} INCLUDING DEFAULTS INCLUDING IDENTITY)`,
			);
			await session.query(scratchSql);
			return readScratchIndexProjection(session, scratchTable, scratchIndex);
		})();
		if (!sameIndexStructure(live, staged))
			throw new Error(
				`generated index ${input.target.name} postcondition differs`,
			);
		return { kind: 'index', projection: live };
	});
}

const CHECK_PROJECTION_SELECT =
	"SELECT pg_catalog.pg_get_expr(constraint_item.conbin, constraint_item.conrelid, false) AS expression, constraint_item.convalidated AS validated, constraint_item.connoinherit AS no_inherit, constraint_item.conislocal AS is_local, constraint_item.coninhcount AS inheritance_count, CASE WHEN constraint_item_json.value ? 'conparentid' THEN (constraint_item_json.value ->> 'conparentid')::oid ELSE 0::oid END AS parent_id, CASE WHEN constraint_item_json.value ? 'conenforced' THEN (constraint_item_json.value ->> 'conenforced')::boolean ELSE true END AS enforced FROM pg_catalog.pg_constraint constraint_item CROSS JOIN LATERAL (SELECT pg_catalog.to_jsonb(constraint_item) AS value) constraint_item_json";

function checkProjection(
	row: Record<string, unknown>,
	absent: string,
): CheckProjection {
	if (typeof row.expression !== 'string') throw new Error(absent);
	if (
		typeof row.validated !== 'boolean' ||
		typeof row.no_inherit !== 'boolean' ||
		typeof row.enforced !== 'boolean' ||
		typeof row.is_local !== 'boolean' ||
		typeof row.inheritance_count !== 'number' ||
		!Number.isInteger(row.inheritance_count) ||
		typeof row.parent_id !== 'number' ||
		!Number.isInteger(row.parent_id)
	)
		throw new Error(
			'generated CHECK verifier could not read a complete projection',
		);
	return {
		expression: row.expression,
		validated: row.validated,
		noInherit: row.no_inherit,
		enforced: row.enforced,
		isLocal: row.is_local,
		inheritanceCount: row.inheritance_count,
		parentId: row.parent_id,
	};
}

async function readLiveCheckProjection(
	session: GeneratedPostconditionSession,
	target: GeneratedPostconditionTarget,
): Promise<CheckProjection> {
	const row = (
		await session.query(
			`${CHECK_PROJECTION_SELECT} JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND constraint_item.conname = $3 AND constraint_item.contype = 'c'`,
			[target.schema, target.table, target.name],
		)
	).rows[0];
	if (!row) throw new Error(`generated constraint ${target.name} is absent`);
	return checkProjection(row, `generated constraint ${target.name} is absent`);
}

async function readScratchCheckProjection(
	session: GeneratedPostconditionSession,
	table: string,
	constraint: string,
): Promise<CheckProjection> {
	const row = (
		await session.query(
			`${CHECK_PROJECTION_SELECT} WHERE constraint_item.conrelid = $1::pg_catalog.regclass AND constraint_item.conname = $2 AND constraint_item.contype = 'c'`,
			[table, constraint],
		)
	).rows[0];
	if (!row)
		throw new Error(
			'generated CHECK verifier could not read staged constraint',
		);
	return checkProjection(
		row,
		'generated CHECK verifier could not read staged constraint',
	);
}

export async function verifyGeneratedCheckPostcondition(input: {
	readonly session: GeneratedPostconditionSession;
	readonly postcondition: unknown;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{
	readonly kind: 'constraint';
	readonly projection: CheckProjection;
}> {
	const expected = decodeCheckExpectation(input.postcondition);
	const session = requireGeneratedPostconditionSession(input.session);
	const clause = renderCheckConstraintClause({
		expression: expected.expression,
		notValid: expected.notValid,
	});
	validateCheckExpression(clause, 'generated CHECK postcondition');
	return scratchScope(session, async () => {
		await session.query(
			`LOCK TABLE ${quoteIdent(input.target.schema, 'schema')}.${quoteIdent(input.target.table, 'table')} IN SHARE ROW EXCLUSIVE MODE`,
		);
		const live = await readLiveCheckProjection(session, input.target);
		if (live.validated !== !expected.notValid)
			throw new Error(
				`generated constraint ${input.target.name} postcondition differs`,
			);
		const scratchTable = nextScratchName('table');
		const scratchConstraint = nextScratchName('constraint');
		const staged = await (async () => {
			await session.query(
				`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(input.target.schema, 'schema')}.${quoteIdent(input.target.table, 'table')} INCLUDING DEFAULTS INCLUDING IDENTITY)`,
			);
			await session.query(
				`ALTER TABLE ${quoteIdent(scratchTable, 'table')} ADD CONSTRAINT ${quoteIdent(scratchConstraint, 'alias')} ${clause}`,
			);
			return readScratchCheckProjection(
				session,
				scratchTable,
				scratchConstraint,
			);
		})();
		if (
			live.expression !== staged.expression ||
			live.validated !== staged.validated ||
			live.noInherit !== staged.noInherit ||
			live.enforced !== staged.enforced ||
			live.isLocal !== staged.isLocal ||
			live.inheritanceCount !== staged.inheritanceCount ||
			live.parentId !== staged.parentId
		)
			throw new Error(
				`generated constraint ${input.target.name} postcondition differs`,
			);
		return { kind: 'constraint', projection: live };
	});
}
