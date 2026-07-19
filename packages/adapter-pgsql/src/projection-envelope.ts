import type {
	ColumnJsReadType,
	CompiledColumnMetadata,
	CompiledQuery,
	ModelIR,
	PlanReport,
} from '@dbsp/types';
import type { Node } from '@pgsql/types';
import {
	buildCompiledColumnMetadata,
	buildCompiledColumnProjections,
	buildModelColumnProjections,
	type ColumnMetadataProjection,
	metadataForModelColumns,
} from './column-metadata.js';
import type { NamingPlugin } from './naming-plugin.js';

const projectionEnvelopeBrand: unique symbol = Symbol('projectionEnvelope');

export type ProjectionEnvelope<T = unknown> = {
	readonly [projectionEnvelopeBrand]: true;
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly ast?: Node;
	readonly projection: ProjectionState;
	readonly hydrationPlan?: PlanReport;
	readonly __resultType?: T;
};

export type ProjectionState =
	| {
			readonly kind: 'known';
			readonly outputs: ReadonlyMap<string, OutputProjection>;
	  }
	| {
			readonly kind: 'dropped';
			readonly reason: ProjectionDropReason;
			readonly hadConvertibleSource: boolean;
	  };

export type OutputProjection =
	| {
			readonly kind: 'modelColumn';
			readonly table: string;
			readonly column: string;
			readonly js?: ColumnJsReadType;
	  }
	| { readonly kind: 'expression'; readonly reason: string }
	| { readonly kind: 'ambiguous'; readonly reason: string }
	| { readonly kind: 'unresolved'; readonly reason: string };

export type ProjectionDropReason =
	| 'set-operation-positional-merge'
	| 'raw-recursive-cte-positional-merge'
	| 'unknown-raw-sql'
	| 'unsupported-source';

export type FromAstProjectionOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly ast: Node;
	readonly rootTable: string;
	readonly model: ModelIR | undefined;
	readonly naming: NamingPlugin;
	readonly hydrationPlan?: PlanReport;
};

export type FromModelColumnsOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly table: string;
	readonly columns: readonly string[];
	readonly model: ModelIR;
	readonly naming: NamingPlugin;
};

export type ProjectNamedFieldsSelection = {
	readonly inputKey: string;
	readonly outputKey: string;
};

export type ProjectNamedFieldsOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly selections: readonly ProjectNamedFieldsSelection[];
};

export type PreserveOneToOneOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
};

export type DropPositionalUnionOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly reason: ProjectionDropReason;
};

type EnvelopeFields = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly ast?: Node;
	readonly projection: ProjectionState;
	readonly hydrationPlan?: PlanReport;
};

type CompiledQueryWithHydrationPlan<T> = CompiledQuery<T> & {
	readonly hydrationPlan?: PlanReport;
};

function makeEnvelope<T = unknown>(
	fields: EnvelopeFields,
): ProjectionEnvelope<T> {
	return {
		[projectionEnvelopeBrand]: true,
		sql: fields.sql,
		parameters: fields.parameters,
		...(fields.ast !== undefined ? { ast: fields.ast } : {}),
		projection: fields.projection,
		...(fields.hydrationPlan !== undefined
			? { hydrationPlan: fields.hydrationPlan }
			: {}),
	} as ProjectionEnvelope<T>;
}

function outputFromColumnProjection(
	projection: ColumnMetadataProjection,
): OutputProjection {
	switch (projection.kind) {
		case 'modelColumn':
			return {
				kind: 'modelColumn',
				table: projection.table,
				column: projection.column,
				...(projection.js !== undefined ? { js: projection.js } : {}),
			};
		case 'expression':
			return { kind: 'expression', reason: projection.reason };
		case 'ambiguous':
			return { kind: 'ambiguous', reason: projection.reason };
		case 'unresolved':
			return { kind: 'unresolved', reason: projection.reason };
	}
}

function outputMapFromColumnProjections(
	projections: ReadonlyMap<string, ColumnMetadataProjection> | undefined,
): ReadonlyMap<string, OutputProjection> {
	const outputs = new Map<string, OutputProjection>();
	if (!projections) return outputs;
	for (const [outputKey, projection] of projections) {
		outputs.set(outputKey, outputFromColumnProjection(projection));
	}
	return outputs;
}

function overlayCompiledMetadata(
	outputs: ReadonlyMap<string, OutputProjection>,
	metadata: ReadonlyMap<string, CompiledColumnMetadata> | undefined,
): ReadonlyMap<string, OutputProjection> {
	if (!metadata || metadata.size === 0) return outputs;
	const merged = new Map(outputs);
	for (const [outputKey, entry] of metadata) {
		merged.set(outputKey, {
			kind: 'modelColumn',
			table: entry.table,
			column: entry.column,
			js: entry.js,
		});
	}
	return merged;
}

function hasConvertibleModelColumn(projection: ProjectionState): boolean {
	if (projection.kind === 'dropped') return projection.hadConvertibleSource;
	for (const output of projection.outputs.values()) {
		if (output.kind === 'modelColumn' && output.js !== undefined) return true;
	}
	return false;
}

function droppedProjectionErrorMessage(reason: ProjectionDropReason): string {
	switch (reason) {
		case 'set-operation-positional-merge':
			return '`js` read type is not yet supported through set operations; use a plain select (tracking: #352)';
		case 'raw-recursive-cte-positional-merge':
			return '`js` read type is not yet supported through raw recursive CTEs (positional base∪step); use a plain select (tracking: #352)';
		case 'unknown-raw-sql':
			return '`js` read type is not yet supported through unknown raw SQL; use a plain select (tracking: #352)';
		case 'unsupported-source':
			return '`js` read type is not yet supported through this projection source; use a plain select (tracking: #352)';
	}
}

export function fromAstProjection<T = unknown>(
	options: FromAstProjectionOptions,
): ProjectionEnvelope<T> {
	const projectedOutputs = outputMapFromColumnProjections(
		buildCompiledColumnProjections(
			options.ast,
			options.rootTable,
			options.model,
			options.naming,
		),
	);
	const outputs = overlayCompiledMetadata(
		projectedOutputs,
		buildCompiledColumnMetadata(
			options.ast,
			options.rootTable,
			options.model,
			options.naming,
		),
	);
	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		ast: options.ast,
		projection: { kind: 'known', outputs },
		...(options.hydrationPlan !== undefined
			? { hydrationPlan: options.hydrationPlan }
			: {}),
	});
}

export function fromModelColumns<T = unknown>(
	options: FromModelColumnsOptions,
): ProjectionEnvelope<T> {
	const projectedOutputs = outputMapFromColumnProjections(
		buildModelColumnProjections(
			options.table,
			options.columns,
			options.model,
			options.naming,
		),
	);
	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: {
			kind: 'known',
			outputs: overlayCompiledMetadata(
				projectedOutputs,
				metadataForModelColumns(
					options.table,
					options.columns,
					options.model,
					options.naming,
				),
			),
		},
	});
}

export function projectNamedFields<T = unknown>(
	source: ProjectionEnvelope<T>,
	options: ProjectNamedFieldsOptions,
): ProjectionEnvelope<T> {
	if (source.projection.kind === 'dropped') {
		return makeEnvelope<T>({
			sql: options.sql,
			parameters: options.parameters,
			projection: source.projection,
			...(source.hydrationPlan !== undefined
				? { hydrationPlan: source.hydrationPlan }
				: {}),
		});
	}

	const outputs = new Map<string, OutputProjection>();
	for (const selection of options.selections) {
		if (outputs.has(selection.outputKey)) {
			outputs.set(selection.outputKey, {
				kind: 'ambiguous',
				reason: `projection output '${selection.outputKey}' was selected more than once`,
			});
			continue;
		}
		const sourceOutput = source.projection.outputs.get(selection.inputKey);
		outputs.set(
			selection.outputKey,
			sourceOutput ?? {
				kind: 'unresolved',
				reason: `projection input '${selection.inputKey}' was not present in source`,
			},
		);
	}

	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: { kind: 'known', outputs },
		...(source.hydrationPlan !== undefined
			? { hydrationPlan: source.hydrationPlan }
			: {}),
	});
}

export function preserveOneToOne<T = unknown>(
	source: ProjectionEnvelope<T>,
	options: PreserveOneToOneOptions,
): ProjectionEnvelope<T> {
	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: source.projection,
		...(source.hydrationPlan !== undefined
			? { hydrationPlan: source.hydrationPlan }
			: {}),
	});
}

export function dropPositionalUnion<T = unknown>(
	branches: readonly ProjectionEnvelope<unknown>[],
	options: DropPositionalUnionOptions,
): ProjectionEnvelope<T> {
	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: {
			kind: 'dropped',
			reason: options.reason,
			hadConvertibleSource: branches.some((branch) =>
				hasConvertibleModelColumn(branch.projection),
			),
		},
	});
}

export function expressionColumn(
	outputKey: string,
	reason: string,
): readonly [string, OutputProjection] {
	return [outputKey, { kind: 'expression', reason }] as const;
}

export function finalizeEnvelope<T = unknown>(
	env: ProjectionEnvelope<T>,
): CompiledQuery<T> {
	if (env.projection.kind === 'dropped') {
		if (env.projection.hadConvertibleSource) {
			throw new Error(droppedProjectionErrorMessage(env.projection.reason));
		}
		const compiled: CompiledQueryWithHydrationPlan<T> = {
			sql: env.sql,
			parameters: env.parameters,
			...(env.hydrationPlan !== undefined
				? { hydrationPlan: env.hydrationPlan }
				: {}),
		};
		return compiled;
	}

	const columnMetadata = new Map<string, CompiledColumnMetadata>();
	for (const [outputKey, output] of env.projection.outputs) {
		if (output.kind === 'modelColumn' && output.js !== undefined) {
			columnMetadata.set(outputKey, {
				table: output.table,
				column: output.column,
				js: output.js,
			});
		}
	}

	const compiled: CompiledQueryWithHydrationPlan<T> = {
		sql: env.sql,
		parameters: env.parameters,
		...(columnMetadata.size > 0 ? { columnMetadata } : {}),
		...(env.hydrationPlan !== undefined
			? { hydrationPlan: env.hydrationPlan }
			: {}),
	};
	return compiled;
}
