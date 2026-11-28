import {
	EXPRESSION_BRAND,
	type IncludeIntent,
	isParamIntent,
	type ModelIR,
	NotYetSupportedError,
	type PlanDecision,
	type QueryIntent,
	RangeAllocator,
	REF_BRAND,
	type ResolvedIncludeNode,
	type ResolvedJoin,
	type ResolvedRange,
	type SelectExecution,
	toColumnList,
	type WhereIntent,
} from '@dbsp/types';
import {
	belongsToManyTraversalRefusal,
	getTrustedNqlRelationFilterFields,
	isFieldRef,
	resolveDeclaredRelationKeys,
	resolveDeclaredRelationPath,
	resolveIncludeRelationName,
} from '@dbsp/types/internal';
import { singularize } from './conventions.js';
import { getDefaultFilter } from './default-filter-map.js';
import {
	refuseTypedFunctionObjects,
	refuseTypedFunctionOriginRef,
} from './dx/coerce.js';
import { relationJoinHops } from './dx/relation-join-path.js';
import { isBoundPayload } from './intent-payload.js';
import { containsOriginRefs, refuseLocalOriginRefs } from './path-ref-scan.js';
import { getRelationalReadPolicy } from './relational-read-plans.js';
import {
	type HavingAggregate,
	type OriginFrame,
	resolveConditionContext,
	resolveScanDefaultFilter,
	type UnreadableRange,
} from './resolved-conditions.js';
import { classifyScalarBody, nextSelectBody } from './scalar-body.js';

/** An outerRef() operand: a SubqueryRefIntent or an outer FieldRef. */
function isOuterRef(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const node = value as Record<string, unknown>;
	return (
		(node.kind === 'ref' && node.outer === true) ||
		(isFieldRef(node) && node.scope === 'outer')
	);
}

/** A condition holding an outerRef() outside any nested query body. */
function holdsOuterRef(value: unknown): boolean {
	if (!value || typeof value !== 'object' || isParamIntent(value)) return false;
	if (Array.isArray(value)) return value.some(holdsOuterRef);
	if (isOuterRef(value)) return true;
	const node = value as Record<string, unknown>;
	if (node.kind === 'literal' || node.kind === 'param') return false;
	if (absorbsBody(node) || (node.kind === 'subquery' && node.query))
		return false;
	// A compared value is a bound payload unless it is an outerRef().
	return dataEntries(node).some(
		([key, child]) =>
			isOuterRef(child) ||
			(!isBoundPayload(node, key, child) && holdsOuterRef(child)),
	);
}

/** A qualified outerRef() anywhere below, nested query bodies included. */
function holdsQualifiedOuterRef(
	value: unknown,
	seen = new Set<object>(),
): boolean {
	if (!value || typeof value !== 'object' || isParamIntent(value)) return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value))
		return value.some((item) => holdsQualifiedOuterRef(item, seen));
	if (isOuterRef(value)) {
		const ref = value as { column?: unknown; alias?: unknown };
		return (
			Boolean(ref.alias) ||
			(typeof ref.column === 'string' && ref.column.includes('.'))
		);
	}
	const node = value as Record<string, unknown>;
	if (node.kind === 'literal' || node.kind === 'param') return false;
	return dataEntries(node).some(
		([key, child]) =>
			(isOuterRef(child) || !isBoundPayload(node, key, child)) &&
			holdsQualifiedOuterRef(child, seen),
	);
}

/** Own enumerable data properties; accessors are never invoked. */
function dataEntries(value: object): [string, unknown][] {
	const entries: [string, unknown][] = [];
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor)
			entries.push([key, descriptor.value]);
	}
	return entries;
}

/** Nodes whose body another resolution absorbs whole; their children stay shared. */
function absorbsBody(node: Record<string, unknown>): boolean {
	return (
		[
			'exists',
			'notExists',
			'relationFilter',
			'rawExists',
			'rawNotExists',
		].includes(String(node.kind)) ||
		((node.kind === 'subquery' || node.kind === 'in') &&
			(node.subquery !== undefined || node.query !== undefined))
	);
}

/**
 * Copy one object or array: same prototype (a copied array is an array), own
 * data descriptors given their copied value and made writable and configurable,
 * accessors kept without being invoked; an array's length follows its source.
 */
function copyNode(
	value: object,
	child: (key: string, value: unknown) => unknown,
): object {
	const copy: object = Array.isArray(value)
		? Object.setPrototypeOf(
				new Array<unknown>(value.length),
				Object.getPrototypeOf(value),
			)
		: (Object.create(Object.getPrototypeOf(value)) as object);
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === 'length') continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		Object.defineProperty(
			copy,
			key,
			'value' in descriptor
				? {
						...descriptor,
						value:
							typeof key === 'string'
								? child(key, descriptor.value)
								: descriptor.value,
						writable: true,
						configurable: true,
					}
				: { ...descriptor, configurable: true },
		);
	}
	return copy;
}

/**
 * The executable intent: an object reached more than once across
 * `where`, `having`, select and `orderBy` gets a distinct copy at each occurrence
 * outside `where`, ancestors included, so a resolution bound to an object binds
 * one occurrence. The caller's intent is never written.
 */
function copyRepeatedOccurrences(intent: QueryIntent): QueryIntent {
	const counts = new Map<object, number>();
	const walk = (value: unknown, path: Set<object>): void => {
		if (!value || typeof value !== 'object' || isParamIntent(value)) return;
		if (path.has(value)) return;
		const node = value as Record<string, unknown>;
		if (!Array.isArray(value)) {
			if (node.kind === 'literal' || node.kind === 'param') return;
			counts.set(value, (counts.get(value) ?? 0) + 1);
			if (absorbsBody(node)) return;
		}
		path.add(value);
		for (const [key, child] of dataEntries(node)) {
			if (!Array.isArray(value) && isBoundPayload(node, key, child)) continue;
			walk(child, path);
		}
		path.delete(value);
	};
	const positions = ['where', 'having', 'select', 'orderBy'] as const;
	for (const position of positions) walk(intent[position], new Set());
	if (![...counts.values()].some((n) => n > 1)) return intent;
	const repeated = new Map<object, boolean>();
	const holdsRepeated = (value: unknown, path: Set<object>): boolean => {
		if (!value || typeof value !== 'object' || isParamIntent(value))
			return false;
		const known = repeated.get(value);
		if (known !== undefined) return known;
		if (path.has(value)) return false;
		const node = value as Record<string, unknown>;
		let result = (counts.get(value) ?? 0) > 1;
		if (!result && (Array.isArray(value) || !absorbsBody(node))) {
			path.add(value);
			result = dataEntries(node).some(
				([key, child]) =>
					(Array.isArray(value) || !isBoundPayload(node, key, child)) &&
					holdsRepeated(child, path),
			);
			path.delete(value);
		}
		repeated.set(value, result);
		return result;
	};
	const copy = (value: unknown, path: Set<object>): unknown => {
		if (!holdsRepeated(value, new Set()) || path.has(value as object))
			return value;
		const node = value as Record<string, unknown>;
		const absorbed = !Array.isArray(value) && absorbsBody(node);
		path.add(value as object);
		const result = copyNode(value as object, (key, child) =>
			absorbed || (!Array.isArray(value) && isBoundPayload(node, key, child))
				? child
				: copy(child, path),
		);
		path.delete(value as object);
		return result;
	};
	const replaced = new Map<string, unknown>();
	for (const position of ['having', 'select', 'orderBy'] as const) {
		const next = copy(intent[position], new Set());
		if (next !== intent[position]) replaced.set(position, next);
	}
	if (replaced.size === 0) return intent;
	return copyNode(intent, (key, child) =>
		replaced.has(key) ? replaced.get(key) : child,
	) as QueryIntent;
}

/** HAVING's aggregate aliases: builder aggregates and aggregate columns with a field. */
function havingAggregateAliases(
	select: QueryIntent['select'],
): ReadonlyMap<string, HavingAggregate> {
	const aliases = new Map<string, HavingAggregate>();
	const add = (
		as: string | undefined,
		aggregate: {
			function: string;
			field?: string | undefined;
			distinct?: boolean | undefined;
			filter?: WhereIntent | undefined;
		},
	): void => {
		if (as === undefined || aliases.has(as)) return;
		aliases.set(as, {
			function: aggregate.function,
			...(aggregate.field !== undefined && { field: aggregate.field }),
			...(aggregate.distinct === true && { distinct: true }),
			...(aggregate.filter !== undefined && { filter: aggregate.filter }),
		});
	};
	if (select?.type === 'aggregate')
		for (const aggregate of select.aggregates) add(aggregate.as, aggregate);
	else if (select?.type === 'expressions')
		// A column aggregate compiled as a SELECT aggregate: with a field, or a
		// field-less count (count(*)); a field-less call with extra arguments is not.
		for (const column of select.columns)
			if (
				column.kind === 'aggregate' &&
				(column.field ||
					(column.function === 'count' && !column.extraArgs?.length))
			)
				add(column.as, column);
	return aliases;
}

function dataValue(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Column names an operand of a condition leaf references, bodies and FILTERs excluded. */
function conditionRefs(node: Record<string, unknown>): string[] {
	const names: string[] = [];
	const walk = (value: unknown): void => {
		if (!value || typeof value !== 'object' || isParamIntent(value)) return;
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		const item = value as Record<string, unknown>;
		const intent = dataValue(item, 'intent');
		if (intent && typeof intent === 'object') {
			walk(intent);
			return;
		}
		if (item.kind === 'literal' || item.kind === 'param') return;
		if (
			(item.kind === 'ref' && item.outer !== true) ||
			item.kind === 'column' ||
			item.kind === 'columnAlias'
		) {
			if (typeof item.column === 'string') names.push(item.column);
			return;
		}
		for (const [key, child] of dataEntries(item)) {
			if (key === 'query' || key === 'subquery' || key === 'filter') continue;
			walk(child);
		}
	};
	const value = dataValue(node, 'value');
	// A schema ref() marker names its target column.
	if (
		value &&
		typeof value === 'object' &&
		REF_BRAND in value &&
		typeof (value as { target?: unknown }).target === 'string'
	)
		names.push((value as unknown as { target: string }).target);
	const intent =
		value && typeof value === 'object' ? dataValue(value, 'intent') : undefined;
	if (intent && typeof intent === 'object') walk(intent);
	if (node.kind === 'expression') walk(dataValue(node, 'expr'));
	return names;
}

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
				if (!node || typeof node !== 'object' || isParamIntent(node)) return;
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
					throw new NotYetSupportedError(
						`relation predicate ${record.kind}()`,
						`include where at ${path}`,
						892,
					);
				}
				for (const [key, child] of Object.entries(record)) {
					// Branded expression values contain intent; literal/parameter data does not.
					const expressionValue =
						child !== null &&
						typeof child === 'object' &&
						EXPRESSION_BRAND in child;
					if (
						key === 'values' ||
						(key === 'value' &&
							record.kind !== 'namedArg' &&
							(record.kind === 'literal' || !expressionValue))
					)
						continue;
					visit(child);
				}
			};
			visit(include.where);

			if (strategy !== 'join') {
				throw new NotYetSupportedError(
					'include where',
					`${strategy} include at ${path}`,
					892,
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

/**
 * Called during planning or once after legacy boundary validation. Never by SQL emission.
 * Returns the execution and the intent the adapter compiles, which holds per-occurrence copies.
 */
export function resolveReportIncludes(
	intent: QueryIntent,
	decisions: readonly PlanDecision[],
	model: ModelIR | undefined,
	options: {
		defaultFilters?: Readonly<Record<string, WhereIntent>>;
		skipRootDefaultFilter?: boolean;
		whereReservedNames?: readonly string[];
		defaultPk?: string;
		deriveFk?: (table: string, pk: string) => string;
		/** Whether a FROM name is a visible query-local source (an NQL binding or a CTE). */
		isLocalSource?: ((name: string) => boolean) | undefined;
		/** A scalar subquery body: the enclosing query's allocator and ranges. */
		nested?: {
			readonly allocator: RangeAllocator;
			readonly enclosing: readonly (readonly ResolvedRange[])[];
			/** The names written for ranges of each enclosing scope, aligned with `enclosing`. */
			readonly qualifiers: readonly ReadonlyMap<string, ResolvedRange>[];
			readonly entryDepth: number;
			readonly unreadableRange?: UnreadableRange;
			readonly origin?: OriginFrame;
		};
	} = {},
): { readonly execution: SelectExecution; readonly intent: QueryIntent } {
	assertSupportedIncludeWhere(
		intent.include,
		new Map(
			decisions
				.filter((d) => d.type === 'include-strategy')
				.map((d) => [d.context.intentPath!, d.choice]),
		),
	);
	const nested = options.nested;
	const allocator = nested?.allocator ?? new RangeAllocator();
	// A body's range is generated in its own SQL scope, after every enclosing
	// alias and every earlier body alias was reserved.
	const body = nested && nextSelectBody(allocator, intent.from);
	const rootRange = body
		? allocator.allocate(intent.from, body.alias, body.scope)
		: allocator.bind(intent.from, intent.from);
	allocator.reserve(rootRange.alias);
	const enclosing = nested?.enclosing ?? [];
	// Every resolution in a body reads the enclosing scopes core bound it in,
	// with the names written in them: core alone binds the body's outerRefs.
	const scopeMode = {
		...(nested && {
			entryDepth: nested.entryDepth,
			outerQualifiers: nested.qualifiers,
			...(nested.origin && { origin: nested.origin }),
		}),
		...(nested?.unreadableRange && {
			unreadableRange: nested.unreadableRange,
		}),
		...(options.isLocalSource && { isLocalSource: options.isLocalSource }),
	};
	const rootDefaultFilter =
		options.skipRootDefaultFilter || intent.batchValuesSource
			? undefined
			: resolveScanDefaultFilter(options.defaultFilters, rootRange, model);
	// After the root default filter, which the planned WHERE also holds: its
	// refusal keeps that filter's envelope.
	refuseTypedFunctionObjects(intent, true);
	for (const name of options.whereReservedNames ?? []) allocator.reserve(name);
	const rangesByPath = new Map<
		string,
		{ target: ResolvedRange; output: ResolvedRange }
	>();
	const visibleJoinRanges: ResolvedRange[] = [rootRange];
	const firstJoinByQualifier = new Map<string, number>();
	(intent.joins ?? []).forEach((join, index) => {
		const qualifiers =
			join.relation !== undefined
				? relationJoinHops(join.relation, join.alias).aliases
				: [join.alias ?? join.batchValues?.alias ?? join.table!];
		for (const qualifier of qualifiers)
			if (!firstJoinByQualifier.has(qualifier))
				firstJoinByQualifier.set(qualifier, index);
	});
	/** One range per relation of a relation-mode join, each keyed to the previous one. */
	const resolveRelationJoinHops = (
		relationPath: string,
		alias: string | readonly string[] | undefined,
	): {
		readonly table: string;
		readonly alias: string;
		readonly path: NonNullable<ResolvedJoin['path']>;
	}[] => {
		if (!model)
			throw new Error(
				`join('${relationPath}'): relation-mode join requires a model for FK resolution.`,
			);
		const { segments, aliases } = relationJoinHops(relationPath, alias);
		const notFound = (segmentIndex: number, table: string): Error => {
			const available = model
				.getRelationsFrom(table)
				.map((r) => r.name)
				.join(', ');
			return new Error(
				segmentIndex === 0
					? `join('${relationPath}'): relation not found on table '${table}'. Available: ${available}`
					: `join('${relationPath}'): relation '${segments[segmentIndex]}' not found on table '${table}'. Available: ${available}`,
			);
		};
		let table = intent.from;
		for (const [segmentIndex, segment] of segments.entries()) {
			const relation = model
				.getRelationsFrom(table)
				.find((r) => r.name === segment);
			if (!relation) throw notFound(segmentIndex, table);
			if (relation.type === 'belongsToMany')
				throw belongsToManyTraversalRefusal(
					`${table}.${relation.name}`,
					'join',
				);
			table = relation.target;
		}
		const resolved = resolveDeclaredRelationPath(model, intent.from, segments);
		if (!resolved.ok)
			throw notFound(resolved.segmentIndex, resolved.sourceTable);
		if (
			resolved.hops.length !== segments.length ||
			resolved.hops.some((hop, k) => hop.segmentIndex !== k)
		)
			throw new Error(
				`join('${relationPath}'): the resolved relation path does not hold one hop per segment.`,
			);
		return segments.map((_, k) => {
			const target = resolved.relations[k]!.target;
			return {
				table: target,
				alias: aliases[k]!,
				path: {
					ok: true,
					logicalSegments: segments.slice(0, k + 1),
					relations: resolved.relations.slice(0, k + 1),
					hops: resolved.hops.slice(0, k + 1),
					targetTable: target,
				},
			};
		});
	};
	const joins: ResolvedJoin[] = (intent.joins ?? []).flatMap(
		(join, intentIndex) => {
			const hops =
				join.relation !== undefined
					? resolveRelationJoinHops(join.relation, join.alias)
					: (() => {
							const alias =
								join.alias ?? join.batchValues?.alias ?? join.table!;
							return [{ table: join.table ?? alias, alias, path: undefined }];
						})();
			let sourceRange = rootRange;
			return hops.map((hop) => {
				const range = allocator.bind(hop.table, hop.alias);
				allocator.reserve(range.alias);
				visibleJoinRanges.push(range);
				const defaultFilter = join.batchValues
					? undefined
					: resolveScanDefaultFilter(options.defaultFilters, range, model);
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
						defaultFilters: options.defaultFilters,
						subqueryRefusal: join.batchValues
							? 'Subquery in BatchValues JOIN ON condition is not supported.'
							: 'Subquery in JOIN ON condition is not supported.',
						firstJoinByQualifier,
						intentIndex,
					},
				);
				const resolvedJoin: ResolvedJoin = {
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
					sourceRange,
					...(hop.path && { path: hop.path }),
					...(on && { on }),
					...(defaultFilter && { defaultFilter }),
				};
				sourceRange = range;
				return resolvedJoin;
			});
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
						next: allocator.allocate(
							targetTable,
							targetRange.alias,
							`${intentPath}.step`,
						),
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
			const recursiveRanges = node.recursiveRanges;
			const anchorDefaultFilter =
				recursiveRanges &&
				resolveScanDefaultFilter(
					options.defaultFilters,
					node.targetRange,
					model,
				);
			const stepDefaultFilter =
				recursiveRanges &&
				resolveScanDefaultFilter(
					options.defaultFilters,
					recursiveRanges.next,
					model,
				);
			return {
				...node,
				...(recursiveRanges && {
					recursiveRanges: {
						...recursiveRanges,
						...(anchorDefaultFilter && { anchorDefaultFilter }),
						...(stepDefaultFilter && { stepDefaultFilter }),
					},
				}),
				...(() => {
					const defaultFilter =
						!recursiveRanges &&
						resolveScanDefaultFilter(
							options.defaultFilters,
							node.targetRange,
							model,
						);
					return defaultFilter ? { defaultFilter } : {};
				})(),
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
								defaultFilters: options.defaultFilters,
								outerQualifiers: predicate.qualifiers,
								aliasState,
								originRoot: rootRange,
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
	let where = resolveConditionContext(
		intent.where,
		rootRange,
		[rootRange, ...joins.map((j) => j.range)],
		enclosing,
		allocator,
		model,
		joins.length + includeRanges.length,
		includeRanges,
		{
			defaultFilters: options.defaultFilters,
			rootDefaultFilter,
			...scopeMode,
			// A body's root was allocated and reserved above; it has no join or include.
			...(nested && { rootScopeReserved: true }),
		},
	);
	const rootFilterIntent = getDefaultFilter(
		options.defaultFilters,
		rootRange.table,
	);
	const alreadyApplied =
		intent.where === rootFilterIntent ||
		(intent.where?.kind === 'and' &&
			intent.where.conditions[0] === rootFilterIntent);
	if (rootDefaultFilter && !alreadyApplied)
		where = where
			? { kind: 'and', conditions: [rootDefaultFilter, where] }
			: rootDefaultFilter;

	const executable = copyRepeatedOccurrences(intent);
	const expressionConditions: NonNullable<
		SelectExecution['expressionConditions']
	>[number][] = [];
	const expressionSubqueries: NonNullable<
		SelectExecution['expressionSubqueries']
	>[number][] = [];
	// Visit each occurrence, but leave cyclic metadata to the compiler's refusal.
	const inspected = new WeakSet<object>();
	// Expression-position bodies share one alias counter, as the legacy FILTER lowering did.
	const expressionAliases = { count: 0 };
	const dottedField = (node: Record<string, unknown>): boolean =>
		[
			'comparison',
			'like',
			'in',
			'any',
			'null',
			'range',
			'jsonContains',
			'jsonExists',
		].includes(String(node.kind)) &&
		typeof node.field === 'string' &&
		node.field.includes('.');
	const havingAliases = havingAggregateAliases(intent.select);
	/** A leaf HAVING decides through an aggregate alias, directly or in an operand. */
	const namesAlias = (node: Record<string, unknown>): boolean =>
		havingAliases.size > 0 &&
		((typeof node.field === 'string' && havingAliases.has(node.field)) ||
			conditionRefs(node).some((name) => havingAliases.has(name)));
	/** An operand qualifier naming no visible range (#1004): refused by core. */
	const invisibleQualifier = (
		node: Record<string, unknown>,
		inHaving: boolean,
	): boolean =>
		conditionRefs(node).some((name) => {
			const dot = name.indexOf('.');
			if (dot < 0 || (inHaving && havingAliases.has(name))) return false;
			const qualifier = name.slice(0, dot);
			return !visible.some(
				(range) => range.alias === qualifier || range.table === qualifier,
			);
		});
	const localConditions: { intentPath: string }[] = [];
	/**
	 * Whether a condition root holds an expression subquery on a query-local
	 * source. Decided before any resolution, so it allocates and plans nothing and
	 * does not depend on operand order. It walks query structure only (bound
	 * payloads, literals and parameters are data), and below a query carrying an
	 * issued read policy it classifies with that policy's filters, an explicit
	 * disable included, as the resolver does.
	 */
	const holdsLocalBody = (start: unknown): boolean => {
		if (!model) return false;
		const seen = new Set<object>();
		const visit = (
			value: unknown,
			filters: typeof options.defaultFilters,
		): boolean => {
			if (!value || typeof value !== 'object' || isParamIntent(value))
				return false;
			if (seen.has(value)) return false;
			seen.add(value);
			if (Array.isArray(value))
				return value.some((child) => visit(child, filters));
			const node = value as Record<string, unknown>;
			if (
				node.kind === 'literal' ||
				node.kind === 'param' ||
				node.kind === 'parameter'
			)
				return false;
			if (
				node.kind === 'subquery' &&
				node.query &&
				classifyScalarBody(
					node.query as QueryIntent,
					model,
					filters,
					options.isLocalSource,
				) === 'local'
			)
				return true;
			const policy =
				typeof node.from === 'string'
					? getRelationalReadPolicy(value as QueryIntent)
					: undefined;
			const below = policy ? policy.filters : filters;
			return Object.entries(node).some(
				([key, child]) =>
					!isBoundPayload(node, key, child) && visit(child, below),
			);
		};
		return visit(start, options.defaultFilters);
	};
	let callDepth = 0;
	const inspect = (
		value: unknown,
		intentPath: string,
		condition?: 'HAVING' | 'CASE WHEN' | 'FILTER',
		inHaving = false,
		underHaving = false,
		root = false,
	): void => {
		// A value at a condition root is a condition: a parameter, a literal or an
		// expression subquery there is refused by the resolver while planning,
		// never skipped as data.
		if (
			condition !== undefined &&
			root &&
			model !== undefined &&
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			(isParamIntent(value) ||
				(value as { kind?: unknown }).kind === 'literal' ||
				(value as { kind?: unknown }).kind === 'param' ||
				((value as { kind?: unknown }).kind === 'subquery' &&
					(value as { query?: unknown }).query !== undefined))
		) {
			resolveConditionContext(
				value as WhereIntent,
				rootRange,
				visible,
				enclosing,
				allocator,
				model,
				expressionAliases.count,
				[],
				{
					defaultFilters: options.defaultFilters,
					...scopeMode,
					label: condition,
					aliasState: expressionAliases,
				},
			);
			throw new Error(
				`${condition} condition kind '${String((value as { kind?: unknown }).kind)}' is not supported.`,
			);
		}
		if (!value || typeof value !== 'object' || isParamIntent(value)) return;
		if (inspected.has(value)) return;
		inspected.add(value);
		if (Array.isArray(value)) {
			value.forEach((child, index) => {
				inspect(
					child,
					`${intentPath}[${index}]`,
					condition,
					inHaving,
					underHaving,
				);
			});
			inspected.delete(value);
			return;
		}
		const node = value as Record<string, unknown>;
		if (node.kind === 'literal' || node.kind === 'param') return;
		if (
			node.kind === 'pseudoColumn' &&
			getDefaultFilter(options.defaultFilters, rootRange.table)
		)
			throw new Error(
				`Default filter for table '${rootRange.table}' is not supported at expression.pseudoColumn.`,
			);
		// With a model, every body is a nested select, except one on a visible
		// query-local source, which keeps the adapter's route with its subtree.
		if (node.kind === 'subquery' && node.query) {
			const query = node.query as QueryIntent;
			if (!model) return;
			if (
				classifyScalarBody(
					query,
					model,
					options.defaultFilters,
					options.isLocalSource,
				) === 'local'
			) {
				// Below a nested select, the adapter's route for a local body does
				// not see the names written in enclosing scopes: a qualified
				// outerRef() there is not realised yet.
				if (nested && holdsQualifiedOuterRef(query))
					throw new NotYetSupportedError(
						'a qualified outerRef()',
						'local-source subquery body',
						1040,
					);
				// The adapter's reduced route compiles this body: what it cannot resolve
				// from an origin stays refused (#1040).
				refuseLocalOriginRefs(query, true);
				inspected.delete(value);
				return;
			}
			const resolved = resolveConditionContext(
				{ kind: 'expression', expr: { kind: 'subquery', query } },
				rootRange,
				visible,
				enclosing,
				allocator,
				model,
				0,
				[],
				{
					defaultFilters: options.defaultFilters,
					...scopeMode,
					...(callDepth > 0 && { inCallArgument: true }),
				},
			);
			if (
				resolved?.kind !== 'expression' ||
				resolved.expression.kind !== 'subquery' ||
				!('select' in resolved.expression)
			)
				throw new Error(`Missing nested select at ${intentPath}`);
			expressionSubqueries.push({
				intentPath,
				select: resolved.expression.select,
			});
			inspected.delete(value);
			return;
		}
		// With a model, a condition root resolves whole, unless it holds a body on a
		// query-local source: that root keeps the adapter's local route (#1040).
		const localRoot = condition !== undefined && root && holdsLocalBody(node);
		const relationSensitive =
			[
				'exists',
				'notExists',
				'relationFilter',
				'rawExists',
				'rawNotExists',
			].includes(String(node.kind)) ||
			(node.kind === 'subquery' && node.subquery) ||
			(node.kind === 'in' && node.subquery) ||
			dottedField(node);
		if (
			condition &&
			((relationSensitive && model) ||
				(model !== undefined && root && !localRoot) ||
				(inHaving && namesAlias(node)) ||
				// In a body, every condition correlated by outerRef() (HAVING,
				// CASE WHEN, FILTER, in any clause) is bound by core, the one
				// resolver that holds the enclosing scopes and their written names.
				(nested !== undefined && holdsOuterRef(node)) ||
				invisibleQualifier(node, inHaving))
		) {
			const resolved = resolveConditionContext(
				node as unknown as WhereIntent,
				rootRange,
				visible,
				enclosing,
				allocator,
				model,
				expressionAliases.count,
				[],
				{
					defaultFilters: options.defaultFilters,
					...scopeMode,
					label: condition,
					aliasState: expressionAliases,
					...((callDepth > 0 || condition === 'FILTER') && {
						inCallArgument: true,
					}),
					...(inHaving && { havingAliases }),
					...(underHaving && { fromHaving: true }),
				},
			);
			if (!resolved)
				throw new Error(`Missing resolved condition at ${intentPath}`);
			expressionConditions.push({ intentPath, condition: resolved });
			inspected.delete(value);
			return;
		}
		// Not resolved by another trigger: the root keeps the local route, recorded
		// once, so localConditions and expressionConditions stay disjoint.
		if (localRoot) {
			refuseLocalOriginRefs(node, false);
			localConditions.push({ intentPath });
		}
		// A body left unresolved (no model) stays the adapter's: HAVING's aliases and
		// the outer ranges do not reach into it.
		if (absorbsBody(node)) {
			inspected.delete(value);
			return;
		}
		// A typed function's arguments are not resolved from an origin (#1116,
		// #1014): a ref that would be is refused.
		if (
			node.kind === 'function' &&
			containsOriginRefs(node.args, nested !== undefined)
		)
			refuseTypedFunctionOriginRef();
		const isCall =
			node.kind === 'customFn' ||
			node.kind === 'aggregate' ||
			node.kind === 'function' ||
			(node.kind === undefined && typeof node.function === 'string');
		if (isCall) callDepth++;
		for (const [key, child] of Object.entries(node)) {
			if (isBoundPayload(node, key, child)) continue;
			// A CASE WHEN root is the condition of a CASE branch.
			if (node.kind === 'case' && key === 'when' && Array.isArray(child)) {
				child.forEach((branch, index) => {
					if (!branch || typeof branch !== 'object') return;
					for (const [bkey, bchild] of Object.entries(branch)) {
						inspect(
							bchild,
							`${intentPath}.when[${index}].${bkey}`,
							bkey === 'condition' ? 'CASE WHEN' : condition,
							inHaving,
							underHaving,
							bkey === 'condition',
						);
					}
				});
				continue;
			}
			// A FILTER root is the filter of a function or aggregate call; HAVING's
			// aliases are not visible there.
			const filterRoot =
				key === 'filter' &&
				(node.kind === 'customFn' ||
					node.kind === 'aggregate' ||
					(node.kind === undefined && typeof node.function === 'string'));
			inspect(
				child,
				`${intentPath}.${key}`,
				filterRoot ? 'FILTER' : condition,
				inHaving && !filterRoot,
				underHaving,
				filterRoot,
			);
		}
		if (isCall) callDepth--;
		inspected.delete(value);
	};
	inspect(executable.select, 'select');
	inspect(executable.orderBy, 'orderBy');
	inspect(executable.having, 'having', 'HAVING', true, true, true);
	return {
		execution: {
			rootRange,
			joins,
			includes,
			...(where && { where }),
			...(expressionSubqueries.length && { expressionSubqueries }),
			...(expressionConditions.length && { expressionConditions }),
			...(localConditions.length && { localConditions }),
			...(model !== undefined && { rootsResolved: true as const }),
		},
		intent: executable,
	};
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
