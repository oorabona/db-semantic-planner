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

/** Called during planning or once after legacy boundary validation. Never by SQL emission. */
export function resolveReportIncludes(
	intent: QueryIntent,
	decisions: readonly PlanDecision[],
	model: ModelIR | undefined,
	options: {
		defaultPk?: string;
		deriveFk?: (table: string, pk: string) => string;
	} = {},
): SelectExecution {
	const allocator = new RangeAllocator();
	const rootRange = allocator.allocate(intent.from, intent.from);
	allocator.reserve(rootRange.alias);
	const rangesByPath = new Map<
		string,
		{ target: ResolvedRange; output: ResolvedRange }
	>();
	const occupied = new Set([rootRange.alias]);
	const joins: ResolvedJoin[] = (intent.joins ?? []).map(
		(join, intentIndex) => {
			const alias =
				join.alias ?? join.relation ?? join.batchValues?.alias ?? join.table!;
			if (occupied.has(alias))
				throw new Error(`Query scope already binds qualifier '${alias}'.`);
			occupied.add(alias);
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
			const range = allocator.allocate(table, alias);
			allocator.reserve(range.alias);
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
				...(join.on && { on: join.on }),
			};
		},
	);
	const generatedAliases = new Map<string, number>();
	const byPath = new Map(
		decisions
			.filter((d) => d.type === 'include-strategy')
			.map((d) => [d.context.intentPath, d]),
	);
	const visit = (
		includes: readonly IncludeIntent[],
		sourceRange: ResolvedRange,
		parent = '',
		intentParent = '',
		parentFlat = false,
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
				...(include.where && {
					predicate: {
						condition: include.where,
						currentRange: targetRange,
						outerRange: rootRange,
					},
				}),
				children: visit(
					include.include ?? [],
					outputRange,
					relationPath,
					`${intentPath}.`,
					flat,
				),
			};
			return node;
		});
	return { rootRange, joins, includes: visit(intent.include ?? [], rootRange) };
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
