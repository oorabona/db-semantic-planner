import { type ModelIR, type RelationIR, toColumnList } from '@dbsp/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';

/** Declared relation keys and table primary keys precede convention fallbacks. */
export function resolveRelationKeys(
	sourceTable: string,
	relation: Pick<
		RelationIR,
		'type' | 'target' | 'foreignKey' | 'sourceKey' | 'targetKey'
	>,
	authorities: {
		model?: ModelIR;
		defaultPkColumnName?: string;
		deriveFkColumnName?: FkColumnDerivation;
	},
) {
	const belongsTo = relation.type === 'belongsTo';
	const referencedTable = belongsTo ? relation.target : sourceTable;
	const explicit = toColumnList(
		belongsTo ? relation.targetKey : relation.sourceKey,
	);
	const declared = toColumnList(
		authorities.model?.getTable(referencedTable)?.primaryKey,
	);
	const referencedKey = explicit.length
		? explicit
		: declared.length
			? declared
			: [authorities.defaultPkColumnName ?? DEFAULT_PK_COLUMN];
	const foreign = toColumnList(relation.foreignKey);
	const foreignKey = foreign.length
		? foreign
		: referencedKey.map((key) =>
				(authorities.deriveFkColumnName ?? defaultFkDerivation)(
					referencedTable,
					key,
				),
			);
	return {
		sourceColumn: belongsTo ? foreignKey : referencedKey,
		targetColumn: belongsTo ? referencedKey : foreignKey,
	};
}
