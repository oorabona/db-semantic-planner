import type { ColumnListInput } from './column-list.js';
import { toColumnList } from './column-list.js';
import type { ForeignKeyIR, RelationIR } from './model-ir.js';

const DEFAULT_REFERENCED_COLUMN = 'id';

export type RelationKeyDirection = 'belongsTo' | 'inverse';

export type RelationKeyForeignKey = Pick<ForeignKeyIR, 'references'> & {
	readonly columns: ColumnListInput;
};

export interface RelationKeyBuilderOptions {
	readonly defaultReferencedColumn?: string;
	readonly foreignKeyShape?: ColumnListInput;
	readonly referencedKeyShape?: ColumnListInput;
}

export type RelationKeyFields = Pick<RelationIR, 'foreignKey'> &
	Partial<Pick<RelationIR, 'sourceKey' | 'targetKey'>>;

function columnListValue(
	columns: readonly string[],
	shape?: ColumnListInput,
): string | readonly string[] {
	if (shape !== undefined && typeof shape !== 'string') return columns;
	// biome-ignore lint/style/noNonNullAssertion: columns.length === 1 guaranteed by the ternary condition on this line
	return columns.length === 1 ? columns[0]! : columns;
}

/**
 * Build RelationIR key fields from a foreign key while preserving both sides.
 *
 * The local FK columns and referenced columns are normalized with toColumnList()
 * so composite keys cannot silently degrade to their first column.
 */
export function buildRelationKeyFields(
	fk: RelationKeyForeignKey,
	direction: RelationKeyDirection,
	options: RelationKeyBuilderOptions = {},
): RelationKeyFields {
	const foreignKeyColumns = toColumnList(fk.columns);
	const referencedColumns = toColumnList(fk.references.columns);

	if (foreignKeyColumns.length !== referencedColumns.length) {
		throw new Error(
			`Foreign key column count (${foreignKeyColumns.length}) must match referenced column count (${referencedColumns.length})`,
		);
	}

	const foreignKey = columnListValue(
		foreignKeyColumns,
		options.foreignKeyShape,
	);
	const defaultReferencedColumn =
		options.defaultReferencedColumn ?? DEFAULT_REFERENCED_COLUMN;
	const isImplicitDefaultReference =
		options.referencedKeyShape === undefined &&
		referencedColumns.length === 1 &&
		referencedColumns[0] === defaultReferencedColumn;

	if (!isImplicitDefaultReference) {
		const referencedKey = columnListValue(
			referencedColumns,
			options.referencedKeyShape,
		);
		if (direction === 'belongsTo') {
			return { foreignKey, targetKey: referencedKey };
		}
		return { foreignKey, sourceKey: referencedKey };
	}

	return { foreignKey };
}
