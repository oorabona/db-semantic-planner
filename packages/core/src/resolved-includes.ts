import {
	type IncludeIntent,
	type ModelIR,
	type PlanDecision,
	type QueryIntent,
	RangeAllocator,
	type ResolvedIncludeNode,
	type ResolvedJoin,
	type ResolvedRange,
	type SelectExecution,
	toColumnList,
	type WhereIntent,
} from '@dbsp/types';
import {
	belongsToManyJoinIncludeRefusal,
	getTrustedNqlRelationFilterFields,
	resolveDeclaredRelationKeys,
	resolveDeclaredRelationPath,
	resolveIncludeRelationName,
} from '@dbsp/types/internal';
import { singularize } from './conventions.js';
import { InvalidOperationError } from './dx/errors.js';
import {
	resolveConditionContext,
	resolveSelectWhere,
} from './resolved-conditions.js';

/** Validate include predicates before lowering or allocating bindings. */
function assertSupportedIncludeWhere(
	includes: readonly IncludeIntent[] | undefined,
	strategies: ReadonlyMap<string, string>,
	parent = '',
	intentParent = '',
	parentStrategy?: string,
): void {
	for (const [index, include] of (includes ?? []).entries()) {
		const path = `${parent}include[${index}](${include.relation})`;
		const intentPath = `${intentParent}include[${index}]`;
		const strategy =
			strategies.get(intentPath) ?? (include.join ? 'join' : 'json_agg');
		if (
			parentStrategy &&
			(parentStrategy === 'cte' || strategy !== parentStrategy)
		) {
			throw new Error(
				`Nested include at ${path} has parent strategy ${parentStrategy} and child strategy ${strategy}; mixed strategies and includes under cte are refused (oorabona/db-semantic-planner#894).`,
			);
		}
		if (include.where) {
			// Walk the complete predicate intent, including query and expression bodies.
			const visit = (node: unknown): void => {
				if (!node || typeof node !== 'object') return;
				if (Array.isArray(node)) {
					for (const child of node) visit(child);
					return;
				}
				const record = node as Record<string, unknown>;
				if (
					record.kind === 'exists' ||
					record.kind === 'notExists' ||
					record.kind === 'relationFilter'
				) {
					throw new Error(
						`Relation predicates inside an include where are not supported yet at ${path}.where for strategy ${strategy} (oorabona/db-semantic-planner#892).`,
					);
				}
				for (const [key, child] of Object.entries(record)) {
					// Literal payloads are data, rather than query/expression intent.
					if (
						key === 'values' ||
						(key === 'value' && record.kind !== 'namedArg')
					)
						continue;
					visit(child);
				}
			};
			visit(include.where);

			if (strategy !== 'join') {
				throw new Error(
					`Include where is not supported for strategy ${strategy} at ${path}.where (oorabona/db-semantic-planner#892).`,
				);
			}
		}
		assertSupportedIncludeWhere(
			include.include,
			strategies,
			`${path}.`,
			`${intentPath}.`,
			strategy,
		);
	}
}

/** Called during planning or once after legacy boundary validation. Never by SQL emission. */
export function resolveReportIncludes(
	intent: QueryIntent,
	decisions: readonly PlanDecision[],
	model: ModelIR | undefined,
	options: {
		whereReservedNames?: readonly string[];
		defaultPk?: string;
		deriveFk?: (table: string, pk: string) => string;
	} = {},
): SelectExecution {
	assertSupportedIncludeWhere(
		intent.include,
		new Map(
			decisions
				.filter((d) => d.type === 'include-strategy')
				.map((d) => [d.context.intentPath!, d.choice]),
		),
	);
	const allocator = new RangeAllocator();
	const rootRange = allocator.bind(intent.from, intent.from);
	allocator.reserve(rootRange.alias);
	for (const name of options.whereReservedNames ?? []) allocator.reserve(name);
	const rangesByPath = new Map<
		string,
		{ target: ResolvedRange; output: ResolvedRange }
	>();
	const visibleJoinRanges: ResolvedRange[] = [rootRange];
	const firstJoinByQualifier = new Map<string, number>();
	(intent.joins ?? []).forEach((join, index) => {
		const qualifier =
			join.alias ?? join.relation ?? join.batchValues?.alias ?? join.table!;
		if (!firstJoinByQualifier.has(qualifier))
			firstJoinByQualifier.set(qualifier, index);
	});
	const joins: ResolvedJoin[] = (intent.joins ?? []).map(
		(join, intentIndex) => {
			const alias =
				join.alias ?? join.relation ?? join.batchValues?.alias ?? join.table!;
			let table = join.table ?? alias;
			let path: ResolvedJoin['path'];
			if (join.relation !== undefined) {
				if (!model)
					throw new Error(
						`join('${join.relation}'): relation-mode join requires a model for FK resolution.`,
					);
				const relations = model.getRelationsFrom(intent.from);
				const relation = relations.find((r) => r.name === join.relation);
				if (!relation)
					throw new Error(
						`join('${join.relation}'): relation not found on table '${intent.from}'. Available: ${relations.map((r) => r.name).join(', ')}`,
					);
				if (relation.type === 'belongsToMany')
					throw new InvalidOperationError(
						'relation',
						belongsToManyJoinIncludeRefusal(`${intent.from}.${relation.name}`),
					);
				const resolved = resolveDeclaredRelationPath(model, intent.from, [
					join.relation,
				]);
				if (!resolved.ok)
					throw new Error(
						`join('${join.relation}'): relation not found on table '${intent.from}'. Available: ${relations.map((r) => r.name).join(', ')}`,
					);
				path = resolved;
				table = resolved.targetTable;
			}
			const range = allocator.bind(table, alias);
			allocator.reserve(range.alias);
			visibleJoinRanges.push(range);
			const on = resolveConditionContext(
				join.on,
				rootRange,
				[...visibleJoinRanges],
				[[range]],
				allocator,
				model,
				0,
				[],
				{
					subqueryRefusal: join.batchValues
						? 'Subquery in BatchValues JOIN ON condition is not supported.'
						: 'Subquery in JOIN ON condition is not supported.',
					firstJoinByQualifier,
					intentIndex,
				},
			);
			return {
				intentPath: `join[${intentIndex}]`,
				intentIndex,
				kind:
					join.relation !== undefined
						? 'relation'
						: join.batchValues
							? 'values'
							: 'table',
				type: join.type,
				range,
				sourceRange: rootRange,
				...(path && { path }),
				...(on && { on }),
			};
		},
	);
	const generatedAliases = new Map<string, number>();
	const byPath = new Map(
		decisions
			.filter((d) => d.type === 'include-strategy')
			.map((d) => [d.context.intentPath, d]),
	);
	const predicates = new Map<
		string,
		{
			where: WhereIntent;
			scopes: readonly (readonly ResolvedRange[])[];
			qualifiers: readonly ReadonlyMap<string, ResolvedRange>[];
		}
	>();
	const visit = (
		includes: readonly IncludeIntent[],
		sourceRange: ResolvedRange,
		parent = '',
		intentParent = '',
		parentFlat = false,
		outerScopes: readonly (readonly ResolvedRange[])[] = [
			[rootRange, ...joins.map((j) => j.range)],
		],
		outerQualifiers: readonly ReadonlyMap<string, ResolvedRange>[] = [],
	): ResolvedIncludeNode[] =>
		includes.map((include, index) => {
			const intentPath = `${intentParent}include[${index}]`;
			const decision = byPath.get(intentPath);
			const context = decision?.context;
			const name = context?.relation ?? include.via ?? include.relation;
			const relation =
				model &&
				(model.getRelation(`${sourceRange.table}.${name}`) ??
					resolveIncludeRelationName(
						model,
						sourceRange.table,
						include.via ?? include.relation,
					));
			const targetTable = relation?.target ?? context?.target;
			if (!targetTable)
				throw new Error(`Include ${intentPath} has no resolved target`);
			const relationType = relation?.type ?? context?.relationType ?? 'hasMany';
			const keys =
				model && relation
					? resolveDeclaredRelationKeys(model, sourceRange.table, relation)
					: undefined;
			let fk =
				keys?.foreignKey ??
				toColumnList(context?.foreignKey ?? relation?.foreignKey);
			const defaultPk = options.defaultPk ?? 'id';
			if (!fk.length)
				fk = [
					(options.deriveFk ?? ((table, pk) => `${singularize(table)}_${pk}`))(
						relationType === 'belongsTo' ? targetTable : sourceRange.table,
						defaultPk,
					),
				];
			let pk = keys
				? relationType === 'belongsTo'
					? keys.targetKey
					: keys.sourceKey
				: toColumnList(
						context?.parentKey ??
							(relationType === 'belongsTo'
								? relation?.targetKey
								: relation?.sourceKey),
					);
			if (!pk.length) pk = [defaultPk];
			const recursion = context?.recursiveInclude;
			const ancestors = recursion?.direction === 'ancestors';
			const from = recursion
				? ancestors
					? fk
					: pk
				: relationType === 'belongsTo'
					? fk
					: pk;
			const to = recursion
				? ancestors
					? pk
					: fk
				: relationType === 'belongsTo'
					? pk
					: fk;
			const declaredPath =
				!recursion && relation
					? resolveDeclaredRelationPath(
							model ?? {
								getRelation: () => relation,
								getRelationsFrom: () => [relation],
							},
							sourceRange.table,
							[relation.name],
						)
					: undefined;
			const path = {
				ok: true as const,
				logicalSegments: [name],
				relations: relation ? [relation] : [],
				targetTable,
				hops:
					recursion || !declaredPath?.ok || declaredPath.hops.length === 0
						? [
								{
									segmentIndex: 0,
									fromTable: sourceRange.table,
									toTable: targetTable,
									pairs: from.map((fromColumn, i) => ({
										fromColumn,
										toColumn: to[i]!,
									})),
								},
							]
						: declaredPath.hops,
			};
			const strategy = (decision?.choice ??
				(include.join ? 'join' : undefined)) as ResolvedIncludeNode['strategy'];
			if (!strategy)
				throw new Error(
					`Include ${intentPath} has no resolved include-strategy decision`,
				);
			const flat = parentFlat || include.strategy === 'flat';
			const publicPath = include.via ?? include.relation;
			const relationPath = parent ? `${parent}.${publicPath}` : publicPath;
			const projectionRequests: NonNullable<
				ResolvedIncludeNode['projectionRequests']
			>[number][] = [];
			if (intent.select?.type === 'expressions') {
				for (const expression of intent.select.columns) {
					if (expression.kind !== 'relationColumn') continue;
					const trusted = getTrustedNqlRelationFilterFields(expression);
					const selectedRelation = trusted?.relation;
					const requestedPath =
						typeof selectedRelation === 'string'
							? selectedRelation
							: (selectedRelation?.join('.') ?? expression.relation);
					if (requestedPath !== relationPath) continue;
					const request = {
						col: trusted?.selectedColumn ?? expression.column ?? '*',
						...(expression.as && { alias: expression.as }),
						...(expression.defaultRelationColumnLabel && {
							defaultLabel: true,
						}),
						...(expression.relationColumnLabelOrigin === 'nql' && {
							nqlLabel: true,
						}),
					};
					if (
						!projectionRequests.some(
							(existing) =>
								JSON.stringify(existing) === JSON.stringify(request),
						)
					)
						projectionRequests.push(request);
				}
			}
			const depth = intentParent.split('include[').length - 1;
			const rootPath = intentPath.match(/^include\[\d+\]/)![0];
			const aliasIndex = generatedAliases.get(rootPath) ?? 0;
			if (strategy === 'lateral' || (strategy === 'cte' && !recursion))
				generatedAliases.set(rootPath, aliasIndex + 1);
			// Include range aliases are derived from relation paths, not caller-authored AS names.
			const targetRange =
				rangesByPath.get(relationPath)?.target ??
				allocator.allocate(
					targetTable,
					recursion
						? '__n'
						: strategy === 'json_agg'
							? depth === 0
								? '__t__'
								: `__t${depth}__`
							: strategy === 'lateral' || strategy === 'cte'
								? `${targetTable}_inner_${aliasIndex}`
								: name,
					strategy === 'join' ? 'query' : intentPath,
				);
			const outputRange =
				rangesByPath.get(relationPath)?.output ??
				(strategy === 'lateral'
					? allocator.allocate(targetTable, `${targetTable}_lat_${aliasIndex}`)
					: strategy === 'cte' && !recursion
						? allocator.allocate(targetTable, `${name}_ref_${aliasIndex}`)
						: targetRange);
			if (!recursion)
				rangesByPath.set(relationPath, {
					target: targetRange,
					output: outputRange,
				});
			if (include.where)
				predicates.set(intentPath, {
					where: include.where,
					scopes: outerScopes,
					qualifiers: outerQualifiers,
				});
			const node: ResolvedIncludeNode = {
				nodeId: intentPath,
				intentPath,
				publicKey: recursion ? include.relation : publicPath,
				relationName: name,
				relationPath,
				path,
				sourceRange,
				hopRanges: [{ from: sourceRange, to: targetRange }],
				targetRange,
				outputRange,
				...(strategy === 'cte' &&
					!recursion && {
						cteRange: allocator.allocate(targetTable, `${name}_cte`),
					}),
				relationType,
				cardinality:
					relationType === 'belongsTo' || relationType === 'hasOne'
						? 'one'
						: 'many',
				strategy,
				...(decision?.joinType && { joinType: decision.joinType }),
				...(include.join && !decision && { joinType: include.join }),
				outputMode: flat ? 'flat' : 'nested',
				...(projectionRequests.length && { projectionRequests }),
				...(include.select && { projection: include.select }),
				ordering: {
					...(include.orderBy && { authored: include.orderBy }),
					fallback: context?.targetOrderKey ?? [],
					usesFallback: context?.orderByFallback === true,
				},
				...(include.limit !== undefined && { limit: include.limit }),
				...(recursion && {
					recursion,
					recursiveRanges: {
						walk: allocator.allocate(targetTable, `${name}_walk`, intentPath),
						next: targetRange,
					},
				}),
				children: visit(
					include.include ?? [],
					outputRange,
					relationPath,
					`${intentPath}.`,
					flat,
					[[outputRange], ...outerScopes],
					[
						new Map([
							[include.relation, outputRange],
							[publicPath, outputRange],
						]),
						...outerQualifiers,
					],
				),
			};
			return node;
		});
	const allocatedIncludes = visit(intent.include ?? [], rootRange);
	const joinedIncludes = (
		nodes: readonly ResolvedIncludeNode[],
	): ResolvedRange[] =>
		nodes.flatMap((n) =>
			n.strategy === 'join'
				? [n.outputRange, ...joinedIncludes(n.children)]
				: [],
		);
	const includeRanges = joinedIncludes(allocatedIncludes);
	const visible = [rootRange, ...joins.map((j) => j.range), ...includeRanges];
	// Legacy IN/scalar aliases share their sequence across include predicates.
	const aliasState = {
		count: joins.length + new Set(includeRanges.map((range) => range.id)).size,
	};
	const resolvePredicates = (
		nodes: readonly ResolvedIncludeNode[],
	): ResolvedIncludeNode[] =>
		nodes.map((node) => {
			const predicate = predicates.get(node.intentPath);
			return {
				...node,
				...(predicate && {
					predicate: {
						condition: resolveConditionContext(
							predicate.where,
							node.targetRange,
							[
								node.targetRange,
								...visible.filter((r) => r.id !== node.targetRange.id),
							],
							predicate.scopes,
							allocator,
							model,
							aliasState.count,
							[],
							{
								include: true,
								outerQualifiers: predicate.qualifiers,
								aliasState,
							},
						)!,
						currentRange: node.targetRange,
						outerRange: node.sourceRange,
					},
				}),
				children: resolvePredicates(node.children),
			};
		});
	const includes = resolvePredicates(allocatedIncludes);
	const where = resolveSelectWhere(
		intent.where,
		rootRange,
		[rootRange, ...joins.map((j) => j.range)],
		allocator,
		model,
		joins.length + includeRanges.length,
		includeRanges,
	);
	return { rootRange, joins, includes, ...(where && { where }) };
}
/** Include decisions retain observations only; resolved authority belongs to execution. */
export function observeIncludeDecisions(
	decisions: readonly PlanDecision[],
): readonly PlanDecision[] {
	return decisions.map((d) =>
		d.type === 'include-strategy' ||
		(d.type === 'join-type' && d.context.intentPath?.startsWith('include['))
			? {
					id: d.id,
					type: d.type,
					choice: d.choice,
					reasoning: d.reasoning,
					alternatives: d.alternatives,
					context: {
						...(d.context.intentPath && {
							intentPath: d.context.intentPath,
							nodeId: d.context.intentPath,
						}),
					},
				}
			: d,
	);
}
