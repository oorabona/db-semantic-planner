import type { ColumnJsReadType } from './model-ir.js';

export type OutputValueShape =
	| { readonly kind: 'scalar'; readonly cardinality: 'one' }
	| {
			readonly kind: 'array';
			readonly cardinality: 'many';
			readonly aggregate?: 'json_agg' | 'array_agg';
	  }
	| {
			readonly kind: 'object';
			readonly cardinality: 'one';
			readonly aggregate?: 'json_agg';
	  }
	| { readonly kind: 'aggregate-scalar'; readonly aggregate: string }
	| { readonly kind: 'unknown'; readonly reason: string };

export type OutputSource =
	| {
			readonly kind: 'modelColumn';
			readonly table: string;
			readonly column: string;
			readonly js?: ColumnJsReadType;
	  }
	| { readonly kind: 'expression'; readonly reason: string }
	| { readonly kind: 'ambiguous'; readonly reason: string }
	| { readonly kind: 'unresolved'; readonly reason: string };

export type OutputDescriptor = {
	readonly outputKey: string;
	readonly source: OutputSource;
	readonly shape: OutputValueShape;
};

export type OutputReadHandling =
	| {
			readonly kind: 'scalarConvert';
			readonly table: string;
			readonly column: string;
			readonly js: ColumnJsReadType;
	  }
	| {
			readonly kind: 'nestedTransform';
			readonly table: string;
			readonly column: string;
			readonly js: ColumnJsReadType;
	  }
	| { readonly kind: 'none' };

export type NestedOutputReadHandling = Extract<
	OutputReadHandling,
	{ readonly kind: 'nestedTransform' }
>;

export function resolveOutputReadHandling(
	descriptor: OutputDescriptor,
): OutputReadHandling {
	const { source } = descriptor;
	if (source.kind !== 'modelColumn' || source.js === undefined) {
		return { kind: 'none' };
	}

	switch (descriptor.shape.kind) {
		case 'scalar':
			return {
				kind: 'scalarConvert',
				table: source.table,
				column: source.column,
				js: source.js,
			};
		case 'array':
		case 'object':
			return {
				kind: 'nestedTransform',
				table: source.table,
				column: source.column,
				js: source.js,
			};
		case 'aggregate-scalar':
		case 'unknown':
			return { kind: 'none' };
	}
}
