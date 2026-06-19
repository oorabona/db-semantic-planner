import type { ColumnValidatorRelation } from './types.js';

export const DEFAULT_RELATION_TARGET_COLUMN = 'id';

export function relationForeignKeys(
	relation: ColumnValidatorRelation | undefined,
): readonly string[] | undefined {
	if (!relation) return undefined;
	if (typeof relation.foreignKey === 'string') return [relation.foreignKey];
	if (Array.isArray(relation.foreignKey)) return relation.foreignKey;
	return undefined;
}

export function relationCardinality(
	relation: Pick<ColumnValidatorRelation, 'type'> | undefined,
): 'one' | 'many' {
	return relation?.type === 'hasMany' || relation?.type === 'belongsToMany'
		? 'many'
		: 'one';
}

export function scalarRelationJoinColumns(
	relation: ColumnValidatorRelation | undefined,
):
	| {
			readonly sourceJoinColumn: string;
			readonly targetJoinColumn: string;
	  }
	| undefined {
	if (!relation) return undefined;
	if (
		relation.type !== 'belongsTo' &&
		relation.type !== 'hasOne' &&
		relation.type !== 'hasMany'
	) {
		return undefined;
	}
	const fkColumns = relationForeignKeys(relation);
	if (fkColumns?.length !== 1) return undefined;
	const fkColumn = fkColumns[0]!;
	const sourceJoinColumn =
		relation.type === 'belongsTo'
			? fkColumn
			: (relation.sourceKey ?? DEFAULT_RELATION_TARGET_COLUMN);
	const targetJoinColumn =
		relation.type === 'belongsTo'
			? (relation.targetKey ?? DEFAULT_RELATION_TARGET_COLUMN)
			: fkColumn;
	return { sourceJoinColumn, targetJoinColumn };
}
