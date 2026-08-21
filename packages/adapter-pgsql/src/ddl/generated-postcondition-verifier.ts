import { renderCheckConstraintClause } from '../check-expression.js';
import { identityNaming } from '../naming-plugin.js';
import { generateCreateIndex } from './ddl-generator.js';
import type {
	GeneratedConstraintPostcondition,
	GeneratedIndexPostcondition,
	GeneratedPostcondition,
} from './managed-step-manifest.js';
import { quoteIdent } from './phases/utils.js';

export type GeneratedPostconditionQueryable = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

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
};

let scratchSequence = 0;

function nextScratchName(kind: string): string {
	scratchSequence += 1;
	return `dbsp_postcondition_${kind}_${Date.now()}_${scratchSequence}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function generatedPostcondition(value: unknown): GeneratedPostcondition {
	if (!isRecord(value) || value.postconditionVersion !== 2) {
		throw new Error(
			'generated postcondition format is unsupported; replan to produce version 2 typed postconditions',
		);
	}
	return value as GeneratedPostcondition;
}

function indexExpectation(
	value: unknown,
	target: GeneratedPostconditionTarget,
): GeneratedIndexPostcondition {
	const postcondition = generatedPostcondition(value);
	if (postcondition.kind !== 'index' || !isRecord(postcondition.index)) {
		throw new Error(
			'generated index postcondition is unsupported; replan with a typed index projection',
		);
	}
	const expected = postcondition.index;
	if (
		expected.schema !== target.schema ||
		expected.table !== target.table ||
		expected.name !== target.name
	) {
		throw new Error('generated index postcondition identity differs');
	}
	const modeledFields = new Set([
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
	]);
	if (Object.keys(expected).some((field) => !modeledFields.has(field))) {
		throw new Error(
			'generated index postcondition carries an unmodeled feature; replan after adding a verifier projection',
		);
	}
	return expected;
}

function checkExpectation(
	value: unknown,
): Extract<GeneratedConstraintPostcondition, { readonly type: 'c' }> {
	const postcondition = generatedPostcondition(value);
	if (
		postcondition.kind !== 'constraint' ||
		postcondition.constraint.type !== 'c' ||
		typeof postcondition.constraint.expression !== 'string'
	) {
		throw new Error(
			'generated CHECK postcondition is unsupported; replan with a typed CHECK expression',
		);
	}
	return postcondition.constraint;
}

function stringList(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	return value;
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
		(typeof row.predicate_expression !== 'string' &&
			row.predicate_expression !== null)
	) {
		throw new Error(
			'generated index verifier could not read a complete projection',
		);
	}
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
		keyColumns: nullableStringList(row.key_columns),
		keyDefinitions: stringList(row.key_definitions),
		includeColumns: stringList(row.include_columns),
		opclasses: stringList(row.opclasses),
		keyOptions: stringList(row.key_options),
		reloptions: stringList(row.reloptions),
		predicate: row.predicate_expression,
	};
}

const INDEX_PROJECTION_SELECT =
	'SELECT namespace.nspname AS schema_name, relation.relname AS table_name, index_relation.relname AS index_name, access_method.amname AS method_name, index_meta.indisunique AS is_unique, index_meta.indisvalid AS is_valid, index_meta.indisready AS is_ready, index_meta.indislive AS is_live, index_meta.indnullsnotdistinct AS nulls_not_distinct, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, position) LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = key_column.attnum WHERE key_column.position <= index_meta.indnkeyatts ORDER BY key_column.position) AS key_columns, ARRAY(SELECT pg_catalog.pg_get_indexdef(index_meta.indexrelid, key_position, false) FROM pg_catalog.generate_series(1, index_meta.indnkeyatts) AS key_position ORDER BY key_position) AS key_definitions, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS include_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = include_column.attnum WHERE include_column.position > index_meta.indnkeyatts ORDER BY include_column.position) AS include_columns, ARRAY(SELECT opclass.opcname::text FROM unnest(index_meta.indclass) WITH ORDINALITY AS index_opclass(opclass_oid, position) JOIN pg_catalog.pg_opclass opclass ON opclass.oid = index_opclass.opclass_oid WHERE index_opclass.position <= index_meta.indnkeyatts ORDER BY index_opclass.position) AS opclasses, ARRAY(SELECT index_option.option::text FROM unnest(index_meta.indoption) WITH ORDINALITY AS index_option(option, position) WHERE index_option.position <= index_meta.indnkeyatts ORDER BY index_option.position) AS key_options, COALESCE(index_relation.reloptions, ARRAY[]::text[]) AS reloptions, pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid, false) AS predicate_expression FROM pg_catalog.pg_index index_meta JOIN pg_catalog.pg_class relation ON relation.oid = index_meta.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam';

async function readLiveIndexProjection(
	executor: GeneratedPostconditionQueryable,
	target: GeneratedPostconditionTarget,
): Promise<IndexProjection> {
	const row = (
		await executor.query(
			`${INDEX_PROJECTION_SELECT} WHERE namespace.nspname = $1 AND relation.relname = $2 AND index_relation.relname = $3`,
			[target.schema, target.table, target.name],
		)
	).rows[0];
	if (!row) throw new Error(`generated index ${target.name} is absent`);
	return indexProjection(row);
}

async function readScratchIndexProjection(
	executor: GeneratedPostconditionQueryable,
	table: string,
	index: string,
): Promise<IndexProjection> {
	const row = (
		await executor.query(
			`${INDEX_PROJECTION_SELECT} WHERE relation.oid = $1::pg_catalog.regclass AND index_relation.relname = $2`,
			[table, index],
		)
	).rows[0];
	if (!row)
		throw new Error('generated index verifier could not read staged index');
	return indexProjection(row);
}

async function scratchScope<T>(
	executor: GeneratedPostconditionQueryable,
	work: () => Promise<T>,
): Promise<T> {
	const savepoint = nextScratchName('scope');
	let savepointActive = false;
	let transactionStarted = false;
	let result: T | undefined;
	let workError: unknown;
	try {
		try {
			await executor.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		} catch (error) {
			if (!isRecord(error) || error.code !== '25P01') throw error;
			await executor.query('BEGIN');
			transactionStarted = true;
			await executor.query(`SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
			savepointActive = true;
		}
		result = await work();
	} catch (error) {
		workError = error;
	}
	const cleanupErrors: unknown[] = [];
	const cleanup = async (sql: string) => {
		try {
			await executor.query(sql);
		} catch (error) {
			cleanupErrors.push(error);
		}
	};
	if (savepointActive) {
		await cleanup(`ROLLBACK TO SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
		await cleanup(`RELEASE SAVEPOINT ${quoteIdent(savepoint, 'table')}`);
	}
	if (transactionStarted) await cleanup('ROLLBACK');
	if (workError !== undefined && cleanupErrors.length > 0)
		throw new AggregateError(
			[workError, ...cleanupErrors],
			'generated postcondition verification failed and scratch cleanup failed',
		);
	if (workError !== undefined) throw workError;
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
		JSON.stringify(left.keyColumns) === JSON.stringify(right.keyColumns) &&
		JSON.stringify(left.keyDefinitions) ===
			JSON.stringify(right.keyDefinitions) &&
		JSON.stringify(left.includeColumns) ===
			JSON.stringify(right.includeColumns) &&
		JSON.stringify(left.opclasses) === JSON.stringify(right.opclasses) &&
		JSON.stringify(left.keyOptions) === JSON.stringify(right.keyOptions) &&
		JSON.stringify(left.reloptions) === JSON.stringify(right.reloptions) &&
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

export async function verifyGeneratedIndexPostcondition(input: {
	readonly executor: GeneratedPostconditionQueryable;
	readonly postcondition: unknown;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{ readonly kind: 'index'; readonly projection: IndexProjection }> {
	const expected = indexExpectation(input.postcondition, input.target);
	const live = await readLiveIndexProjection(input.executor, input.target);
	if (
		live.schema !== expected.schema ||
		live.table !== expected.table ||
		live.name !== expected.name ||
		live.valid !== expected.valid ||
		live.ready !== expected.ready ||
		live.live !== expected.live
	) {
		throw new Error(
			`generated index ${input.target.name} postcondition differs`,
		);
	}
	const scratchTable = nextScratchName('table');
	const scratchIndex = nextScratchName('index');
	const staged = await scratchScope(input.executor, async () => {
		await input.executor.query(
			`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(expected.schema, 'schema')}.${quoteIdent(expected.table, 'table')} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)`,
		);
		await input.executor.query(
			generateCreateIndex(
				scratchTable,
				indexSource(expected, scratchIndex),
				undefined,
				identityNaming,
			),
		);
		return readScratchIndexProjection(
			input.executor,
			scratchTable,
			scratchIndex,
		);
	});
	if (!sameIndexStructure(live, staged))
		throw new Error(
			`generated index ${input.target.name} postcondition differs`,
		);
	return { kind: 'index', projection: live };
}

async function readLiveCheckProjection(
	executor: GeneratedPostconditionQueryable,
	target: GeneratedPostconditionTarget,
): Promise<CheckProjection> {
	const row = (
		await executor.query(
			"SELECT pg_catalog.pg_get_expr(constraint_item.conbin, constraint_item.conrelid, false) AS expression, constraint_item.convalidated AS validated FROM pg_catalog.pg_constraint constraint_item JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND constraint_item.conname = $3 AND constraint_item.contype = 'c'",
			[target.schema, target.table, target.name],
		)
	).rows[0];
	if (!row || typeof row.expression !== 'string')
		throw new Error(`generated constraint ${target.name} is absent`);
	return { expression: row.expression, validated: row.validated === true };
}

async function readScratchCheckProjection(
	executor: GeneratedPostconditionQueryable,
	table: string,
	constraint: string,
): Promise<CheckProjection> {
	const row = (
		await executor.query(
			"SELECT pg_catalog.pg_get_expr(constraint_item.conbin, constraint_item.conrelid, false) AS expression, constraint_item.convalidated AS validated FROM pg_catalog.pg_constraint constraint_item WHERE constraint_item.conrelid = $1::pg_catalog.regclass AND constraint_item.conname = $2 AND constraint_item.contype = 'c'",
			[table, constraint],
		)
	).rows[0];
	if (!row || typeof row.expression !== 'string')
		throw new Error(
			'generated CHECK verifier could not read staged constraint',
		);
	return { expression: row.expression, validated: row.validated === true };
}

export async function verifyGeneratedCheckPostcondition(input: {
	readonly executor: GeneratedPostconditionQueryable;
	readonly postcondition: unknown;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{
	readonly kind: 'constraint';
	readonly projection: CheckProjection;
}> {
	const expected = checkExpectation(input.postcondition);
	const live = await readLiveCheckProjection(input.executor, input.target);
	if (live.validated !== !expected.notValid)
		throw new Error(
			`generated constraint ${input.target.name} postcondition differs`,
		);
	const scratchTable = nextScratchName('table');
	const scratchConstraint = nextScratchName('constraint');
	const staged = await scratchScope(input.executor, async () => {
		await input.executor.query(
			`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(input.target.schema, 'schema')}.${quoteIdent(input.target.table, 'table')} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)`,
		);
		await input.executor.query(
			`ALTER TABLE ${quoteIdent(scratchTable, 'table')} ADD CONSTRAINT ${quoteIdent(scratchConstraint, 'alias')} ${renderCheckConstraintClause({ expression: expected.expression, notValid: expected.notValid })}`,
		);
		return readScratchCheckProjection(
			input.executor,
			scratchTable,
			scratchConstraint,
		);
	});
	if (
		live.expression !== staged.expression ||
		live.validated !== staged.validated
	)
		throw new Error(
			`generated constraint ${input.target.name} postcondition differs`,
		);
	return { kind: 'constraint', projection: live };
}
