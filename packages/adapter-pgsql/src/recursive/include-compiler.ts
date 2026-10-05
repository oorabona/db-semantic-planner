/** A recursive include is a correlated scalar aggregate, never a root JOIN. */

import { toColumnList } from '@dbsp/types';
import type { Node, SelectStmt } from '@pgsql/types';
import {
	buildChunkedJsonObject,
	coalesceExpr,
	emptyJsonArrayNode,
	funcCall,
	nullConstNode,
	sortBy,
	sqlColumnRef,
	sqlRangeVar,
	sqlResTarget,
	stringConstNode,
	typeCast,
} from '../ast-helpers.js';
import { truncateIdentifier } from '../column-metadata.js';
import type {
	CompilerContext,
	CompilerState,
	Decision,
	IncludeResult,
} from '../handlers/types.js';
import {
	createCompilerState,
	expressionQualifiedColumnRef,
} from '../handlers/types.js';
import { allocateScopeAlias } from '../handlers/where/exists.js';
import {
	requireRelationTargetColumns,
	resolveRelationTarget,
} from '../relation-target-projection.js';
import { queryLocal, resolveDeclaredIdentifier } from '../sql-identifier.js';
import { buildRecursiveCte } from './cte-compiler.js';

export function compileRecursiveInclude(
	decision: Decision,
	ctx: CompilerContext,
	state: CompilerState = createCompilerState(),
): IncludeResult {
	const options = decision.recursiveInclude!;
	const table = decision.targetTable!;
	const relation = decision.relation!;
	const maxDepth = options.maxDepth ?? 100;
	const pk = toColumnList(decision.parentKey);
	const fk = toColumnList(decision.foreignKey);
	if (pk.length !== 1 || fk.length !== 1)
		throw new Error(
			'Recursive include requires a single parentKey and foreignKey',
		);
	const target = resolveRelationTarget(queryLocal(table), ctx);
	if (target.cteName !== undefined)
		throw new Error('Recursive include of a binding target is not supported');
	if (decision.columns?.length === 0)
		throw new Error(
			'Recursive include option select requires at least one field',
		);
	const columns =
		decision.columns?.length && !decision.columns.includes('*')
			? decision.columns
			: ctx.model?.getTable(table)?.columns.map((c) => c.name);
	if (!columns?.length)
		throw new Error(
			'Recursive include requires model columns or explicit select',
		);
	const walkColumns = [
		...new Set([
			...columns,
			pk[0]!,
			fk[0]!,
			...toColumnList(ctx.model?.getTable(table)?.primaryKey),
		]),
	];
	requireRelationTargetColumns(
		target,
		walkColumns.map(queryLocal),
		'traversal column',
		relation,
	);
	const declared = (column: string) =>
		resolveDeclaredIdentifier(ctx.declaredNames, ctx.dbCasing ?? 'preserve', {
			kind: 'column',
			table,
			column,
		});
	const dbPk = declared(pk[0]!);
	const dbFk = declared(fk[0]!);
	const allocate = (base: string) =>
		queryLocal(
			allocateScopeAlias(
				ctx,
				state,
				(suffix) => {
					const postfix = suffix === 0 ? '' : `_${suffix}`;
					// Reserve the ASCII suffix bytes before shortening the UTF-8 base.
					return truncateIdentifier(base, 63 - postfix.length) + postfix;
				},
				0,
				[...(ctx.bindingNames ?? []), ...state.ctes.keys()],
			),
		);
	const modelColumns = ctx.model?.getTable(table)?.columns;
	const unavailable = new Set(
		modelColumns?.flatMap((column) => [column.name, declared(column.name)]) ??
			walkColumns.flatMap((column) => [column, declared(column)]),
	);
	const internal = (base: string) => {
		let candidate = base;
		for (let suffix = 1; unavailable.has(candidate); suffix++)
			candidate = `${base}_${suffix}`;
		unavailable.add(candidate);
		return queryLocal(candidate);
	};
	const depthName = internal('__depth');
	const visitedName = internal('__visited');
	const nodeTextName = internal('__node_text');
	const parentTextName = internal('__parent_text');
	for (const column of walkColumns) {
		if (
			modelColumns &&
			!modelColumns.some((candidate) => candidate.name === column)
		)
			throw new Error(
				`Recursive include '${relation}' cannot compile column '${column}' on table '${table}'`,
			);
	}
	const resolved = decision.payloadShape!;
	const jsonAlias = resolved.outputLabel;
	const walk = allocate(`${relation}_walk`);
	const innerAlias = allocate('__n');
	const outer = ctx.currentAlias ?? ctx.rootTable;
	const col = (alias: string, column: string) =>
		sqlColumnRef(queryLocal(column), queryLocal(alias));
	const { cte } = buildRecursiveCte({
		cteAlias: walk,
		internalNames: { node: innerAlias, depth: depthName, visited: visitedName },
		table: resolveDeclaredIdentifier(
			ctx.declaredNames,
			ctx.dbCasing ?? 'preserve',
			{ kind: 'table', table },
		),
		pkColumn: dbPk,
		fkColumn: dbFk,
		anchor: { mode: 'standalone' },
		isAncestors: options.direction === 'ancestors',
		maxDepth,
		selectColumns: walkColumns.map(declared),
		ctx,
		correlation: {
			seed: expressionQualifiedColumnRef(
				options.direction === 'ancestors' ? fk[0]! : pk[0]!,
				outer,
				ctx,
			),
			rootId: expressionQualifiedColumnRef(pk[0]!, outer, ctx),
		},
	});
	const identityColumn = (role: 'node' | 'parent') =>
		resolved.privateFields!.find((field) => field.role === role)!.physicalName;
	const identityTargets = (alias: string) => [
		sqlResTarget(
			typeCast(col(alias, identityColumn('node')), 'text'),
			nodeTextName,
		),
		sqlResTarget(
			typeCast(col(alias, identityColumn('parent')), 'text'),
			parentTextName,
		),
	];
	const walkQuery = (
		cte as { CommonTableExpr: { ctequery: { SelectStmt: SelectStmt } } }
	).CommonTableExpr.ctequery.SelectStmt;
	walkQuery.larg!.targetList!.push(...identityTargets(innerAlias));
	walkQuery.rarg!.targetList!.push(...identityTargets(innerAlias));
	const args = resolved.columns.flatMap((column) => {
		const value = col(walk, column.physicalName);
		return [
			stringConstNode(column.publicKey),
			column.readHandling ? typeCast(value, 'text') : value,
		];
	});
	for (const field of resolved.privateFields!) {
		const value = col(
			walk,
			field.role === 'depth'
				? depthName
				: field.role === 'node'
					? nodeTextName
					: parentTextName,
		);
		args.push(stringConstNode(field.jsonKey), value);
	}
	const payload = buildChunkedJsonObject(args);
	const aggregate = funcCall('json_agg', [payload], {
		orderBy: [
			sortBy(col(walk, depthName)),
			sortBy(col(walk, dbPk)),
			...toColumnList(ctx.model?.getTable(table)?.primaryKey)
				.map(declared)
				.filter((column) => column !== dbPk)
				.map((column) => sortBy(col(walk, column))),
		],
	});
	// Self is a depth-zero output row, separate from the recursive seed.
	if (options.omitSelf === false) {
		const self: SelectStmt = {
			targetList: walkColumns.map((column) =>
				sqlResTarget(
					expressionQualifiedColumnRef(column, outer, ctx),
					declared(column),
				),
			),
			fromClause: [],
		};
		self.targetList!.push(
			sqlResTarget({ A_Const: { ival: { ival: 0 } } }, depthName),
			sqlResTarget(
				funcCall('array_remove', [
					{
						A_ArrayExpr: {
							elements: [expressionQualifiedColumnRef(pk[0]!, outer, ctx)],
						},
					},
					nullConstNode(),
				]),
				visitedName,
			),
		);
		self.targetList!.push(...identityTargets(outer));
		const outputWalk = allocate(`${relation}_output`);
		const outputQuery: Node = {
			SelectStmt: {
				op: 'SETOP_UNION',
				all: true,
				larg: {
					targetList: walkColumns.map((column) =>
						sqlResTarget(col(walk, declared(column))),
					),
					fromClause: [sqlRangeVar(walk)],
				},
				rarg: self,
			},
		};
		(
			outputQuery as { SelectStmt: SelectStmt }
		).SelectStmt.larg!.targetList!.push(
			sqlResTarget(col(walk, depthName)),
			sqlResTarget(col(walk, visitedName)),
			sqlResTarget(col(walk, nodeTextName)),
			sqlResTarget(col(walk, parentTextName)),
		);
		// Keep the aggregate qualifier stable using a range alias.
		const select: Node = {
			SelectStmt: {
				withClause: {
					recursive: true,
					ctes: [
						cte,
						{ CommonTableExpr: { ctename: outputWalk, ctequery: outputQuery } },
					],
				},
				targetList: [sqlResTarget(aggregate)],
				fromClause: [sqlRangeVar(outputWalk, walk)],
			},
		};
		return {
			targets: [
				sqlResTarget(
					coalesceExpr([
						{ SubLink: { subLinkType: 'EXPR_SUBLINK', subselect: select } },
						emptyJsonArrayNode(),
					]),
					queryLocal(jsonAlias),
				),
			],
		};
	}
	const select: Node = {
		SelectStmt: {
			withClause: { recursive: true, ctes: [cte] },
			targetList: [sqlResTarget(aggregate)],
			fromClause: [sqlRangeVar(walk)],
		},
	};
	return {
		targets: [
			sqlResTarget(
				coalesceExpr([
					{ SubLink: { subLinkType: 'EXPR_SUBLINK', subselect: select } },
					emptyJsonArrayNode(),
				]),
				queryLocal(jsonAlias),
			),
		],
	};
}
