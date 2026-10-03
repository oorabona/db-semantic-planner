import { toColumnList } from './column-list.js';
import type { RelationIR } from './model-ir.js';

/** Minimal declared relation contract, also usable by compiler schema facades. */
export type DeclaredRelationPathRelation = Pick<RelationIR, 'name' | 'target'> &
	Partial<
		Pick<
			RelationIR,
			'source' | 'type' | 'foreignKey' | 'sourceKey' | 'targetKey'
		>
	>;

export interface DeclaredRelationPathModel<
	R extends DeclaredRelationPathRelation,
> {
	getRelation?(qualifiedName: string): R | undefined;
	getRelationsFrom(sourceTable: string): readonly R[];
}

export interface DeclaredRelationPathHop {
	readonly source: string;
	readonly target: string;
	readonly type: RelationIR['type'] | undefined;
	readonly foreignKey: readonly string[];
	readonly sourceKey: readonly string[];
	readonly targetKey: readonly string[];
}

export type DeclaredRelationPathResult<R extends DeclaredRelationPathRelation> =
	| {
			readonly ok: true;
			readonly relations: readonly R[];
			readonly hops: readonly DeclaredRelationPathHop[];
			readonly targetTable: string;
	  }
	| {
			readonly ok: false;
			readonly kind: 'undeclared-relation';
			readonly segment: string;
			readonly segmentIndex: number;
			readonly sourceTable: string;
	  };

/** Resolve declared logical names only; never infer a path from foreign keys. */
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
		hops.push({
			source: currentTable,
			target: relation.target,
			type: relation.type,
			foreignKey: toColumnList(relation.foreignKey),
			sourceKey: toColumnList(relation.sourceKey),
			targetKey: toColumnList(relation.targetKey),
		});
		currentTable = relation.target;
	}
	return { ok: true, relations, hops, targetTable: currentTable };
}
