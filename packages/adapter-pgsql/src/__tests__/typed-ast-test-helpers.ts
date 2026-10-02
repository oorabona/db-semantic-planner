/** Test-only adapters from fixture spellings to the established-identifier AST API. */

import { schema } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import {
	sqlColumnRef,
	sqlColumnRefStar,
	sqlDeleteStmt,
	sqlInsertStmt,
	sqlJsonAggCorrelation,
	sqlJsonAggSubquery,
	sqlRangeVar,
	sqlResTarget,
	sqlUpdateStmt,
	sqlWindowFuncCall,
} from '../ast-helpers.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgPhysicalModel } from '../physical-model/index.js';
import {
	declaredColumn,
	declaredTable,
	queryLocal,
} from '../sql-identifier.js';

const id = queryLocal;
const snakeModel = schema({
	userProfiles: {
		id: { type: 'integer', primaryKey: true },
		createdAt: 'string',
		firstName: 'string',
		lastName: 'string',
		displayName: 'string',
		updatedAt: 'string',
		userId: 'integer',
	},
	userAccounts: {
		id: { type: 'integer', primaryKey: true },
		firstName: 'string',
		lastName: 'string',
		createdAt: 'string',
	},
	userSessions: {
		id: { type: 'integer', primaryKey: true },
		userId: 'integer',
	},
} as const).model;
const snakeResolver = createDeclaredNameResolver(
	createPgPhysicalModel({
		mode: 'logical',
		model: snakeModel,
		schema: 'public',
		dbCasing: 'snake_case',
	}),
);

export const snakeColumnRef = (table: string, column: string): Node =>
	sqlColumnRef(
		declaredColumn(snakeResolver, table, column),
		declaredTable(snakeResolver, table),
	);
export const snakeUnqualifiedColumnRef = (
	table: string,
	column: string,
): Node => sqlColumnRef(declaredColumn(snakeResolver, table, column));
export const snakeInsertStmt = (
	table: string,
	columns: readonly string[],
	values: readonly Node[][],
): Node =>
	sqlInsertStmt({
		table: declaredTable(snakeResolver, table),
		columns: columns.map((column) =>
			declaredColumn(snakeResolver, table, column),
		),
		values,
	});
export const snakeUpdateStmt = (
	table: string,
	set: ReadonlyArray<{ column: string; value: Node }>,
	where: Node,
): Node =>
	sqlUpdateStmt({
		table: declaredTable(snakeResolver, table),
		set: set.map(({ column, value }) => ({
			column: declaredColumn(snakeResolver, table, column),
			value,
		})),
		where,
	});
export const snakeDeleteStmt = (table: string, where: Node): Node =>
	sqlDeleteStmt({ table: declaredTable(snakeResolver, table), where });

export const columnRef = (
	column: string,
	table?: string,
	schema?: string,
): Node =>
	sqlColumnRef(
		id(column),
		table === undefined ? undefined : id(table),
		schema === undefined ? undefined : id(schema),
	);
export const columnRefStar = (table?: string): Node =>
	sqlColumnRefStar(table === undefined ? undefined : id(table));
export const rangeVar = (
	table: string,
	alias?: string,
	schema?: string,
): Node =>
	sqlRangeVar(
		id(table),
		alias === undefined ? undefined : id(alias),
		schema === undefined ? undefined : id(schema),
	);
export const resTarget = (value: Node, alias?: string): Node =>
	sqlResTarget(value, alias === undefined ? undefined : id(alias));
export const columnTarget = (
	column: string,
	alias?: string,
	table?: string,
): Node => resTarget(columnRef(column, table), alias);
export const starTarget = (table?: string): Node =>
	resTarget(columnRefStar(table));

export const insertStmt = (options: {
	table: string;
	schema?: string;
	columns?: readonly string[];
	values?: readonly Node[][];
	selectQuery?: Node;
	returning?: Node[];
}): Node =>
	sqlInsertStmt({
		table: id(options.table),
		...(options.schema === undefined ? {} : { schema: id(options.schema) }),
		...(options.columns === undefined
			? {}
			: { columns: options.columns.map(id) }),
		...(options.values === undefined ? {} : { values: options.values }),
		...(options.selectQuery === undefined
			? {}
			: { selectQuery: options.selectQuery }),
		...(options.returning === undefined
			? {}
			: { returning: options.returning }),
	});
export const updateStmt = (options: {
	table: string;
	schema?: string;
	set: ReadonlyArray<{ column: string; value: Node }>;
	where?: Node;
	from?: Node[];
	returning?: Node[];
}): Node =>
	sqlUpdateStmt({
		table: id(options.table),
		...(options.schema === undefined ? {} : { schema: id(options.schema) }),
		set: options.set.map(({ column, value }) => ({
			column: id(column),
			value,
		})),
		...(options.where === undefined ? {} : { where: options.where }),
		...(options.from === undefined ? {} : { from: options.from }),
		...(options.returning === undefined
			? {}
			: { returning: options.returning }),
	});
export const deleteStmt = (options: {
	table: string;
	schema?: string;
	where?: Node;
	using?: Node[];
	returning?: Node[];
}): Node =>
	sqlDeleteStmt({
		table: id(options.table),
		...(options.schema === undefined ? {} : { schema: id(options.schema) }),
		...(options.where === undefined ? {} : { where: options.where }),
		...(options.using === undefined ? {} : { using: options.using }),
		...(options.returning === undefined
			? {}
			: { returning: options.returning }),
	});
export const fkCorrelation = (
	parentColumn: string,
	parentAlias: string,
	targetColumn: string,
	targetAlias: string,
): Node =>
	sqlJsonAggCorrelation(
		id(parentAlias),
		id(parentColumn),
		id(targetAlias),
		id(targetColumn),
	);
export const jsonAggCorrelation = (
	parentAlias: string,
	parentColumn: string,
	targetAlias: string,
	targetColumn: string,
): Node =>
	sqlJsonAggCorrelation(
		id(parentAlias),
		id(parentColumn),
		id(targetAlias),
		id(targetColumn),
	);
export const jsonAggSubquery = (
	table: string,
	where: Node,
	alias: string,
	schema?: string,
	options?: {
		innerAlias?: string;
		columns?: readonly string[];
		childNodes?: readonly { key: string; node: Node }[];
		limit?: number;
		columnValueOverrides?: ReadonlyMap<string, Node>;
		orderBy?: readonly string[];
		orderByFallback?: boolean;
	},
): Node =>
	sqlJsonAggSubquery(
		id(table),
		where,
		id(alias),
		schema === undefined ? undefined : id(schema),
		options === undefined
			? undefined
			: {
					...(options.innerAlias === undefined
						? {}
						: { innerAlias: id(options.innerAlias) }),
					...(options.columns === undefined
						? {}
						: { columns: options.columns.map(id) }),
					...(options.childNodes === undefined
						? {}
						: {
								childNodes: options.childNodes.map(({ key, node }) => ({
									key: id(key),
									node,
								})),
							}),
					...(options.limit === undefined ? {} : { limit: options.limit }),
					...(options.columnValueOverrides === undefined
						? {}
						: { columnValueOverrides: options.columnValueOverrides }),
					...(options.orderBy === undefined
						? {}
						: { orderBy: options.orderBy.map(id) }),
					...(options.orderByFallback === undefined
						? {}
						: { orderByFallback: options.orderByFallback }),
				},
	);
export const windowFuncCall = (
	name: string,
	args: readonly Node[],
	over: {
		partitionBy?: readonly string[];
		orderBy?: readonly { field: string; direction?: 'asc' | 'desc' }[];
	},
	table?: string,
): Node =>
	sqlWindowFuncCall(
		id(name),
		args,
		{
			...(over.partitionBy === undefined
				? {}
				: { partitionBy: over.partitionBy.map(id) }),
			...(over.orderBy === undefined
				? {}
				: {
						orderBy: over.orderBy.map(({ field, direction }) => ({
							field: id(field),
							...(direction === undefined ? {} : { direction }),
						})),
					}),
		},
		table === undefined ? undefined : id(table),
	);
