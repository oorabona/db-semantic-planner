import type {
	CompiledColumnMetadata,
	CompiledQuery,
	ModelIR,
	OutputDescriptor,
	OutputSource,
	OutputValueShape,
	PlanReport,
} from '@dbsp/types';
import { resolveOutputReadHandling } from '@dbsp/types';
import { compiledQueryFromProjection } from '@dbsp/types/adapter-sdk';
import type { Node } from '@pgsql/types';
import {
	buildCompiledColumnProjections,
	buildModelColumnProjections,
	type ColumnMetadataProjection,
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

export type OutputProjection = OutputDescriptor;
export type {
	OutputDescriptor,
	OutputSource,
	OutputValueShape,
} from '@dbsp/types';

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

export type FromOutputDescriptorsOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly columns: readonly string[];
	readonly declaredOutputs?: readonly OutputDescriptor[];
	readonly naming: NamingPlugin;
	readonly hydrationPlan?: PlanReport;
};

export type ProjectNamedFieldsSelection = {
	readonly inputKey: string;
	readonly outputKey: string;
};

export type ProjectNamedFieldsExpression = {
	readonly outputKey: string;
	readonly reason: string;
};

export type ProjectNamedFieldsOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly selections: readonly ProjectNamedFieldsSelection[];
	readonly expressions?: readonly ProjectNamedFieldsExpression[];
	readonly hydrationPlan?: PlanReport;
	readonly preserveHydrationPlan?: boolean;
};

export type PreserveOneToOneOptions = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly hydrationPlan?: PlanReport;
	readonly preserveHydrationPlan?: boolean;
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
	readonly hydrationPlan?: CompiledQuery<T>['hydrationPlan'];
};

const scalarOneShape: OutputValueShape = {
	kind: 'scalar',
	cardinality: 'one',
};

function unknownShape(reason: string): OutputValueShape {
	return { kind: 'unknown', reason };
}

function descriptor(
	outputKey: string,
	source: OutputSource,
	shape: OutputValueShape,
): OutputProjection {
	return { outputKey, source, shape };
}

function descriptorForSource(
	outputKey: string,
	source: OutputSource,
): OutputProjection {
	if (source.kind === 'modelColumn') {
		return descriptor(outputKey, source, scalarOneShape);
	}
	return descriptor(
		outputKey,
		source,
		unknownShape(
			`projection output '${outputKey}' has no scalar model column shape`,
		),
	);
}

function withOutputKey(
	output: OutputProjection,
	outputKey: string,
): OutputProjection {
	return descriptor(outputKey, output.source, output.shape);
}

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
): OutputSource {
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
		outputs.set(
			outputKey,
			descriptorForSource(outputKey, outputFromColumnProjection(projection)),
		);
	}
	return outputs;
}

export function fromCompiledQuery<T = unknown>(
	compiled: CompiledQuery,
): ProjectionEnvelope<T> {
	const outputs = new Map<string, OutputProjection>();
	for (const [outputKey, entry] of compiled.columnMetadata ?? []) {
		outputs.set(
			outputKey,
			descriptor(
				outputKey,
				{
					kind: 'modelColumn',
					table: entry.table,
					column: entry.column,
					js: entry.js,
				},
				scalarOneShape,
			),
		);
	}
	return makeEnvelope<T>({
		sql: compiled.sql,
		parameters: compiled.parameters,
		projection: { kind: 'known', outputs },
		...(compiled.hydrationPlan !== undefined
			? { hydrationPlan: compiled.hydrationPlan }
			: {}),
	});
}

function hasConvertibleModelColumn(projection: ProjectionState): boolean {
	if (projection.kind === 'dropped') return projection.hadConvertibleSource;
	for (const output of projection.outputs.values()) {
		if (resolveOutputReadHandling(output).kind !== 'none') return true;
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

function projectedHydrationPlan(
	source: ProjectionEnvelope<unknown>,
	options: {
		readonly hydrationPlan?: PlanReport;
		readonly preserveHydrationPlan?: boolean;
	},
): PlanReport | undefined {
	if (options.hydrationPlan !== undefined) return options.hydrationPlan;
	if (options.preserveHydrationPlan === false) return undefined;
	return source.hydrationPlan;
}

export function fromAstProjection<T = unknown>(
	options: FromAstProjectionOptions,
): ProjectionEnvelope<T> {
	const outputs = outputMapFromColumnProjections(
		buildCompiledColumnProjections(
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
	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: {
			kind: 'known',
			outputs: outputMapFromColumnProjections(
				buildModelColumnProjections(
					options.table,
					options.columns,
					options.model,
					options.naming,
				),
			),
		},
	});
}

function outputDescriptorWithEmittedKey(
	output: OutputDescriptor,
	naming: NamingPlugin,
): OutputProjection {
	return descriptor(
		naming.toDatabase(output.outputKey),
		output.source,
		output.shape,
	);
}

export function fromOutputDescriptors<T = unknown>(
	options: FromOutputDescriptorsOptions,
): ProjectionEnvelope<T> {
	const descriptorsByOutput = new Map<string, OutputDescriptor[]>();
	for (const output of options.declaredOutputs ?? []) {
		const outputKey = options.naming.toDatabase(output.outputKey);
		const entries = descriptorsByOutput.get(outputKey) ?? [];
		entries.push(output);
		descriptorsByOutput.set(outputKey, entries);
	}

	const outputs = new Map<string, OutputProjection>();
	for (const column of options.columns) {
		const outputKey = options.naming.toDatabase(column);
		const entries = descriptorsByOutput.get(outputKey) ?? [];
		if (entries.length === 0) {
			outputs.set(
				outputKey,
				descriptorForSource(outputKey, {
					kind: 'unresolved',
					reason: 'binding output descriptor was not provided',
				}),
			);
			continue;
		}
		if (entries.length > 1) {
			outputs.set(
				outputKey,
				descriptor(
					outputKey,
					{
						kind: 'ambiguous',
						reason: `binding output '${outputKey}' had multiple declared descriptors`,
					},
					unknownShape(
						`binding output '${outputKey}' had multiple declared descriptors`,
					),
				),
			);
			continue;
		}
		const [output] = entries;
		outputs.set(
			outputKey,
			output !== undefined
				? outputDescriptorWithEmittedKey(output, options.naming)
				: descriptorForSource(outputKey, {
						kind: 'unresolved',
						reason: 'binding output descriptor could not be read',
					}),
		);
	}

	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: { kind: 'known', outputs },
		...(options.hydrationPlan !== undefined
			? { hydrationPlan: options.hydrationPlan }
			: {}),
	});
}

export function supplementOutputDescriptors<T = unknown>(
	source: ProjectionEnvelope<T>,
	descriptors: readonly OutputDescriptor[],
): ProjectionEnvelope<T> {
	if (source.projection.kind === 'dropped' || descriptors.length === 0) {
		return source;
	}

	const outputs = new Map(source.projection.outputs);
	for (const output of descriptors) {
		outputs.set(output.outputKey, output);
	}

	return makeEnvelope<T>({
		sql: source.sql,
		parameters: source.parameters,
		...(source.ast !== undefined ? { ast: source.ast } : {}),
		projection: { kind: 'known', outputs },
		...(source.hydrationPlan !== undefined
			? { hydrationPlan: source.hydrationPlan }
			: {}),
	});
}

export function projectNamedFields<T = unknown>(
	source: ProjectionEnvelope,
	options: ProjectNamedFieldsOptions,
): ProjectionEnvelope<T> {
	if (source.projection.kind === 'dropped') {
		const hydrationPlan = projectedHydrationPlan(source, options);
		return makeEnvelope<T>({
			sql: options.sql,
			parameters: options.parameters,
			projection: source.projection,
			...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
		});
	}

	const hydrationPlan = projectedHydrationPlan(source, options);
	const outputs = new Map<string, OutputProjection>();
	for (const selection of options.selections) {
		const sourceOutput = source.projection.outputs.get(selection.inputKey);
		setProjectedOutput(
			outputs,
			selection.outputKey,
			sourceOutput
				? withOutputKey(sourceOutput, selection.outputKey)
				: descriptorForSource(selection.outputKey, {
						kind: 'unresolved',
						reason: `projection input '${selection.inputKey}' was not present in source`,
					}),
		);
	}
	for (const expression of options.expressions ?? []) {
		const [outputKey, output] = expressionColumn(
			expression.outputKey,
			expression.reason,
		);
		setProjectedOutput(outputs, outputKey, output);
	}

	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: { kind: 'known', outputs },
		...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
	});
}

function setProjectedOutput(
	outputs: Map<string, OutputProjection>,
	outputKey: string,
	output: OutputProjection,
): void {
	if (outputs.has(outputKey)) {
		outputs.set(
			outputKey,
			descriptorForSource(outputKey, {
				kind: 'ambiguous',
				reason: `projection output '${outputKey}' was selected more than once`,
			}),
		);
		return;
	}
	outputs.set(outputKey, output);
}

export function preserveOneToOne<T = unknown>(
	source: ProjectionEnvelope,
	options: PreserveOneToOneOptions,
): ProjectionEnvelope<T> {
	const hydrationPlan = projectedHydrationPlan(source, options);
	return makeEnvelope<T>({
		sql: options.sql,
		parameters: options.parameters,
		projection: source.projection,
		...(hydrationPlan !== undefined ? { hydrationPlan } : {}),
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
	return [
		outputKey,
		descriptor(outputKey, { kind: 'expression', reason }, unknownShape(reason)),
	] as const;
}

export function finalizeEnvelope<T = unknown>(
	env: ProjectionEnvelope,
): CompiledQuery<T> {
	if (env.projection.kind === 'dropped') {
		if (env.projection.hadConvertibleSource) {
			throw new Error(droppedProjectionErrorMessage(env.projection.reason));
		}
		const compiled: CompiledQueryWithHydrationPlan<T> =
			compiledQueryFromProjection({
				sql: env.sql,
				parameters: env.parameters,
				columnMetadata: new Map<string, CompiledColumnMetadata>(),
				...(env.hydrationPlan !== undefined
					? { hydrationPlan: env.hydrationPlan }
					: {}),
			});
		return compiled;
	}

	const columnMetadata = new Map<string, CompiledColumnMetadata>();
	for (const [outputKey, descriptor] of env.projection.outputs) {
		const handling = resolveOutputReadHandling(descriptor);
		switch (handling.kind) {
			case 'scalarConvert':
				columnMetadata.set(outputKey, {
					table: handling.table,
					column: handling.column,
					js: handling.js,
				});
				break;
			case 'nestedTransform':
			case 'none':
				break;
		}
	}

	const compiled: CompiledQueryWithHydrationPlan<T> =
		compiledQueryFromProjection({
			sql: env.sql,
			parameters: env.parameters,
			columnMetadata,
			...(env.hydrationPlan !== undefined
				? { hydrationPlan: env.hydrationPlan }
				: {}),
		});
	return compiled;
}
