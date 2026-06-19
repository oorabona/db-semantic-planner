import { toColumnList } from '@dbsp/types';
import type { ColumnValidatorRelation } from './types.js';

export const DEFAULT_RELATION_TARGET_COLUMN = 'id';

export function relationForeignKeys(
	relation: ColumnValidatorRelation | undefined,
): readonly string[] | undefined {
	if (!relation) return undefined;
	const columns = toColumnList(relation.foreignKey);
	return columns.length > 0 ? columns : undefined;
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
			readonly sourceJoinColumn: readonly string[];
			readonly targetJoinColumn: readonly string[];
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
	if (!fkColumns) return undefined;
	const sourceKeys = toColumnList(relation.sourceKey);
	const targetKeys = toColumnList(relation.targetKey);
	const sourceJoinColumn =
		relation.type === 'belongsTo'
			? fkColumns
			: sourceKeys.length > 0
				? sourceKeys
				: [DEFAULT_RELATION_TARGET_COLUMN];
	const targetJoinColumn =
		relation.type === 'belongsTo'
			? targetKeys.length > 0
				? targetKeys
				: [DEFAULT_RELATION_TARGET_COLUMN]
			: fkColumns;
	return { sourceJoinColumn, targetJoinColumn };
}
