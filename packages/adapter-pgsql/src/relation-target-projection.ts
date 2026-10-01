/**
 * Resolves the columns available through a relation target.  A query-local
 * binding shadows a physical relation, so its (when known) projection is the
 * authority for every column emitted against that target.
 */
import type { ModelIR, OutputDescriptor } from '@dbsp/types';
import {
	type BindingNameRegistry,
	emittedBindName,
	hasBindingName,
} from './binding-registry.js';
import type { NamingPlugin } from './naming-plugin.js';
import type { ProjectionEnvelope } from './projection-envelope.js';

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
	readonly cteName?: string;
	readonly outputs?: ReadonlyMap<string, OutputDescriptor>;
	/** Built once when the authority is bound; no reference path scans outputs. */
	readonly outputsByLogicalKey?: ReadonlyMap<string, OutputDescriptor>;
};

export type RelationTargetProjectionContext = {
	readonly naming: NamingPlugin;
	readonly model?: ModelIR | undefined;
	readonly bindingNames?: BindingNameRegistry | undefined;
	readonly relationTargetProjections?:
		| RelationTargetProjectionRegistry
		| undefined;
};

function withLogicalOutputAuthority(
	target: ResolvedRelationTarget,
): ResolvedRelationTarget {
	if (
		target.outputs === undefined ||
		target.outputsByLogicalKey !== undefined
	) {
		return target;
	}
	const outputsByLogicalKey = new Map<string, OutputDescriptor>();
	for (const output of target.outputs.values()) {
		if (typeof output.logicalKey === 'string') {
			outputsByLogicalKey.set(output.logicalKey, output);
		}
	}
	return { ...target, outputsByLogicalKey };
}

export function requestedColumnReference(
	requestedName: string,
): ResolvedColumnReference {
	// This helper is only reached after the caller has established a relation
	// authority.  Its columns are query-local projection outputs and therefore
	// retain their exact emitted spelling.
	return { requestedName, emittedName: requestedName };
}

/** Projection keys have already crossed the naming boundary. */
export function emittedColumnReference(
	emittedName: string,
): ResolvedColumnReference {
	return { requestedName: emittedName, emittedName };
}

export function bindAliasAuthority(
	authorities: AliasColumnAuthority | undefined,
	alias: string,
	target: ResolvedRelationTarget,
	_ctx: RelationTargetProjectionContext,
): AliasColumnAuthority {
	const next = new Map(authorities);
	// Aliases are query-local identifiers.  Do not re-case an authority key or
	// a later reference can no longer address the alias that was emitted.
	next.set(alias, withLogicalOutputAuthority(target));
	return next;
}

/** The sole resolver for relation-target column authority. */
export function resolveRelationTarget(
	target: string,
	ctx: RelationTargetProjectionContext,
): ResolvedRelationTarget {
	if (!hasBindingName(ctx.bindingNames, target, ctx.naming)) {
		return { target };
	}
	const cteName = emittedBindName(target, ctx.naming);
	const envelope = ctx.relationTargetProjections?.get(cteName);
	if (
		envelope?.projection.kind === 'known' &&
		envelope.projection.outputs.size > 0
	) {
		return withLogicalOutputAuthority({
			target,
			cteName,
			outputs: envelope.projection.outputs,
		});
	}
	// A raw/positional projection deliberately remains unknown: retain the
	// historical physical-table SQL behaviour and do not validate it.
	return { target, cteName };
}

export function requireRelationTargetColumn(
	target: ResolvedRelationTarget,
	column: string,
	ctx: RelationTargetProjectionContext,
	purpose: string,
	relationName?: string,
): OutputDescriptor | undefined {
	if (target.outputs === undefined) return undefined;
	if (target.outputs.has(column)) {
		return requireEmittedRelationTargetColumn(
			target,
			emittedColumnReference(column),
			purpose,
			relationName,
		);
	}
	const logicalOutput = target.outputsByLogicalKey?.get(column);
	if (logicalOutput !== undefined) {
		return requireEmittedRelationTargetColumn(
			target,
			emittedColumnReference(logicalOutput.outputKey),
			purpose,
			relationName,
		);
	}
	return requireEmittedRelationTargetColumn(
		target,
		emittedColumnReference(ctx.naming.resolve(column)),
		purpose,
		relationName,
	);
}

/** Validate one already-emitted reference against its alias authority. */
export function requireEmittedRelationTargetColumn(
	target: ResolvedRelationTarget,
	column: ResolvedColumnReference,
	purpose: string,
	relationName?: string,
): OutputDescriptor | undefined {
	if (target.outputs === undefined) return undefined;
	const dbColumn = column.emittedName;
	const descriptor = target.outputs.get(dbColumn);
	if (descriptor !== undefined) {
		if (descriptor.source.kind === 'ambiguous') {
			throw new Error(
				`${relationName ? `Relation '${relationName}' ` : ''}target '${target.target}' resolves to the CTE '${target.cteName}', ` +
					`whose projected column '${dbColumn}' is ambiguous and cannot be referenced (${purpose}).`,
			);
		}
		return descriptor;
	}
	const relation = relationName ? `Relation '${relationName}' ` : '';
	throw new Error(
		`${relation}target '${target.target}' resolves to the CTE '${target.cteName}', ` +
			`which does not project '${dbColumn}' (${purpose}). Available: ${[...target.outputs.keys()].join(', ')}`,
	);
}

export function requireRelationTargetColumns(
	target: ResolvedRelationTarget,
	columns: readonly string[],
	ctx: RelationTargetProjectionContext,
	purpose: string,
	relationName?: string,
): void {
	for (const column of columns) {
		requireRelationTargetColumn(target, column, ctx, purpose, relationName);
	}
}

/**
 * A projected JSON array/object has one leaf provenance descriptor today.
 * Carrying it through another JSON aggregate would turn the container itself
 * into a scalar transform (and can cast the whole container to text).  Until
 * nested provenance graphs exist, reject that lossy composition.
 */
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
			`Nested JSON conversion cannot be carried through a projected CTE: target '${target.target}', output '${descriptor.outputKey}'.`,
		);
	}
}
