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
};

export type RelationTargetProjectionContext = {
	readonly naming: NamingPlugin;
	readonly model?: ModelIR | undefined;
	readonly bindingNames?: BindingNameRegistry | undefined;
	readonly relationTargetProjections?:
		| RelationTargetProjectionRegistry
		| undefined;
};

export function requestedColumnReference(
	requestedName: string,
	ctx: RelationTargetProjectionContext,
): ResolvedColumnReference {
	return { requestedName, emittedName: ctx.naming.toDatabase(requestedName) };
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
	ctx: RelationTargetProjectionContext,
): AliasColumnAuthority {
	const next = new Map(authorities);
	next.set(ctx.naming.toDatabase(alias), target);
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
		return { target, cteName, outputs: envelope.projection.outputs };
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
	const dbColumn = ctx.naming.toDatabase(column);
	return requireEmittedRelationTargetColumn(
		target,
		emittedColumnReference(dbColumn),
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
