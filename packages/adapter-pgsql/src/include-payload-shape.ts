import type { IncludePayloadShape, ModelIR, PlanReport } from '@dbsp/types';
import { resolveOutputReadHandling } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import type { AdapterCompilerDeps } from './adapter-compiler-deps.js';
import { chosenRelationColumnAlias } from './handlers/include/json-agg.js';
import {
	jsonAggContainerShape,
	resolveJsonAggColumnReadHandling,
} from './json-agg-read-handling.js';
import type { PlanDecision } from './plan-decision.js';
import {
	assertProjectedJsonContainerCanBeAggregated,
	requireRelationTargetColumn,
	resolveRelationTarget,
} from './relation-target-projection.js';
import {
	identifierText,
	queryLocal,
	resolveDeclaredIdentifier,
} from './sql-identifier.js';
import { stableJson } from './transition/stable-json.js';

/** One ownership check for each public object; identical requests collapse. */
export function claimPayloadKey(
	owners: Map<string, string>,
	path: string,
	key: string,
	owner: string,
): boolean {
	const previous = owners.get(key);
	if (previous !== undefined && previous !== owner)
		throw new Error(
			`Include payload '${path}' has conflicting public key '${key}' (${previous} and ${owner}).`,
		);
	owners.set(key, owner);
	return previous === undefined;
}

/** Runs after injection, before SQL. SQL handlers and hydration consume the same objects. */
export function resolveIncludePayloadShapes(
	decisions: readonly PlanDecision[],
	plan: PlanReport,
	model: ModelIR | undefined,
	deps: AdapterCompilerDeps,
): readonly IncludePayloadShape[] {
	const flatPaths = new Set<string>();
	const requestedPathsByLeaf = new Map<string, string[]>();
	const collectFlatPaths = (
		includes: readonly import('@dbsp/types').IncludeIntent[],
		parent = '',
		parentFlat = false,
	): void => {
		for (const include of includes) {
			const path = parent ? `${parent}.${include.relation}` : include.relation;
			const leaf = include.relation.split('.').at(-1) ?? include.relation;
			const requests = requestedPathsByLeaf.get(leaf) ?? [];
			requests.push(path);
			requestedPathsByLeaf.set(leaf, requests);
			const flat = parentFlat || include.strategy === 'flat';
			if (flat) flatPaths.add(path);
			collectFlatPaths(include.include ?? [], path, flat);
		}
	};
	collectFlatPaths(plan.intent?.include ?? []);
	const all: PlanDecision[] = [];
	const visit = (items: readonly PlanDecision[]): void => {
		for (const d of items) {
			if (
				d.type === 'includeStrategy' &&
				['json_agg', 'join', 'lateral'].includes(d.choice ?? '')
			)
				all.push(d);
			visit(d.children ?? []);
		}
	};
	visit(decisions);
	// Refuse unsupported nested select forms before resolving any wildcard payload.
	// Otherwise an opaque parent masks the child strategy's established refusal.
	for (const d of all) {
		if (
			d.choice === 'json_agg' &&
			d.includeSelectForm !== undefined &&
			d.includeSelectForm !== 'fields' &&
			d.includeSelectForm !== 'all'
		) {
			throw new Error(
				`JSON_AGG include '${d.relationPath ?? d.relationName ?? d.relation}' does not support select form '${d.includeSelectForm}'`,
			);
		}
	}
	for (const d of all) {
		const name = d.relationName ?? d.relation;
		const candidates = name ? requestedPathsByLeaf.get(name) : undefined;
		if (
			!d.intentPath &&
			name &&
			(d.relationPath === undefined || d.relationPath === name) &&
			candidates?.length === 1
		)
			(d as Mutable<PlanDecision>).relationPath = candidates[0]!;
	}
	const byPath = new Map<string, PlanDecision>();
	for (const d of all) {
		const path = d.relationPath ?? d.relationName ?? d.relation ?? '';
		const previous = byPath.get(path);
		if (
			previous &&
			(previous.targetTable !== d.targetTable || previous.choice !== d.choice)
		)
			throw new Error(
				`Include payload '${path}' has conflicting relation owners.`,
			);
		if (previous) {
			const requests = (decision: PlanDecision) =>
				decision.payloadColumnRequests ??
				(decision.columns ?? (decision.emptyProjection ? [] : ['*'])).map(
					(col) => ({
						col,
						alias: decision.columnAliases?.[col],
						defaultLabel: decision.defaultRelationColumnLabels?.[col],
					}),
				);
			byPath.set(path, {
				...previous,
				emptyProjection:
					previous.emptyProjection === true && d.emptyProjection === true,
				columns: [
					...new Set([
						...(previous.columns ?? (previous.emptyProjection ? [] : ['*'])),
						...(d.columns ?? (d.emptyProjection ? [] : ['*'])),
					]),
				],
				payloadColumnRequests: [...requests(previous), ...requests(d)],
			});
		} else byPath.set(path, d);
	}
	const select = plan.intent?.select;
	const rootColumns = () => {
		const table = model?.getTable(plan.rootTable);
		if (table) return table.columns.map((column) => column.name);
		const target = resolveRelationTarget(queryLocal(plan.rootTable), deps);
		if (target.outputs)
			return [...target.outputs.values()].map(
				(column) => column.logicalKey ?? identifierText(column.outputKey),
			);
		if (byPath.size > 0)
			throw new Error(
				`Include payload '${byPath.keys().next().value!}' cannot establish root wildcard ownership for '${plan.rootTable}' without a compile model.`,
			);
		return [];
	};
	const resolved = new Map<string, IncludePayloadShape>();
	const resolvePayload = (d: PlanDecision): IncludePayloadShape => {
		const path = d.relationPath ?? d.relationName ?? d.relation ?? '';
		const existing = resolved.get(path);
		if (existing) {
			(d as Mutable<PlanDecision>).payloadShape = existing;
			return existing;
		}
		const tableName = d.targetTable ?? d.relationName ?? d.relation ?? '';
		const target = resolveRelationTarget(queryLocal(tableName), deps);
		const table = model?.getTable(tableName);
		const strategy = d.choice as IncludePayloadShape['strategy'];
		let requested = d.columns;
		if (d.emptyProjection) requested = [];
		else if (
			!requested ||
			(requested.length === 0 && strategy !== 'join') ||
			requested.includes('*')
		) {
			requested =
				target.outputs !== undefined
					? [...target.outputs.keys()]
					: table?.columns.map((c) => c.name);
			if (!requested)
				throw new Error(
					`Include payload '${path}' cannot enumerate wildcard keys for opaque target '${tableName}'.`,
				);
		}
		const owners = new Map<string, string>();
		const columns: IncludePayloadShape['columns'][number][] = [];
		const requests =
			d.payloadColumnRequests ??
			requested.map((logicalName) => ({
				col: logicalName,
				alias: d.columnAliases?.[logicalName],
				defaultLabel: d.defaultRelationColumnLabels?.[logicalName],
			}));
		const entries = requests.flatMap<
			NonNullable<PlanDecision['payloadColumnRequests']>[number]
		>((entry) =>
			entry.col === '*' ? requested.map((col) => ({ col })) : [entry],
		);
		for (const entry of entries) {
			const logicalName = entry.col;
			const descriptor = requireRelationTargetColumn(
				target,
				queryLocal(logicalName),
				'selected column',
				path,
			);
			const declared = table?.columns.find((c) => c.name === logicalName);
			if (
				!model &&
				(!descriptor ||
					descriptor.source.kind === 'unresolved' ||
					descriptor.source.kind === 'ambiguous')
			)
				throw new Error(
					`Include payload '${path}' cannot establish read conversions for column '${logicalName}' without a compile model.`,
				);
			const physicalName = descriptor
				? identifierText(descriptor.outputKey)
				: identifierText(
						resolveDeclaredIdentifier(
							deps.declaredNames,
							deps.dbCasing ?? 'preserve',
							{ kind: 'column', table: tableName, column: logicalName },
						),
					);
			const publicName =
				descriptor?.logicalKey ??
				(descriptor?.source.kind === 'modelColumn'
					? descriptor.source.column
					: logicalName);
			const flatColumn =
				strategy !== 'json_agg' &&
				(flatPaths.has(path) || entry.nqlLabel === true);
			const publicKey = flatColumn
				? (entry.alias ?? publicName)
				: (chosenRelationColumnAlias(entry.alias, entry.defaultLabel) ??
					publicName);
			if (!claimPayloadKey(owners, path, publicKey, `column:${logicalName}`))
				continue;
			const containerShape = jsonAggContainerShape(d.relationType);
			if (descriptor && strategy === 'json_agg')
				assertProjectedJsonContainerCanBeAggregated(target, descriptor);
			const handling = descriptor
				? resolveOutputReadHandling({ ...descriptor, shape: containerShape })
				: declared
					? resolveJsonAggColumnReadHandling(
							tableName,
							declared,
							containerShape,
						)
					: undefined;
			const readHandling =
				handling?.kind === 'nestedTransform'
					? { ...handling, outputKey: publicKey }
					: undefined;
			columns.push({
				logicalName,
				physicalName,
				publicKey,
				outputLabel:
					strategy === 'json_agg'
						? publicKey
						: flatColumn
							? (entry.alias ?? `${path}.${publicKey}`)
							: `${path}.${publicKey}`,
				...(readHandling && { readHandling }),
			});
		}
		const children: IncludePayloadShape[] = [];
		for (const [childPath, child] of byPath) {
			if (
				childPath.slice(0, childPath.lastIndexOf('.')) !== path ||
				!childPath.includes('.')
			)
				continue;
			const shape = resolvePayload(child);
			if (
				claimPayloadKey(
					owners,
					path,
					shape.publicKey,
					`relation:${child.targetTable}:${childPath}`,
				)
			)
				children.push(shape);
		}
		const publicKey = path.split('.').at(-1) ?? path;
		const shape: IncludePayloadShape = {
			path,
			publicKey,
			strategy,
			table: tableName,
			isToOne: d.relationType === 'belongsTo' || d.relationType === 'hasOne',
			outputLabel: `${d.relationName ?? d.relation ?? publicKey}_json`,
			columns,
			children,
		};
		resolved.set(path, shape);
		(d as Mutable<PlanDecision>).payloadShape = shape;
		return shape;
	};
	const roots = [...byPath]
		.filter(([path]) => !path.includes('.'))
		.map(([, d]) => resolvePayload(d));
	for (const d of all) resolvePayload(d);
	const owners = new Map<string, string>();
	if (plan.intent?.existsWrap) return roots;

	if (!select || select.type === 'all')
		for (const column of rootColumns())
			claimPayloadKey(owners, '$', column, `column:${column}`);
	else if (select.type === 'fields' || select.type === 'aggregate') {
		for (const field of select.fields ?? [])
			for (const key of field === '*' ? rootColumns() : [field])
				claimPayloadKey(owners, '$', key, `column:${key}`);
		if (select.type === 'aggregate')
			for (const aggregate of select.aggregates)
				claimPayloadKey(
					owners,
					'$',
					aggregate.as ?? aggregate.function,
					`aggregate:${stableJson(aggregate)}`,
				);
	} else if (select.type === 'expressions' && Array.isArray(select.columns))
		for (const expr of select.columns) {
			if (expr.kind === 'relationColumn' && byPath.has(expr.relation)) continue;
			const key =
				'as' in expr && expr.as
					? expr.as
					: expr.kind === 'column'
						? expr.column
						: expr.kind === 'columnAlias'
							? expr.alias
							: undefined;
			if (key === '*') {
				for (const column of rootColumns())
					claimPayloadKey(owners, '$', column, `column:${column}`);
			} else if (key)
				claimPayloadKey(
					owners,
					'$',
					key,
					expr.kind === 'column' || expr.kind === 'columnAlias'
						? `column:${expr.column}`
						: `expression:${stableJson(expr)}`,
				);
		}
	for (const shape of roots.filter(
		(shape) =>
			shape.strategy !== 'join' ||
			shape.columns.length > 0 ||
			shape.children.length > 0,
	)) {
		claimPayloadKey(owners, '$', shape.publicKey, `relation:${shape.path}`);
		const claimLabels = (payload: IncludePayloadShape): void => {
			if (payload.strategy === 'json_agg')
				claimPayloadKey(
					owners,
					'$',
					payload.outputLabel,
					`generated:${payload.path}`,
				);
			else {
				for (const column of payload.columns)
					claimPayloadKey(
						owners,
						'$',
						column.outputLabel,
						`generated:${payload.path}:${column.logicalName}`,
					);
				for (const child of payload.children) claimLabels(child);
			}
		};
		claimLabels(shape);
	}
	// Empty join payloads still certify that compilation resolved the include.
	return roots;
}
