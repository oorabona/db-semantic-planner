import { renderCheckConstraintClause } from '../check-expression.js';
import { identityNaming } from '../naming-plugin.js';
import { validateCheckExpression } from '../validate.js';
import { generateCreateIndex } from './ddl-generator.js';
import type {
	GeneratedConstraintPostcondition,
	GeneratedIndexPostcondition,
} from './managed-step-manifest.js';
import { quoteIdent } from './phases/utils.js';

export type GeneratedPostconditionSession = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

/**
 * The caller supplies one adapter-owned, already pinned session.  The callback
 * keeps the live read, scratch DDL, staged read, and cleanup on that session.
 */
export type GeneratedPostconditionSessionCallback = <T>(
	work: (session: GeneratedPostconditionSession) => Promise<T>,
) => Promise<T>;

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
	readonly noInherit: boolean;
	readonly enforced: boolean;
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
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		throw replan(message);
	return value;
}

function stringRecord(
	value: unknown,
	message: string,
): Readonly<Record<string, string>> {
	if (
		!isRecord(value) ||
		Object.values(value).some((item) => typeof item !== 'string')
	)
		throw replan(message);
	return value as Record<string, string>;
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
	const columns = stringList(
		index.columns,
		'generated index postcondition is unsupported',
	);
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
		keyColumns: nullableStringList(row.key_columns),
		keyDefinitions: projectionStringList(row.key_definitions),
		includeColumns: projectionStringList(row.include_columns),
		opclasses: projectionStringList(row.opclasses),
		keyOptions: projectionStringList(row.key_options),
		reloptions: projectionStringList(row.reloptions),
		predicate: row.predicate_expression,
	};
}

const INDEX_PROJECTION_SELECT =
	"SELECT namespace.nspname AS schema_name, relation.relname AS table_name, index_relation.relname AS index_name, access_method.amname AS method_name, index_meta.indisunique AS is_unique, index_meta.indisvalid AS is_valid, index_meta.indisready AS is_ready, index_meta.indislive AS is_live, COALESCE((index_meta_json.value ->> 'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS key_column(attnum, position) LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = key_column.attnum WHERE key_column.position <= COALESCE((index_meta_json.value ->> 'indnkeyatts')::integer, index_meta.indnatts) ORDER BY key_column.position) AS key_columns, ARRAY(SELECT pg_catalog.pg_get_indexdef(index_meta.indexrelid, key_position, false) FROM pg_catalog.generate_series(1, COALESCE((index_meta_json.value ->> 'indnkeyatts')::integer, index_meta.indnatts)) AS key_position ORDER BY key_position) AS key_definitions, ARRAY(SELECT attribute.attname::text FROM unnest(index_meta.indkey) WITH ORDINALITY AS include_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = include_column.attnum WHERE include_column.position > COALESCE((index_meta_json.value ->> 'indnkeyatts')::integer, index_meta.indnatts) ORDER BY include_column.position) AS include_columns, ARRAY(SELECT opclass.opcname::text FROM unnest(index_meta.indclass) WITH ORDINALITY AS index_opclass(opclass_oid, position) JOIN pg_catalog.pg_opclass opclass ON opclass.oid = index_opclass.opclass_oid WHERE index_opclass.position <= COALESCE((index_meta_json.value ->> 'indnkeyatts')::integer, index_meta.indnatts) ORDER BY index_opclass.position) AS opclasses, ARRAY(SELECT index_option.option::text FROM unnest(index_meta.indoption) WITH ORDINALITY AS index_option(option, position) WHERE index_option.position <= COALESCE((index_meta_json.value ->> 'indnkeyatts')::integer, index_meta.indnatts) ORDER BY index_option.position) AS key_options, COALESCE(index_relation.reloptions, ARRAY[]::text[]) AS reloptions, pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid, false) AS predicate_expression FROM pg_catalog.pg_index index_meta CROSS JOIN LATERAL (SELECT pg_catalog.to_jsonb(index_meta) AS value) index_meta_json JOIN pg_catalog.pg_class relation ON relation.oid = index_meta.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam";

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

function requireSessionCallback(
	value: unknown,
): GeneratedPostconditionSessionCallback {
	if (typeof value !== 'function')
		throw new Error(
			'generated postcondition verifier requires a pinned session callback',
		);
	return value as GeneratedPostconditionSessionCallback;
}

export async function verifyGeneratedIndexPostcondition(input: {
	readonly withSession: GeneratedPostconditionSessionCallback;
	readonly postcondition: unknown;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{ readonly kind: 'index'; readonly projection: IndexProjection }> {
	const expected = decodeIndexExpectation(input.postcondition, input.target);
	const withSession = requireSessionCallback(input.withSession);
	return withSession(async (session) => {
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
		const scratchTable = nextScratchName('table');
		const scratchIndex = nextScratchName('index');
		const staged = await scratchScope(session, async () => {
			await session.query(
				`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(expected.schema, 'schema')}.${quoteIdent(expected.table, 'table')} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)`,
			);
			await session.query(
				generateCreateIndex(
					scratchTable,
					indexSource(expected, scratchIndex),
					undefined,
					identityNaming,
				),
			);
			return readScratchIndexProjection(session, scratchTable, scratchIndex);
		});
		if (!sameIndexStructure(live, staged))
			throw new Error(
				`generated index ${input.target.name} postcondition differs`,
			);
		return { kind: 'index', projection: live };
	});
}

const CHECK_PROJECTION_SELECT =
	"SELECT pg_catalog.pg_get_expr(constraint_item.conbin, constraint_item.conrelid, false) AS expression, constraint_item.convalidated AS validated, constraint_item.connoinherit AS no_inherit, COALESCE((constraint_item_json.value ->> 'conenforced')::boolean, true) AS enforced FROM pg_catalog.pg_constraint constraint_item CROSS JOIN LATERAL (SELECT pg_catalog.to_jsonb(constraint_item) AS value) constraint_item_json";

function checkProjection(
	row: Record<string, unknown>,
	absent: string,
): CheckProjection {
	if (typeof row.expression !== 'string') throw new Error(absent);
	if (
		typeof row.validated !== 'boolean' ||
		typeof row.no_inherit !== 'boolean' ||
		typeof row.enforced !== 'boolean'
	)
		throw new Error(
			'generated CHECK verifier could not read a complete projection',
		);
	return {
		expression: row.expression,
		validated: row.validated,
		noInherit: row.no_inherit,
		enforced: row.enforced,
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
	readonly withSession: GeneratedPostconditionSessionCallback;
	readonly postcondition: unknown;
	readonly target: GeneratedPostconditionTarget;
}): Promise<{
	readonly kind: 'constraint';
	readonly projection: CheckProjection;
}> {
	const expected = decodeCheckExpectation(input.postcondition);
	const withSession = requireSessionCallback(input.withSession);
	const clause = renderCheckConstraintClause({
		expression: expected.expression,
		notValid: expected.notValid,
	});
	validateCheckExpression(clause, 'generated CHECK postcondition');
	return withSession(async (session) => {
		const live = await readLiveCheckProjection(session, input.target);
		if (live.validated !== !expected.notValid)
			throw new Error(
				`generated constraint ${input.target.name} postcondition differs`,
			);
		const scratchTable = nextScratchName('table');
		const scratchConstraint = nextScratchName('constraint');
		const staged = await scratchScope(session, async () => {
			await session.query(
				`CREATE TEMP TABLE ${quoteIdent(scratchTable, 'table')} (LIKE ${quoteIdent(input.target.schema, 'schema')}.${quoteIdent(input.target.table, 'table')} INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY)`,
			);
			await session.query(
				`ALTER TABLE ${quoteIdent(scratchTable, 'table')} ADD CONSTRAINT ${quoteIdent(scratchConstraint, 'alias')} ${clause}`,
			);
			return readScratchCheckProjection(
				session,
				scratchTable,
				scratchConstraint,
			);
		});
		if (
			live.expression !== staged.expression ||
			live.validated !== staged.validated ||
			live.noInherit !== staged.noInherit ||
			live.enforced !== staged.enforced
		)
			throw new Error(
				`generated constraint ${input.target.name} postcondition differs`,
			);
		return { kind: 'constraint', projection: live };
	});
}
