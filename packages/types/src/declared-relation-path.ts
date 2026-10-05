import { toColumnList } from './column-list.js';
import type { RelationIR } from './model-ir.js';

/** Minimal declared relation contract, also usable by compiler schema facades. */
export type DeclaredRelationPathRelation = Pick<RelationIR, 'name' | 'target'> &
	Partial<
		Pick<
			RelationIR,
			| 'source'
			| 'type'
			| 'foreignKey'
			| 'sourceKey'
			| 'targetKey'
			| 'through'
			| 'otherKey'
			| 'throughSourceKey'
			| 'throughTargetKey'
		>
	> & { readonly recursive?: unknown };

export interface DeclaredRelationPathModel<
	R extends DeclaredRelationPathRelation,
> {
	getTable?(name: string): unknown;
	getRelation?(qualifiedName: string): R | undefined;
	getRelationsFrom(sourceTable: string): readonly R[];
}

export interface DeclaredRelationPathHop {
	readonly segmentIndex: number;
	readonly fromTable: string;
	readonly toTable: string;
	readonly pairs: readonly {
		readonly fromColumn: string;
		readonly toColumn: string;
	}[];
}
export interface ResolvedRelationPath<
	R extends DeclaredRelationPathRelation = RelationIR,
> {
	readonly ok: true;
	readonly logicalSegments: readonly string[];
	readonly relations: readonly R[];
	readonly hops: readonly DeclaredRelationPathHop[];
	readonly targetTable: string;
}

export type DeclaredRelationPathResult<R extends DeclaredRelationPathRelation> =
	| ResolvedRelationPath<R>
	| {
			readonly ok: false;
			readonly kind: 'undeclared-relation';
			readonly segment: string;
			readonly segmentIndex: number;
			readonly sourceTable: string;
	  };

/** Resolve physical model keys without adapter conventions or FK-reference inference. */
export function resolveDeclaredRelationKeys(
	model: Pick<
		DeclaredRelationPathModel<DeclaredRelationPathRelation>,
		'getTable'
	>,
	sourceTable: string,
	relation: DeclaredRelationPathRelation,
) {
	const name = `${sourceTable}.${relation.name}`;
	const foreignKey = toColumnList(
		relation.foreignKey ??
			(relation.type === 'belongsToMany'
				? relation.throughSourceKey
				: undefined),
	);
	if (!foreignKey.length)
		throw new Error(
			`Relation '${name}' is missing a declared foreign key column.`,
		);
	const primaryKey = (table: string) => {
		const value = model.getTable?.(table);
		return value && typeof value === 'object' && 'primaryKey' in value
			? (value.primaryKey as RelationIR['sourceKey'])
			: undefined;
	};
	const sourceKey = toColumnList(relation.sourceKey ?? primaryKey(sourceTable));
	const targetKey = toColumnList(
		relation.targetKey ?? primaryKey(relation.target),
	);
	const referenced = relation.type === 'belongsTo' ? targetKey : sourceKey;
	if (
		relation.type !== 'belongsToMany' &&
		(!referenced.length || referenced.length !== foreignKey.length)
	)
		throw new Error(`Relation '${name}' has mismatched key arity.`);
	return { foreignKey, sourceKey, targetKey };
}

/**
 * Resolve declared logical names only; never infer a path from foreign keys.
 * Schema declarations provide complete physical keys. Minimal compiler facades
 * may omit physical metadata; such segments contribute no correlation hops.
 * Consumers that lower SQL must require a complete physical path.
 */
export function resolveDeclaredRelationPath<
	R extends DeclaredRelationPathRelation,
>(
	model: DeclaredRelationPathModel<R>,
	sourceTable: string,
	logicalSegments: readonly string[],
): DeclaredRelationPathResult<R> {
	const relations: R[] = [];
	const hops: DeclaredRelationPathHop[] = [];
	let currentTable = sourceTable;
	for (const [segmentIndex, segment] of logicalSegments.entries()) {
		const relation =
			model.getRelation?.(`${currentTable}.${segment}`) ??
			model
				.getRelationsFrom(currentTable)
				.find((candidate) => candidate.name === segment);
		if (!relation)
			return {
				ok: false,
				kind: 'undeclared-relation',
				segment,
				segmentIndex,
				sourceTable: currentTable,
			};
		relations.push(relation);
		const hop = (
			fromTable: string,
			toTable: string,
			from: readonly string[],
			to: readonly string[],
			explicitKeys: boolean,
		) => {
			// Compiler facades may expose only logical declarations. Never invent
			// correlation pairs for an absent or incomplete physical key vector.
			if (explicitKeys && (from.length === 0 || from.length !== to.length))
				throw new Error(
					`Relation '${currentTable}.${segment}' has mismatched key arity.`,
				);
			if (from.length === 0 || from.length !== to.length) return;
			hops.push({
				segmentIndex,
				fromTable,
				toTable,
				pairs: from.map((fromColumn, i) => ({
					fromColumn,
					toColumn: to[i] as string,
				})),
			});
		};
		// Full models expose tables; logical compiler facades may expose only columns.
		const keys =
			model.getTable && 'tables' in model
				? resolveDeclaredRelationKeys(model, currentTable, relation)
				: undefined;
		const sourceKey = keys?.sourceKey ?? toColumnList(relation.sourceKey);
		const targetKey = keys?.targetKey ?? toColumnList(relation.targetKey);
		const isAncestor =
			relation.recursive !== null &&
			typeof relation.recursive === 'object' &&
			'direction' in relation.recursive &&
			relation.recursive.direction === 'up';
		const junctionKey = (
			canonical: RelationIR['foreignKey'],
			alias: RelationIR['foreignKey'],
		) => {
			const columns = toColumnList(canonical ?? alias);
			if (canonical !== undefined && alias !== undefined) {
				const aliases = toColumnList(alias);
				if (
					columns.length !== aliases.length ||
					columns.some((c, i) => c !== aliases[i])
				)
					throw new Error(
						`Relation '${currentTable}.${segment}' has conflicting junction key aliases.`,
					);
			}
			return columns;
		};
		if (relation.type === 'belongsToMany') {
			const junctionSource = junctionKey(
				relation.foreignKey,
				relation.throughSourceKey,
			);
			const junctionTarget = junctionKey(
				relation.otherKey,
				relation.throughTargetKey,
			);
			if (
				(keys || sourceKey.length || targetKey.length) &&
				(!relation.through ||
					!sourceKey.length ||
					!targetKey.length ||
					sourceKey.length !== junctionSource.length ||
					targetKey.length !== junctionTarget.length)
			)
				throw new Error(
					`Relation '${currentTable}.${segment}' has mismatched key arity.`,
				);
			if (!relation.through) {
				currentTable = relation.target;
				continue;
			}
			hop(
				currentTable,
				relation.through,
				sourceKey,
				junctionSource,
				relation.sourceKey !== undefined,
			);
			hop(
				relation.through,
				relation.target,
				junctionTarget,
				targetKey,
				relation.targetKey !== undefined,
			);
		} else if (relation.type === 'belongsTo' || isAncestor) {
			hop(
				currentTable,
				relation.target,
				toColumnList(relation.foreignKey),
				isAncestor ? sourceKey : targetKey,
				(isAncestor
					? relation.sourceKey !== undefined
					: relation.targetKey !== undefined) &&
					relation.foreignKey !== undefined,
			);
		} else if (relation.type === 'hasOne' || relation.type === 'hasMany') {
			hop(
				currentTable,
				relation.target,
				sourceKey,
				toColumnList(relation.foreignKey),
				relation.sourceKey !== undefined && relation.foreignKey !== undefined,
			);
		}
		currentTable = relation.target;
	}
	return {
		ok: true,
		logicalSegments,
		relations,
		hops,
		targetTable: currentTable,
	};
}
