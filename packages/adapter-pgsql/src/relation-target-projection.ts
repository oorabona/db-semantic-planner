/** Resolves columns through the relation bindings visible in a query scope. */
import type { ModelIR, OutputDescriptor } from '@dbsp/types';
import {
	type BindingNameRegistry,
	type QueryScope,
	queryScope,
	type RelationBindingOutput,
	relationBinding,
	relationBindingFor,
} from './binding-registry.js';
import type { ProjectionEnvelope } from './projection-envelope.js';
import {
	identifierText,
	queryLocal,
	type SqlIdentifier,
} from './sql-identifier.js';

/** Compatibility input accepted only while callers move to QueryScope. */
export type RelationTargetProjectionRegistry = ReadonlyMap<
	string,
	ProjectionEnvelope
>;

/** A query-scope binding from an emitted SQL alias to the relation it exposes. */
export type AliasColumnAuthority = ReadonlyMap<string, ResolvedRelationTarget>;

/** A column name after deciding whether it is logical input or emitted output. */
export type ResolvedColumnReference = {
	readonly requestedName: string;
	readonly emittedName: string;
};

export type ResolvedRelationTarget = {
	readonly target: string;
	readonly cteName?: SqlIdentifier;
	readonly logicalTable?: string;
	readonly outputs?: ReadonlyMap<string, RelationBindingOutput>;
	/** Built when the local binding enters the scope; no reference path scans outputs. */
	readonly outputsByLogicalKey?: ReadonlyMap<string, RelationBindingOutput>;
};

export type RelationTargetProjectionContext = {
	readonly scope?: QueryScope | undefined;
	readonly model?: ModelIR | undefined;
	/** @deprecated A direct caller must construct scope from its local bindings. */
	readonly bindingNames?: BindingNameRegistry | undefined;
	/** @deprecated A direct caller must construct scope from its local bindings. */
	readonly relationTargetProjections?:
		| RelationTargetProjectionRegistry
		| undefined;
};

function legacyScope(
	ctx: RelationTargetProjectionContext,
): QueryScope | undefined {
	if (ctx.scope !== undefined) return ctx.scope;
	return queryScopeForBindingProjections(
		ctx.bindingNames,
		ctx.relationTargetProjections,
	);
}

/**
 * Establish local relation authority at a legacy compiler boundary.
 *
 * The registry is deliberately converted here, before any resolver can see a
 * binding name.  A CTE/bind's output labels are query-local SQL identifiers;
 * neither their qualifier nor their output columns may be resolved as model
 * addresses.
 */
export function queryScopeForBindingProjections(
	bindingNames: BindingNameRegistry | undefined,
	relationTargetProjections?: RelationTargetProjectionRegistry,
): QueryScope | undefined {
	if (bindingNames === undefined) return undefined;
	return queryScope(
		[...bindingNames].map((name) => {
			const qualifier = queryLocal(name);
			const envelope = relationTargetProjections?.get(name);
			const outputs =
				envelope?.projection.kind === 'known' &&
				envelope.projection.outputs.size > 0
					? new Map<SqlIdentifier, RelationBindingOutput>(
							[...envelope.projection.outputs.values()].map((output) => [
								queryLocal(output.outputKey),
								{
									...output,
									outputKey: queryLocal(output.outputKey),
									logicalKey:
										(output as Partial<RelationBindingOutput>).logicalKey ??
										output.outputKey,
								},
							]),
						)
					: undefined;
			return relationBinding({
				qualifier,
				kind: 'cte-bind',
				...(outputs && { outputs }),
			});
		}),
	);
}

/** Projection keys have already crossed the query-local identifier boundary. */
export function requestedColumnReference(
	requestedName: SqlIdentifier | string,
): ResolvedColumnReference {
	return { requestedName, emittedName: requestedName };
}

export function emittedColumnReference(
	emittedName: SqlIdentifier | string,
): ResolvedColumnReference {
	return { requestedName: emittedName, emittedName };
}

export function bindAliasAuthority(
	authorities: AliasColumnAuthority | undefined,
	alias: SqlIdentifier | string,
	target: ResolvedRelationTarget,
	..._legacy: readonly unknown[]
): AliasColumnAuthority {
	const next = new Map(authorities);
	next.set(alias, target);
	return next;
}

/** The sole resolver for relation-target column authority. */
export function resolveRelationTarget(
	target: SqlIdentifier | string,
	ctx: RelationTargetProjectionContext,
): ResolvedRelationTarget {
	const identifier = typeof target === 'string' ? queryLocal(target) : target;
	const binding = relationBindingFor(legacyScope(ctx), identifier);
	if (binding === undefined) return { target: identifierText(identifier) };
	return {
		target: identifierText(identifier),
		...(binding.kind === 'cte-bind' && { cteName: binding.qualifier }),
		...(binding.logicalTable !== undefined && {
			logicalTable: binding.logicalTable,
		}),
		...(binding.outputs !== undefined && {
			outputs: new Map(
				[...binding.outputs].map(([label, output]) => [
					identifierText(label),
					output,
				]),
			),
		}),
		...(binding.outputsByLogicalKey !== undefined && {
			outputsByLogicalKey: binding.outputsByLogicalKey,
		}),
	};
}

export function requireRelationTargetColumn(
	target: ResolvedRelationTarget,
	column: SqlIdentifier | string,
	purposeOrContext: string | RelationTargetProjectionContext,
	purposeOrRelation?: string,
	relationName?: string,
): RelationBindingOutput | undefined {
	const purpose =
		typeof purposeOrContext === 'string'
			? purposeOrContext
			: purposeOrRelation!;
	const relation =
		typeof purposeOrContext === 'string' ? purposeOrRelation : relationName;
	const identifier = typeof column === 'string' ? queryLocal(column) : column;
	if (target.outputs === undefined) return undefined;
	const descriptor =
		target.outputs.get(identifierText(identifier)) ??
		target.outputsByLogicalKey?.get(identifierText(identifier));
	if (descriptor !== undefined) {
		if (descriptor.source.kind === 'ambiguous') {
			throw new Error(
				`${relation ? `Relation '${relation}' ` : ''}target '${identifierText(queryLocal(target.target))}' resolves to the CTE '${identifierText(target.cteName ?? queryLocal(target.target))}', whose projected column '${identifierText(identifier)}' is ambiguous and cannot be referenced (${purpose}).`,
			);
		}
		return descriptor;
	}
	const relationPrefix = relation ? `Relation '${relation}' ` : '';
	throw new Error(
		`${relationPrefix}target '${identifierText(queryLocal(target.target))}' resolves to the CTE '${identifierText(target.cteName ?? queryLocal(target.target))}', which does not project '${identifierText(identifier)}' (${purpose}). Available: ${[...target.outputs.keys()].join(', ')}`,
	);
}

export function requireRelationTargetColumns(
	target: ResolvedRelationTarget,
	columns: readonly (SqlIdentifier | string)[],
	purposeOrContext: string | RelationTargetProjectionContext,
	purposeOrRelation?: string,
	relationName?: string,
): void {
	for (const column of columns) {
		requireRelationTargetColumn(
			target,
			column,
			purposeOrContext,
			purposeOrRelation,
			relationName,
		);
	}
}

/** Compatibility form for callers which already resolved an emitted reference. */
export function requireEmittedRelationTargetColumn(
	target: ResolvedRelationTarget,
	column: ResolvedColumnReference,
	purpose: string,
	relationName?: string,
): RelationBindingOutput | undefined {
	return requireRelationTargetColumn(
		target,
		column.emittedName,
		purpose,
		relationName,
	);
}

export function assertProjectedJsonContainerCanBeAggregated(
	target: ResolvedRelationTarget,
	descriptor: OutputDescriptor,
): void {
	if (
		target.cteName !== undefined &&
		descriptor.source.kind === 'modelColumn' &&
		descriptor.source.js !== undefined &&
		(descriptor.shape.kind === 'array' || descriptor.shape.kind === 'object')
	) {
		throw new Error(
			`Nested JSON conversion cannot be carried through a projected CTE: target '${identifierText(queryLocal(target.target))}', output '${descriptor.outputKey}'.`,
		);
	}
}
