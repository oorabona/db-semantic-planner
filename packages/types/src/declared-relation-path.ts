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
		const sourceKey = toColumnList(relation.sourceKey);
		const targetKey = toColumnList(relation.targetKey);
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
			if (!relation.through) {
				currentTable = relation.target;
				continue;
			}
			hop(
				currentTable,
				relation.through,
				sourceKey,
				junctionKey(relation.foreignKey, relation.throughSourceKey),
				relation.sourceKey !== undefined,
			);
			hop(
				relation.through,
				relation.target,
				junctionKey(relation.otherKey, relation.throughTargetKey),
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
