import {
	type ColumnIR,
	type NestedOutputReadHandling,
	type OutputDescriptor,
	type OutputValueShape,
	type RelationType,
	resolveOutputReadHandling,
} from '@dbsp/types';

export function jsonAggContainerShape(
	relationType: RelationType | undefined,
): Extract<OutputValueShape, { readonly kind: 'array' | 'object' }> {
	if (relationType === 'belongsTo' || relationType === 'hasOne') {
		return { kind: 'object', cardinality: 'one', aggregate: 'json_agg' };
	}
	return { kind: 'array', cardinality: 'many', aggregate: 'json_agg' };
}

export function jsonAggColumnDescriptor(
	tableName: string,
	column: ColumnIR,
	shape: Extract<OutputValueShape, { readonly kind: 'array' | 'object' }>,
): OutputDescriptor {
	const js = column.type === 'bigint' ? column.js : undefined;
	return {
		outputKey: column.name,
		source: {
			kind: 'modelColumn',
			table: tableName,
			column: column.name,
			...(js !== undefined ? { js } : {}),
		},
		shape,
	};
}

export function resolveJsonAggColumnReadHandling(
	tableName: string,
	column: ColumnIR,
	shape: Extract<OutputValueShape, { readonly kind: 'array' | 'object' }>,
): NestedOutputReadHandling | undefined {
	const handling = resolveOutputReadHandling(
		jsonAggColumnDescriptor(tableName, column, shape),
	);
	return handling.kind === 'nestedTransform' ? handling : undefined;
}
