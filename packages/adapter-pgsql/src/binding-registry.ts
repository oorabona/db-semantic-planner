/**
 * Query-local relation authority.
 *
 * A scope is built as relations enter a query. It deliberately contains the
 * emitted identifiers, rather than a transformation policy: aliases, CTEs and VALUES
 * ranges are local SQL vocabulary and must retain their spelling verbatim.
 */
import type { OutputDescriptor } from '@dbsp/types';
import { identifierText, type SqlIdentifier } from './sql-identifier.js';

export type RelationBindingKind =
	| 'declared-table'
	| 'cte-bind'
	| 'join-alias'
	| 'batch-values'
	| 'generated';

/** A local projected output, indexed both by emitted label and logical key. */
export type RelationBindingOutput = OutputDescriptor & {
	readonly outputKey: SqlIdentifier;
	readonly logicalKey: string;
};

export type RelationBinding = {
	/** The exact identifier emitted as the relation qualifier. */
	readonly qualifier: SqlIdentifier;
	readonly kind: RelationBindingKind;
	/** Present only for a declared physical relation. */
	readonly logicalTable?: string;
	/** Present for local relations whose output list is known. */
	readonly outputs?: ReadonlyMap<SqlIdentifier, RelationBindingOutput>;
	/** Built together with `outputs`; callers never scan outputs by logical key. */
	readonly outputsByLogicalKey?: ReadonlyMap<string, RelationBindingOutput>;
};

export type QueryScope = {
	readonly bindings: ReadonlyMap<string, RelationBinding>;
};

/**
 * The pre-lot-3 carrier remains only at compiler boundaries. It is converted
 * to a QueryScope there; converted lookup functions never accept it.
 */
export type BindingNameRegistry = ReadonlySet<string>;

function localOutputIndex(
	outputs: ReadonlyMap<SqlIdentifier, RelationBindingOutput> | undefined,
): ReadonlyMap<string, RelationBindingOutput> | undefined {
	if (outputs === undefined) return undefined;
	const byLogicalKey = new Map<string, RelationBindingOutput>();
	for (const output of outputs.values()) {
		const prior = byLogicalKey.get(output.logicalKey);
		if (prior !== undefined) {
			throw new Error(
				`Relation binding output '${output.logicalKey}' is ambiguous between '${identifierText(prior.outputKey)}' and '${identifierText(output.outputKey)}'.`,
			);
		}
		byLogicalKey.set(output.logicalKey, output);
	}
	return byLogicalKey;
}

/** Build one binding and its reverse local-output authority exactly once. */
export function relationBinding(binding: {
	readonly qualifier: SqlIdentifier;
	readonly kind: RelationBindingKind;
	readonly logicalTable?: string;
	readonly outputs?: ReadonlyMap<SqlIdentifier, RelationBindingOutput>;
}): RelationBinding {
	if (binding.kind === 'declared-table' && binding.logicalTable === undefined) {
		throw new Error(
			'A declared-table relation binding requires its logical table.',
		);
	}
	if (binding.kind !== 'declared-table' && binding.logicalTable !== undefined) {
		throw new Error(
			'Only a declared-table relation binding may carry a logical table.',
		);
	}
	if (binding.outputs === undefined) return { ...binding };
	return {
		...binding,
		outputsByLogicalKey: localOutputIndex(binding.outputs)!,
	};
}

/** Construct a scope from already-authoritative relation bindings. */
export function queryScope(
	bindings: readonly RelationBinding[] = [],
): QueryScope {
	const indexed = new Map<string, RelationBinding>();
	for (const binding of bindings) {
		const key = identifierText(binding.qualifier);
		if (indexed.has(key)) {
			throw new Error(`Query scope already binds qualifier '${key}'.`);
		}
		indexed.set(key, binding);
	}
	return { bindings: indexed };
}

/** Extend a scope with an already-authoritative relation binding. */
export function withRelationBinding(
	scope: QueryScope | undefined,
	binding: RelationBinding,
): QueryScope {
	return queryScope([
		...(scope === undefined ? [] : scope.bindings.values()),
		binding,
	]);
}

/** Look up the binding addressed by an emitted relation qualifier. */
export function relationBindingFor(
	scope: QueryScope | undefined,
	qualifier: SqlIdentifier,
): RelationBinding | undefined {
	return scope?.bindings.get(identifierText(qualifier));
}

/**
 * Find a declared relation by its logical address, while retaining the
 * qualifier the binding established for SQL emission.  This is needed when a
 * planner-level root table spelling differs from its physical range-variable
 * spelling (for example `userProfiles` -> `user_profiles`).
 */
export function declaredRelationBindingFor(
	scope: QueryScope | undefined,
	logicalTable: string,
): RelationBinding | undefined {
	for (const binding of scope?.bindings.values() ?? []) {
		if (
			binding.kind === 'declared-table' &&
			binding.logicalTable === logicalTable
		) {
			return binding;
		}
	}
	return undefined;
}

export function hasBindingName(
	scope: QueryScope | BindingNameRegistry | undefined,
	name: string,
): boolean {
	if (scope !== undefined && 'has' in scope) return scope.has(name);
	const binding = (scope as QueryScope | undefined)?.bindings.get(name);
	return binding?.kind === 'cte-bind';
}

export function schemaForFromName(
	schemaName: SqlIdentifier | undefined,
	fromName: string,
	scope: QueryScope | BindingNameRegistry | undefined,
): SqlIdentifier | undefined {
	return hasBindingName(scope, fromName) ? undefined : schemaName;
}

/** Boundary spelling for a CTE name; it remains verbatim. */
export function emittedBindName(name: SqlIdentifier): SqlIdentifier {
	return name;
}

/** Compatibility constructor for later lots which still carry a name registry. */
export function withBindingName(
	bindingNames: BindingNameRegistry | undefined,
	name: SqlIdentifier,
): BindingNameRegistry {
	return new Set([...(bindingNames ?? []), identifierText(name)]);
}
