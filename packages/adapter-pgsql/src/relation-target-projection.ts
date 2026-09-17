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
	const dbColumn = ctx.naming.toDatabase(column);
	const descriptor = target.outputs.get(dbColumn);
	if (descriptor !== undefined) return descriptor;
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
