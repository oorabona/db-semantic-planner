/**
 * @dbsp/types/internal - Internal type definitions
 *
 * These types are for internal use by @dbsp package implementations.
 * They are NOT part of the public API and may change without notice.
 *
 * @module @dbsp/types/internal
 * @internal
 */

import { toColumnList } from './column-list.js';
import type { NqlBindingRelationType } from './model-ir.js';

// Internal-only build utilities (NOT part of public API)
export type { IntentBuilder, Mutable } from './builders.js';

/** @internal Minimal relation shape needed to validate NQL binding include hops. */
export interface NqlBindingIncludeRelationShape {
	readonly type?: NqlBindingRelationType | undefined;
	readonly foreignKey?: string | readonly string[] | undefined;
	readonly source?: string | undefined;
	readonly target?: string | undefined;
	readonly through?: unknown;
	readonly otherKey?: unknown;
	readonly throughSourceKey?: unknown;
	readonly throughTargetKey?: unknown;
	readonly recursive?: unknown;
}

/** @internal Minimal include-node shape needed to validate NQL binding include hops. */
export interface NqlBindingIncludeNodeShape {
	readonly relation?: unknown;
	readonly include?: readonly NqlBindingIncludeNodeShape[] | undefined;
	readonly [key: string]: unknown;
}

/** @internal */
export function explainUnsupportedNqlBindingIncludeHop(
	relationName: string,
	relation: NqlBindingIncludeRelationShape,
	include?: NqlBindingIncludeNodeShape,
): string | undefined {
	const includeReason = include
		? explainUnsupportedNqlBindingIncludeNode(relationName, include)
		: undefined;
	if (includeReason) return includeReason;
	if (
		relation.type === 'belongsToMany' ||
		relation.type === 'manyToMany' ||
		relation.through !== undefined ||
		relation.otherKey !== undefined ||
		relation.throughSourceKey !== undefined ||
		relation.throughTargetKey !== undefined
	) {
		return `relation '${relationName}' is '${relation.type ?? 'through'}' and needs junction traversal; binding includes for many-to-many/through relations are not supported (ref-#192)`;
	}
	if (
		relation.type !== 'belongsTo' &&
		relation.type !== 'hasOne' &&
		relation.type !== 'hasMany'
	) {
		return `relation '${relationName}' is '${relation.type ?? 'unknown'}'; binding includes require a belongsTo/hasOne/hasMany relation (ref-#192)`;
	}
	const fkColumns = toColumnList(relation.foreignKey);
	if (fkColumns.length === 0 || fkColumns.some((col) => col.length === 0)) {
		return `relation '${relationName}' must have at least one non-empty FK column for binding includes (ref-#179)`;
	}
	if (
		relation.recursive !== undefined ||
		(relation.source !== undefined &&
			relation.target !== undefined &&
			relation.source === relation.target)
	) {
		return `relation '${relationName}' is recursive/self-referential; binding includes for recursive relations require recursive CTE handling and are not supported (ref-#193)`;
	}
	return undefined;
}

const NQL_BINDING_INCLUDE_NODE_KEYS: ReadonlySet<string> = new Set([
	'relation',
	'include',
]);

function explainUnsupportedNqlBindingIncludeNode(
	relationName: string,
	include: NqlBindingIncludeNodeShape,
): string | undefined {
	const keys = Object.keys(include);
	const unsupportedKeys = keys.filter(
		(key) => !NQL_BINDING_INCLUDE_NODE_KEYS.has(key),
	);
	if (unsupportedKeys.length > 0) {
		const options = unsupportedKeys.map((key) => `'${key}'`).join(', ');
		return `relation '${relationName}' include node carries unsupported option${unsupportedKeys.length === 1 ? '' : 's'} ${options}; binding includes only allow 'relation' and nested 'include' (ref-#192)`;
	}
	if (typeof include.relation !== 'string' || include.relation.length === 0) {
		return `relation '${relationName}' include node must name a relation (ref-#192)`;
	}
	if (include.include !== undefined && !Array.isArray(include.include)) {
		return `relation '${relationName}' nested include must be an array (ref-#192)`;
	}
	return undefined;
}

/**
 * @internal Shared compiler-options marker for trusted NQL package internals.
 *
 * Deliberately uses Symbol(), not Symbol.for(), so knowing the description does
 * not let callers forge the marker through the global symbol registry.
 */
export const NQL_INTERNAL_COMPILER_OPTIONS: unique symbol = Symbol(
	'@dbsp/nql/internalCompilerOptions',
);

const NQL_BINDING_REF = Symbol('@dbsp/nql/bindingRef');
const NQL_TRUSTED_RELATION_FILTER = Symbol('@dbsp/nql/trustedRelationFilter');

/**
 * @internal Opaque marker for NQL compiler-created binding references.
 *
 * The brand is a module-private Symbol(), so JSON/plain object inputs cannot
 * forge it by shape.
 */
export interface NqlBindingRef {
	readonly name: string;
	readonly [NQL_BINDING_REF]: true;
}

/** @internal */
export function createNqlBindingRef(name: string): NqlBindingRef {
	const ref = { name } as { name: string; [NQL_BINDING_REF]?: true };
	Object.defineProperty(ref, NQL_BINDING_REF, {
		value: true,
		enumerable: false,
	});
	return ref as NqlBindingRef;
}

/** @internal */
export function isNqlBindingRef(value: unknown): value is NqlBindingRef {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly name?: unknown;
		readonly [NQL_BINDING_REF]?: unknown;
	};
	return (
		Object.hasOwn(record, NQL_BINDING_REF) &&
		record[NQL_BINDING_REF] === true &&
		typeof record.name === 'string'
	);
}

/** @internal */
export function getNqlBindingRefName(ref: NqlBindingRef): string {
	return ref.name;
}

/** @internal */
export type NqlTrustedRelationFilterRelation = string | readonly string[];

/** @internal */
export interface NqlTrustedRelationFilterHop {
	readonly target: string;
	readonly fkColumn: readonly string[];
	readonly joinColumn: readonly string[];
}

/** @internal */
export interface NqlTrustedRelationFilterRecursive {
	readonly direction: 'up' | 'down';
	readonly maxDepth: number;
	readonly selfRefColumn: string;
	readonly targetKeyColumn: string;
}

/** @internal */
export interface NqlTrustedRelationFilterFields {
	readonly relation: NqlTrustedRelationFilterRelation;
	readonly targetTable: string;
	readonly sourceColumn: readonly string[];
	readonly targetColumn: readonly string[];
	readonly hops: readonly NqlTrustedRelationFilterHop[];
	readonly through?: string;
	readonly throughSourceColumn?: string;
	readonly throughTargetColumn?: string;
	readonly selectedColumn?: string;
	readonly cardinality?: 'one' | 'many';
	readonly relationType?: NqlBindingRelationType;
	readonly recursive?: NqlTrustedRelationFilterRecursive;
}

/**
 * @internal Opaque proof for NQL compiler-proven relation filter metadata.
 *
 * The module-private Symbol stores the frozen proven payload. Public
 * targetTable/sourceColumn/targetColumn/relation fields are display metadata only;
 * consumers must read the payload through getTrustedNqlRelationFilterFields().
 */
export interface NqlTrustedRelationFilterProof {
	readonly [NQL_TRUSTED_RELATION_FILTER]: NqlTrustedRelationFilterFields;
}

function isStringArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === 'string' && item.length > 0)
	);
}

function isRelationType(value: unknown): value is NqlBindingRelationType {
	return (
		value === 'hasOne' ||
		value === 'hasMany' ||
		value === 'belongsTo' ||
		value === 'belongsToMany' ||
		value === 'manyToMany'
	);
}

function isTrustedRelationFilterHop(
	value: unknown,
): value is NqlTrustedRelationFilterHop {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly target?: unknown;
		readonly fkColumn?: unknown;
		readonly joinColumn?: unknown;
	};
	return (
		typeof record.target === 'string' &&
		record.target.length > 0 &&
		isStringArray(record.fkColumn) &&
		isStringArray(record.joinColumn) &&
		record.fkColumn.length === record.joinColumn.length
	);
}

function isTrustedRelationFilterRecursive(
	value: unknown,
): value is NqlTrustedRelationFilterRecursive {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly direction?: unknown;
		readonly maxDepth?: unknown;
		readonly selfRefColumn?: unknown;
		readonly targetKeyColumn?: unknown;
	};
	return (
		(record.direction === 'up' || record.direction === 'down') &&
		typeof record.maxDepth === 'number' &&
		Number.isSafeInteger(record.maxDepth) &&
		record.maxDepth > 0 &&
		typeof record.selfRefColumn === 'string' &&
		record.selfRefColumn.length > 0 &&
		typeof record.targetKeyColumn === 'string' &&
		record.targetKeyColumn.length > 0
	);
}

function relationHasMultipleHops(
	relation: NqlTrustedRelationFilterRelation,
): boolean {
	if (typeof relation !== 'string') return relation.length > 1;
	return relation.split('.').length > 1;
}

function isTrustedRelationFilterPayload(
	value: unknown,
): value is NqlTrustedRelationFilterFields {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly relation?: unknown;
		readonly targetTable?: unknown;
		readonly sourceColumn?: unknown;
		readonly targetColumn?: unknown;
		readonly hops?: unknown;
		readonly through?: unknown;
		readonly throughSourceColumn?: unknown;
		readonly throughTargetColumn?: unknown;
		readonly selectedColumn?: unknown;
		readonly cardinality?: unknown;
		readonly relationType?: unknown;
		readonly recursive?: unknown;
	};
	return (
		(typeof record.relation === 'string' || isStringArray(record.relation)) &&
		typeof record.targetTable === 'string' &&
		isStringArray(record.sourceColumn) &&
		isStringArray(record.targetColumn) &&
		record.sourceColumn.length === record.targetColumn.length &&
		Array.isArray(record.hops) &&
		record.hops.every(isTrustedRelationFilterHop) &&
		(record.through === undefined ||
			(typeof record.through === 'string' && record.through.length > 0)) &&
		(record.throughSourceColumn === undefined ||
			(typeof record.throughSourceColumn === 'string' &&
				record.throughSourceColumn.length > 0)) &&
		(record.throughTargetColumn === undefined ||
			(typeof record.throughTargetColumn === 'string' &&
				record.throughTargetColumn.length > 0)) &&
		(record.selectedColumn === undefined ||
			typeof record.selectedColumn === 'string') &&
		(record.cardinality === undefined ||
			record.cardinality === 'one' ||
			record.cardinality === 'many') &&
		(record.relationType === undefined ||
			isRelationType(record.relationType)) &&
		(record.recursive === undefined ||
			isTrustedRelationFilterRecursive(record.recursive)) &&
		!(
			record.selectedColumn !== undefined &&
			record.cardinality === 'one' &&
			relationHasMultipleHops(record.relation) &&
			record.hops.length === 0
		)
	);
}

function freezeTrustedRelationFilterPayload(
	fields: NqlTrustedRelationFilterFields,
): NqlTrustedRelationFilterFields {
	const relation = Array.isArray(fields.relation)
		? Object.freeze([...fields.relation])
		: fields.relation;
	const through = fields.through;
	const throughSourceColumn = fields.throughSourceColumn;
	const throughTargetColumn = fields.throughTargetColumn;
	const recursive =
		fields.recursive === undefined
			? undefined
			: Object.freeze({
					direction: fields.recursive.direction,
					maxDepth: fields.recursive.maxDepth,
					selfRefColumn: fields.recursive.selfRefColumn,
					targetKeyColumn: fields.recursive.targetKeyColumn,
				});
	const hops = Object.freeze(
		fields.hops.map((hop) =>
			Object.freeze({
				target: hop.target,
				fkColumn: Object.freeze([...hop.fkColumn]),
				joinColumn: Object.freeze([...hop.joinColumn]),
			}),
		),
	);
	return Object.freeze({
		relation,
		targetTable: fields.targetTable,
		sourceColumn: Object.freeze([...fields.sourceColumn]),
		targetColumn: Object.freeze([...fields.targetColumn]),
		hops,
		...(through !== undefined && {
			through,
		}),
		...(throughSourceColumn !== undefined && {
			throughSourceColumn,
		}),
		...(throughTargetColumn !== undefined && {
			throughTargetColumn,
		}),
		...(fields.selectedColumn !== undefined && {
			selectedColumn: fields.selectedColumn,
		}),
		...(fields.cardinality !== undefined && {
			cardinality: fields.cardinality,
		}),
		...(fields.relationType !== undefined && {
			relationType: fields.relationType,
		}),
		...(recursive !== undefined && {
			recursive,
		}),
	});
}

/** @internal */
export function markNqlTrustedRelationFilter<T extends object>(
	value: T,
	fields: NqlTrustedRelationFilterFields,
): T & NqlTrustedRelationFilterProof {
	Object.defineProperty(value, NQL_TRUSTED_RELATION_FILTER, {
		value: freezeTrustedRelationFilterPayload(fields),
		enumerable: false,
	});
	return value as T & NqlTrustedRelationFilterProof;
}

/** @internal */
export function hasNqlTrustedRelationFilterProof(
	value: unknown,
): value is NqlTrustedRelationFilterProof {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const record = value as {
		readonly [NQL_TRUSTED_RELATION_FILTER]?: unknown;
	};
	return (
		Object.hasOwn(record, NQL_TRUSTED_RELATION_FILTER) &&
		isTrustedRelationFilterPayload(record[NQL_TRUSTED_RELATION_FILTER])
	);
}

/** @internal */
export function getTrustedNqlRelationFilterFields(
	value: unknown,
): NqlTrustedRelationFilterFields | undefined {
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const record = value as {
		readonly [NQL_TRUSTED_RELATION_FILTER]?: unknown;
	};
	const payload = record[NQL_TRUSTED_RELATION_FILTER];
	return isTrustedRelationFilterPayload(payload) ? payload : undefined;
}

// Re-export all public types for convenience
export * from './index.js';
