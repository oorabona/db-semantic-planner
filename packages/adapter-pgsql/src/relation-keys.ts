import { type ModelIR, type RelationIR, toColumnList } from '@dbsp/types';
import {
	DEFAULT_PK_COLUMN,
	defaultFkDerivation,
	type FkColumnDerivation,
} from './assert-field.js';

/** Declared relation and foreign-key references precede primary keys and fallbacks. */
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
	const foreign = toColumnList(relation.foreignKey);
	const foreignTable = belongsTo ? sourceTable : relation.target;
	const references =
		authorities.model
			?.getTable(foreignTable)
			?.foreignKeys.find(
				(fk) =>
					fk.references.table === referencedTable &&
					fk.columns.length === foreign.length &&
					fk.columns.every((column, index) => column === foreign[index]),
			)?.references.columns ?? [];
	const declared = toColumnList(
		authorities.model?.getTable(referencedTable)?.primaryKey,
	);
	const referencedKey = explicit.length
		? explicit
		: references.length
			? references
			: declared.length
				? declared
				: [authorities.defaultPkColumnName ?? DEFAULT_PK_COLUMN];
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
