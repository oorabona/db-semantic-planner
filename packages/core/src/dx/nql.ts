/**
 * @fileoverview NQL template literal integration for type-safe queries (DX-040 Block 8).
 *
 * Provides a type-safe way to use NQL queries with explicit type annotation:
 * ```typescript
 * const users = await orm.nql<{ name: string; email: string }>`users | select name, email`.all();
 * ```
 *
 * Each non-raw `${value}` interpolation is converted into a generated NQL named
 * parameter (`:__p0`, `:__p1`, ...) and forwarded to the compiler through its
 * params map. Values never touch NQL source text. Use `nqlRaw()` only for trusted
 * dynamic NQL fragments that must participate in parsing, such as an ORDER BY
 * clause assembled from application-controlled choices.
 *
 * @module nql
 * @since DX-040
 */

import {
	type CompiledNqlQuery,
	type NqlCompilerOptions,
	NqlLexer,
	compile as nqlCompile,
} from '@dbsp/nql';
import type {
	ColumnListInput,
	NqlBindingRelationFilterMetadata,
	NqlBindingVirtualRelation,
} from '@dbsp/types';
import { resolveJsonAggOrderKey } from '@dbsp/types';
import {
	explainUnsupportedNqlBindingIncludeHop,
	getTrustedNqlRelationFilterFields,
	NQL_INTERNAL_COMPILER_OPTIONS,
	type NqlBindingIncludeNodeShape,
	type NqlBindingIncludeRelationShape,
} from '@dbsp/types/internal';
import {
	type Adapter,
	type CompileOptions,
	type DbCasing,
	type Dump,
	type DumpMeta,
	type DumpSequenceStep,
	type NqlRuntimeBinding,
	supportsTransactions,
} from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type {
	IncludeIntent,
	MutationIntent,
	QueryIntent,
	WhereIntent,
} from '../intent-ast.js';
import type { ModelIR, RelationIR } from '../model-ir.js';
import type { PlanDecision, PlanReport } from '../planner.js';
import { plan as executePlan } from '../planner.js';
import { ExecutionError } from './errors.js';
import type { HookErrorHandler, HookStore } from './hooks.js';
import { hydrateJsonAggIncludes } from './hydration-utils.js';
import {
	type MutationDump,
	runMutationWithHooks,
} from './mutation-builders.js';
import type { DumpMetaInput } from './query-builder-types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * NQL query builder with type-safe result.
 *
 * @typeParam T - The expected result row type
 */
export interface NqlBuilder<T> {
	/** Execute query and return all results */
	all(): Promise<T[]>;
	/** Execute query or mutation and discard any returned rows */
	run(): Promise<void>;
	/** Execute query and return first result or null */
	first(): Promise<T | null>;
	/** Get the IntentIR for debugging */
	toIntentIR(): QueryIntent | MutationIntent;
	/** Get the execution plan */
	plan(): PlanReport;
	/** Get full dump. Mutations return MutationDump without a plan. */
	dump(meta?: DumpMetaInput): Dump | MutationDump;
}

/**
 * NQL template tag function type.
 *
 * @example
 * ```typescript
 * orm.nql<{ name: string }>`users | select name`
 * ```
 */
export type NqlTag = <T>(
	strings: TemplateStringsArray,
	...values: unknown[]
) => NqlBuilder<T>;

declare const NQL_RAW_FRAGMENT_TYPE: unique symbol;

/**
 * Trusted NQL source fragment for `nql` template interpolation.
 *
 * Never wrap untrusted input in `nqlRaw()`: raw fragments are spliced verbatim
 * into NQL source and parsed as query structure.
 *
 * @public
 */
export interface NqlRawFragment {
	readonly fragment: string;
	readonly [NQL_RAW_FRAGMENT_TYPE]: true;
}

// ============================================================================
// Implementation
// ============================================================================

const NQL_RAW_FRAGMENT = Symbol('NqlRawFragment');

type RuntimeNqlRawFragment = NqlRawFragment & {
	readonly [NQL_RAW_FRAGMENT]: true;
};

interface GeneratedParamRange {
	readonly name: string;
	readonly start: number;
	readonly end: number;
}

interface AssembledNqlTemplate {
	readonly query: string;
	readonly params: Readonly<Record<string, unknown>>;
	readonly hasBoundParams: boolean;
	readonly sourceError: string | undefined;
}

type CompiledNqlIntent =
	| {
			readonly kind: 'query';
			readonly bundle: CompiledNqlQuery;
			readonly intent: QueryIntent;
	  }
	| {
			readonly kind: 'mutation';
			readonly bundle: CompiledNqlQuery;
			readonly intent: MutationIntent;
	  };

function hasNqlBindings(bundle: CompiledNqlQuery): boolean {
	return (bundle.bindings?.size ?? 0) > 0;
}

function isBindingFinalQuery(bundle: CompiledNqlQuery): boolean {
	return (
		bundle.query !== undefined &&
		(bundle.bindings?.has(bundle.query.from) ?? false)
	);
}

function formatBindingRelationPath(path: string | readonly string[]): string {
	return typeof path === 'string' ? path : path.join('.');
}

function findBindingFinalRelationFilter(
	where: WhereIntent,
): string | undefined {
	switch (where.kind) {
		case 'and':
		case 'or':
			for (const condition of where.conditions) {
				const found = findBindingFinalRelationFilter(condition);
				if (found !== undefined) return found;
			}
			return undefined;
		case 'not':
			return findBindingFinalRelationFilter(where.condition);
		case 'relationFilter':
			if (getTrustedNqlRelationFilterFields(where) !== undefined) {
				return undefined;
			}
			return formatBindingRelationPath(where.relation);
		case 'exists':
		case 'notExists':
			return where.relation;
		case 'rawExists':
		case 'rawNotExists':
			return 'raw EXISTS';
		default:
			return undefined;
	}
}

function bindingFinalIncludeError(
	bindingName: string,
	relation: string,
	reason: string,
): Error {
	return new Error(
		`NQL binding-final query '${bindingName}' cannot use relation include '${relation}' (ref-#192): ${reason}.`,
	);
}

function getBindingRelationMetadata(
	bundle: CompiledNqlQuery,
	bindingName: string,
): NqlBindingRelationFilterMetadata | undefined {
	return bundle.bindingOutputSchemas?.get(bindingName)?.relationFilters;
}

function getScalarBindingRelationsByName(
	bundle: CompiledNqlQuery,
	bindingName: string,
): Map<string, NqlBindingVirtualRelation> {
	const metadata = getBindingRelationMetadata(bundle, bindingName);
	const relations = new Map<string, NqlBindingVirtualRelation>();
	for (const relation of metadata?.scalarRelations ?? []) {
		relations.set(relation.relation, relation);
	}
	return relations;
}

function bindingIncludeNodeShape(
	include: IncludeIntent,
): NqlBindingIncludeNodeShape {
	return include as unknown as NqlBindingIncludeNodeShape;
}

function virtualRelationIncludeShape(
	relation: NqlBindingVirtualRelation,
): NqlBindingIncludeRelationShape {
	const relationType = relation.relationType;
	const foreignKey =
		relationType === 'belongsTo'
			? relation.sourceColumn
			: relationType === 'hasOne' || relationType === 'hasMany'
				? relation.targetColumn
				: undefined;
	return {
		type: relationType,
		foreignKey,
		source: relation.sourceTable,
		target: relation.targetTable,
		...(relation.through !== undefined && { through: relation.through }),
		...(relation.throughTargetColumn !== undefined && {
			otherKey: relation.throughTargetColumn,
		}),
	};
}

const BINDING_INCLUDE_NODE_ONLY_RELATION: NqlBindingIncludeRelationShape = {
	type: 'hasMany',
	foreignKey: '__dbsp_binding_include_node__',
	source: '__dbsp_binding_include_source__',
	target: '__dbsp_binding_include_target__',
};

function assertSupportedBindingIncludeNodeShape(
	bindingName: string,
	rootIncludeRelation: string,
	include: IncludeIntent,
	reasonPrefix = '',
): void {
	const unsupportedReason = explainUnsupportedNqlBindingIncludeHop(
		include.relation,
		BINDING_INCLUDE_NODE_ONLY_RELATION,
		bindingIncludeNodeShape(include),
	);
	if (unsupportedReason) {
		throw bindingFinalIncludeError(
			bindingName,
			rootIncludeRelation,
			`${reasonPrefix}${unsupportedReason}`,
		);
	}
}

function bindingIncludeCoversRelationPath(
	include: IncludeIntent,
	segments: readonly string[],
): boolean {
	const [head, ...tail] = segments;
	if (!head || include.relation !== head) return false;
	if (tail.length === 0) return true;
	return (include.include ?? []).some((child) =>
		bindingIncludeCoversRelationPath(child, tail),
	);
}

function bindingIncludesCoverRelationPath(
	includes: readonly IncludeIntent[] | undefined,
	relationPath: string,
): boolean {
	const segments = relationPath.split('.');
	if (segments.some((segment) => segment.length === 0)) return false;
	return (includes ?? []).some((include) =>
		bindingIncludeCoversRelationPath(include, segments),
	);
}

function trustedBindingRelationColumnIsAdmitted(
	column: Extract<
		NonNullable<QueryIntent['select']>,
		{ readonly type: 'expressions' }
	>['columns'][number],
): boolean {
	if (column.kind !== 'relationColumn') return false;
	const trusted = getTrustedNqlRelationFilterFields(column);
	if (trusted?.selectedColumn === undefined) return false;
	const isDotted = column.relation.split('.').length > 1;
	if (trusted.cardinality === 'one') {
		return !isDotted || trusted.hops.length > 0;
	}
	const hasCompleteManyToManyProof =
		(trusted.relationType === 'manyToMany' ||
			trusted.relationType === 'belongsToMany') &&
		trusted.through !== undefined &&
		trusted.throughSourceColumn !== undefined &&
		trusted.throughTargetColumn !== undefined;
	return (
		trusted.cardinality === 'many' &&
		(trusted.relationType === 'hasMany' || hasCompleteManyToManyProof) &&
		!isDotted &&
		trusted.hops.length === 0
	);
}

function assertProvenBindingInclude(
	bindingName: string,
	include: IncludeIntent,
	provenRelations: ReadonlyMap<string, NqlBindingVirtualRelation>,
): NqlBindingVirtualRelation {
	const proven = provenRelations.get(include.relation);
	if (!proven) {
		throw bindingFinalIncludeError(
			bindingName,
			include.relation,
			'the relation is not in the binding proven virtual-relation set',
		);
	}
	const unsupportedReason = explainUnsupportedNqlBindingIncludeHop(
		include.relation,
		virtualRelationIncludeShape(proven),
		bindingIncludeNodeShape(include),
	);
	if (unsupportedReason) {
		throw bindingFinalIncludeError(
			bindingName,
			include.relation,
			unsupportedReason,
		);
	}
	return proven;
}

function getProvenBindingIncludes(
	intent: QueryIntent,
	bundle: CompiledNqlQuery,
): Map<string, NqlBindingVirtualRelation> {
	const provenRelations = getScalarBindingRelationsByName(bundle, intent.from);
	const provenIncludes = new Map<string, NqlBindingVirtualRelation>();
	for (const include of intent.include ?? []) {
		const proven = assertProvenBindingInclude(
			intent.from,
			include,
			provenRelations,
		);
		provenIncludes.set(include.relation, proven);
	}
	return provenIncludes;
}

function assertBindingFinalQueryCanUseSyntheticPlan(
	intent: QueryIntent,
	bundle: CompiledNqlQuery,
): void {
	getProvenBindingIncludes(intent, bundle);
	const relationColumns =
		intent.select?.type === 'expressions'
			? intent.select.columns.flatMap((column) => {
					if (column.kind !== 'relationColumn') return [];
					if (
						column.column === '*' &&
						bindingIncludesCoverRelationPath(intent.include, column.relation)
					) {
						return [];
					}
					if (trustedBindingRelationColumnIsAdmitted(column)) {
						return [];
					}
					return [column.relation];
				})
			: [];
	const relationFilter = intent.where
		? findBindingFinalRelationFilter(intent.where)
		: undefined;
	const havingRelationFilter = intent.having
		? findBindingFinalRelationFilter(intent.having)
		: undefined;
	if (
		relationColumns.length > 0 ||
		(intent.joins?.length ?? 0) > 0 ||
		relationFilter !== undefined ||
		havingRelationFilter !== undefined
	) {
		throw new Error(
			`NQL binding-final query '${intent.from}' cannot select relation columns, use includes, joins, or relation filters. Relation planning requires a physical model table, not a CTE binding.`,
		);
	}
}

function createBindingIncludeDecision(
	intent: QueryIntent,
	include: IncludeIntent,
	relation: NqlBindingVirtualRelation,
	index: number,
	model: ModelIR,
): PlanDecision {
	const relationType = relation.relationType as
		| 'belongsTo'
		| 'hasOne'
		| 'hasMany';
	const foreignKey =
		relationType === 'belongsTo'
			? relation.sourceColumn
			: relation.targetColumn;
	const parentKey =
		relationType === 'belongsTo'
			? relation.targetColumn
			: relation.sourceColumn;
	const targetTable = model.getTable(relation.targetTable);
	const targetOrder = targetTable
		? resolveJsonAggOrderKey(targetTable)
		: undefined;

	return {
		id: `binding-include-${index}`,
		type: 'include-strategy',
		context: {
			sourceTable: intent.from,
			target: relation.targetTable,
			relation: relation.relation,
			relationType,
			foreignKey,
			parentKey,
			...(targetOrder &&
				targetOrder.columns.length > 0 && {
					targetOrderKey: targetOrder.columns,
				}),
			...(targetOrder?.fallback && { orderByFallback: true }),
			includeAlias: include.relation,
			intentPath: `include[${index}]`,
		},
		choice: 'json_agg',
		reasoning:
			'NQL binding-final include uses proven binding virtual relation metadata and the json_agg include pipeline.',
		alternatives: [],
	};
}

function findModelRelation(
	model: ModelIR,
	sourceTable: string,
	relationName: string,
): RelationIR | undefined {
	return (
		model.getRelation(`${sourceTable}.${relationName}`) ??
		model
			.getRelationsFrom(sourceTable)
			.find((relation) => relation.name === relationName)
	);
}

function parentKeyForRelation(relation: RelationIR): ColumnListInput {
	if (relation.type === 'belongsTo') return relation.targetKey;
	return relation.sourceKey;
}

function assertSupportedBindingIncludeHop(
	bindingName: string,
	rootIncludeRelation: string,
	relationName: string,
	relation: NqlBindingIncludeRelationShape,
	include: IncludeIntent,
	reasonPrefix = '',
): void {
	const unsupportedReason = explainUnsupportedNqlBindingIncludeHop(
		relationName,
		relation,
		bindingIncludeNodeShape(include),
	);
	if (unsupportedReason) {
		throw bindingFinalIncludeError(
			bindingName,
			rootIncludeRelation,
			`${reasonPrefix}${unsupportedReason}`,
		);
	}
}

function assertSupportedBindingTailIncludeTree(
	bindingName: string,
	rootInclude: IncludeIntent,
	sourceTable: string,
	includes: readonly IncludeIntent[],
	model: ModelIR,
): void {
	for (const include of includes) {
		assertSupportedBindingIncludeNodeShape(
			bindingName,
			rootInclude.relation,
			include,
			'tail ',
		);
		const relation = findModelRelation(model, sourceTable, include.relation);
		if (!relation) {
			throw bindingFinalIncludeError(
				bindingName,
				rootInclude.relation,
				`tail relation '${include.relation}' is not declared on table '${sourceTable}'`,
			);
		}
		assertSupportedBindingIncludeHop(
			bindingName,
			rootInclude.relation,
			include.relation,
			relation,
			include,
			'tail ',
		);
		assertSupportedBindingTailIncludeTree(
			bindingName,
			rootInclude,
			relation.target,
			include.include ?? [],
			model,
		);
	}
}

function rebaseBindingTailIntentPath(
	intentPath: string | undefined,
	includeIndex: number,
): string {
	return `include[${includeIndex}]${intentPath ? `.${intentPath}` : ''}`;
}

function createBindingTailIncludeDecisions(
	bindingName: string,
	include: IncludeIntent,
	firstHopRelation: NqlBindingVirtualRelation,
	includeIndex: number,
	model: ModelIR,
): PlanDecision[] {
	const nestedIncludes = include.include ?? [];
	if (nestedIncludes.length === 0) return [];
	assertSupportedBindingTailIncludeTree(
		bindingName,
		include,
		firstHopRelation.targetTable,
		nestedIncludes,
		model,
	);

	const tailPlan = executePlan(
		{
			type: 'select',
			from: firstHopRelation.targetTable,
			include: nestedIncludes,
		},
		model,
		{ defaultIncludeStrategy: 'json_agg' },
	);

	return tailPlan.decisions
		.filter((decision) => decision.type === 'include-strategy')
		.map((decision, tailIndex) => {
			const sourceTable = decision.context.sourceTable;
			const relationName = decision.context.relation;
			if (!relationName) {
				throw bindingFinalIncludeError(
					bindingName,
					include.relation,
					'tail include planning produced a decision without a relation name',
				);
			}
			const relation = findModelRelation(model, sourceTable, relationName);
			if (!relation) {
				throw bindingFinalIncludeError(
					bindingName,
					include.relation,
					`tail relation '${relationName}' is not declared on table '${sourceTable}'`,
				);
			}
			assertSupportedBindingIncludeHop(
				bindingName,
				include.relation,
				relationName,
				relation,
				{ relation: relationName },
				'tail ',
			);
			const baseContext = { ...decision.context };
			delete (baseContext as { foreignKey?: unknown }).foreignKey;
			delete (baseContext as { parentKey?: unknown }).parentKey;
			delete (baseContext as { targetOrderKey?: unknown }).targetOrderKey;
			delete (baseContext as { orderByFallback?: unknown }).orderByFallback;
			const parentKey = parentKeyForRelation(relation);
			const targetTable = model.getTable(relation.target);
			const targetOrder = targetTable
				? resolveJsonAggOrderKey(targetTable)
				: undefined;
			return {
				...decision,
				id: `binding-include-${includeIndex}-tail-${tailIndex}`,
				choice: 'json_agg',
				reasoning:
					'NQL binding-final tail include uses real-table relation metadata and is forced through the json_agg include pipeline.',
				context: {
					...baseContext,
					sourceTable: relation.source,
					target: relation.target,
					relation: relation.name,
					relationType: relation.type,
					...(relation.foreignKey !== undefined && {
						foreignKey: relation.foreignKey,
					}),
					// Leave parentKey absent when RelationIR does not specify it so the
					// adapter applies the same defaultPkColumnName fallback as real-table includes.
					...(parentKey !== undefined && { parentKey }),
					...(targetOrder &&
						targetOrder.columns.length > 0 && {
							targetOrderKey: targetOrder.columns,
						}),
					...(targetOrder?.fallback && { orderByFallback: true }),
					intentPath: rebaseBindingTailIntentPath(
						decision.context.intentPath,
						includeIndex,
					),
				},
			};
		});
}

function createBindingFinalPlan(
	intent: QueryIntent,
	bundle: CompiledNqlQuery,
	model: ModelIR,
	dialectCapabilities?: DialectCapabilities,
): PlanReport {
	assertBindingFinalQueryCanUseSyntheticPlan(intent, bundle);
	const provenIncludes = getProvenBindingIncludes(intent, bundle);
	const decisions = (intent.include ?? []).flatMap((include, index) => {
		if (dialectCapabilities?.supportsJsonAgg === false) {
			throw bindingFinalIncludeError(
				intent.from,
				include.relation,
				'JSON aggregation for binding includes is not supported by this adapter',
			);
		}
		const proven = provenIncludes.get(include.relation);
		if (!proven) {
			throw bindingFinalIncludeError(
				intent.from,
				include.relation,
				'include relation proof was not emitted by the binding compiler',
			);
		}
		const firstHopDecision = createBindingIncludeDecision(
			intent,
			include,
			proven,
			index,
			model,
		);
		return [
			firstHopDecision,
			...createBindingTailIncludeDecisions(
				intent.from,
				include,
				proven,
				index,
				model,
			),
		];
	});
	return {
		rootTable: intent.from,
		decisions,
		warnings: [],
		ctes: [],
		intent,
		metadata: {
			planningTimeMs: 0,
			relationsAnalyzed: 0,
			isAmbiguous: false,
		},
	};
}

function bindingFinalPlanHasJsonAggIncludes(planReport: PlanReport): boolean {
	return planReport.decisions.some(
		(decision) =>
			decision.type === 'include-strategy' && decision.choice === 'json_agg',
	);
}

/**
 * Mark a trusted fragment to splice verbatim into an NQL template.
 *
 * Never pass untrusted input to this function.
 *
 * @public
 */
export function nqlRaw(fragment: string): NqlRawFragment {
	if (typeof fragment !== 'string') {
		throw new TypeError('nqlRaw() expects a string fragment');
	}

	const raw = { fragment } as RuntimeNqlRawFragment;
	Object.defineProperty(raw, NQL_RAW_FRAGMENT, {
		value: true,
		enumerable: false,
	});
	return Object.freeze(raw);
}

function isNqlRawFragment(value: unknown): value is NqlRawFragment {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	if (!Object.hasOwn(value, NQL_RAW_FRAGMENT)) {
		return false;
	}
	return (
		(value as Record<typeof NQL_RAW_FRAGMENT, unknown>)[NQL_RAW_FRAGMENT] ===
		true
	);
}

function isInsideGeneratedRange(
	start: number,
	end: number,
	generatedRanges: readonly GeneratedParamRange[],
): boolean {
	return generatedRanges.some(
		(range) => start >= range.start && end <= range.end,
	);
}

function findOverlappingGeneratedRange(
	start: number,
	end: number,
	generatedRanges: readonly GeneratedParamRange[],
): GeneratedParamRange | undefined {
	return generatedRanges.find(
		(range) => start < range.end && end > range.start,
	);
}

function findExactGeneratedRange(
	name: string,
	start: number,
	end: number,
	generatedRanges: readonly GeneratedParamRange[],
): GeneratedParamRange | undefined {
	return generatedRanges.find(
		(range) =>
			range.name === name && range.start === start && range.end === end,
	);
}

function generatedParamLexError(name: string): string {
	return `Generated NQL parameter :${name} was not recognized as exactly one NamedParam token after raw-fragment assembly; check adjacent nqlRaw() fragments for quotes, comments, or identifier text that can swallow the placeholder.`;
}

function findInternalParamSourceError(
	query: string,
	generatedRanges: readonly GeneratedParamRange[],
): string | undefined {
	const lexResult = NqlLexer.tokenize(query);
	const generatedTokenCounts = new Map<string, number>(
		generatedRanges.map((range) => [range.name, 0]),
	);

	for (const token of lexResult.tokens) {
		if (token.tokenType.name !== 'NamedParam') {
			continue;
		}

		const name = token.image.slice(1);
		if (!name.startsWith('__p')) {
			continue;
		}

		const start = token.startOffset;
		const end = (token.endOffset ?? start + token.image.length - 1) + 1;
		const exactGeneratedRange = findExactGeneratedRange(
			name,
			start,
			end,
			generatedRanges,
		);
		if (exactGeneratedRange) {
			generatedTokenCounts.set(
				exactGeneratedRange.name,
				(generatedTokenCounts.get(exactGeneratedRange.name) ?? 0) + 1,
			);
			continue;
		}

		const overlappingGeneratedRange = findOverlappingGeneratedRange(
			start,
			end,
			generatedRanges,
		);
		if (overlappingGeneratedRange) {
			return generatedParamLexError(overlappingGeneratedRange.name);
		}

		if (!isInsideGeneratedRange(start, end, generatedRanges)) {
			return `Reserved NQL parameter namespace "__p" cannot be referenced by user source (${token.image}).`;
		}
	}

	for (const range of generatedRanges) {
		if (generatedTokenCounts.get(range.name) !== 1) {
			return generatedParamLexError(range.name);
		}
	}

	return undefined;
}

function assembleNqlTemplate(
	strings: TemplateStringsArray,
	values: readonly unknown[],
): AssembledNqlTemplate {
	const params = Object.create(null) as Record<string, unknown>;
	const generatedRanges: GeneratedParamRange[] = [];
	let query = strings[0] ?? '';
	let boundIndex = 0;

	for (let i = 0; i < values.length; i++) {
		const value = values[i];
		if (isNqlRawFragment(value)) {
			query += value.fragment;
		} else {
			const name = `__p${boundIndex++}`;
			const placeholder = `:${name}`;
			const start = query.length;
			query += placeholder;
			generatedRanges.push({ name, start, end: start + placeholder.length });
			params[name] = value;
		}
		query += strings[i + 1] ?? '';
	}

	return {
		query,
		params,
		hasBoundParams: boundIndex > 0,
		sourceError: findInternalParamSourceError(query, generatedRanges),
	};
}

function hasMutationBindingBodies(bundle: CompiledNqlQuery): boolean {
	return (bundle.mutationBindings?.size ?? 0) > 0;
}

function hasSnapshotReadBindingSteps(bundle: CompiledNqlQuery): boolean {
	return (
		bundle.nqlProgramSequence?.some(
			(step) => step.kind === 'query' && step.snapshot === true,
		) ?? false
	);
}

function hasExecutableNqlProgramSequence(bundle: CompiledNqlQuery): boolean {
	return (
		hasMutationBindingBodies(bundle) || hasSnapshotReadBindingSteps(bundle)
	);
}

function requireMutationBindingColumns(
	bundle: CompiledNqlQuery,
	bindName: string,
): readonly string[] {
	const columns = bundle.bindingOutputSchemas?.get(bindName)?.columns;
	if (columns === undefined || columns.length === 0) {
		throw new Error(
			`NQL mutation binding '${bindName}' cannot be materialized because its projected column schema is unavailable.`,
		);
	}
	return columns;
}

function toSnakeCaseIdentifier(identifier: string): string {
	if (!identifier) return identifier;

	const leadingUnderscores = identifier.match(/^_+/)?.[0] ?? '';
	const rest = identifier.slice(leadingUnderscores.length);
	if (!rest) return identifier;

	const snakeCase = rest
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
		.toLowerCase();

	return leadingUnderscores + snakeCase;
}

function toDatabaseColumnName(column: string, dbCasing?: DbCasing): string {
	return dbCasing === 'snake_case' ? toSnakeCaseIdentifier(column) : column;
}

function toRuntimeBindingRow(
	bindName: string,
	row: unknown,
	columns: readonly string[],
	dbCasing?: DbCasing,
): Readonly<Record<string, unknown>> {
	if (typeof row !== 'object' || row === null || Array.isArray(row)) {
		throw new Error(
			`NQL mutation binding '${bindName}' returned a non-object row; runtime VALUES materialization requires object rows keyed by projected column name.`,
		);
	}
	const source = row as Record<string, unknown>;
	const materialized: Record<string, unknown> = {};
	for (const column of columns) {
		const dbColumn = toDatabaseColumnName(column, dbCasing);
		const sourceColumn = Object.hasOwn(source, column)
			? column
			: dbColumn !== column && Object.hasOwn(source, dbColumn)
				? dbColumn
				: undefined;
		if (sourceColumn === undefined) {
			throw new Error(
				`NQL mutation binding '${bindName}' returned a row without projected column '${column}'.`,
			);
		}
		materialized[column] = source[sourceColumn];
	}
	return materialized;
}

function createRuntimeBinding(
	bundle: CompiledNqlQuery,
	bindName: string,
	rows: readonly unknown[],
	dbCasing?: DbCasing,
): NqlRuntimeBinding {
	const columns = requireMutationBindingColumns(bundle, bindName);
	return {
		columns,
		rows: rows.map((row) =>
			toRuntimeBindingRow(bindName, row, columns, dbCasing),
		),
	};
}

type NqlProgramStep =
	| {
			readonly kind: 'query';
			readonly intent: QueryIntent;
			readonly bindName?: string;
			readonly final: boolean;
			readonly snapshot?: true;
			readonly bindingDependencies?: readonly string[];
	  }
	| {
			readonly kind: 'mutation';
			readonly intent: MutationIntent;
			readonly bindName?: string;
			readonly final: boolean;
			readonly bindingDependencies?: readonly string[];
	  };

type NqlMutationStatementResult = {
	readonly rawRows: unknown[];
	readonly transformedRows: unknown[];
};

type NqlMutationStatementExecution = NqlMutationStatementResult & {
	readonly hookRows: unknown[];
};

type NqlProgramSequenceStepWithDependencies = NonNullable<
	CompiledNqlQuery['nqlProgramSequence']
>[number] & {
	readonly bindingDependencies?: readonly string[];
};

function bindingEntryIsFinal(
	compiledIntent: CompiledNqlIntent,
	bindName: string,
	boundQuery: QueryIntent,
	sourceBundle: CompiledNqlQuery,
): boolean {
	if (compiledIntent.kind === 'query') {
		return boundQuery === compiledIntent.intent;
	}
	return sourceBundle.mutationBindings?.get(bindName) === compiledIntent.intent;
}

function orderedSequenceStepToProgramStep(
	step: NonNullable<CompiledNqlQuery['nqlProgramSequence']>[number],
): NqlProgramStep {
	const dependencyStep = step as NqlProgramSequenceStepWithDependencies;
	if (step.kind === 'query') {
		return {
			kind: 'query',
			intent: step.query as QueryIntent,
			...(step.bindName !== undefined && { bindName: step.bindName }),
			final: step.final,
			...(step.snapshot === true && { snapshot: true }),
			...(dependencyStep.bindingDependencies !== undefined && {
				bindingDependencies: dependencyStep.bindingDependencies,
			}),
		};
	}
	return {
		kind: 'mutation',
		intent: step.mutation as MutationIntent,
		...(step.bindName !== undefined && { bindName: step.bindName }),
		final: step.final,
		...(dependencyStep.bindingDependencies !== undefined && {
			bindingDependencies: dependencyStep.bindingDependencies,
		}),
	};
}

const structuredCloneFn = (
	globalThis as {
		readonly structuredClone?: (value: unknown) => unknown;
	}
).structuredClone;

/**
 * Snapshot mutation RETURNING rows before afterMutation hooks can mutate them.
 *
 * The residual contract is per top-level column value: plain data
 * (objects/arrays/JSON values/Date/Map/Set) is deep-copied with
 * structuredClone, while values with a custom prototype are preserved by
 * reference. If structuredClone is unavailable or rejects a value, that value is
 * preserved by reference.
 */
function hasCustomSnapshotPrototype(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		prototype !== Object.prototype &&
		prototype !== null &&
		prototype !== Array.prototype &&
		prototype !== Date.prototype &&
		prototype !== Map.prototype &&
		prototype !== Set.prototype
	);
}

function cloneMutationSnapshotColumnValue(value: unknown): unknown {
	if (hasCustomSnapshotPrototype(value) || structuredCloneFn === undefined) {
		return value;
	}
	try {
		return structuredCloneFn(value);
	} catch {
		return value;
	}
}

function snapshotMutationRows(rows: readonly unknown[]): unknown[] {
	return rows.map((row) => {
		if (row === null || typeof row !== 'object') {
			return cloneMutationSnapshotColumnValue(row);
		}
		const snapshot = { ...(row as Record<PropertyKey, unknown>) } as Record<
			PropertyKey,
			unknown
		>;
		for (const key of Reflect.ownKeys(snapshot)) {
			snapshot[key] = cloneMutationSnapshotColumnValue(snapshot[key]);
		}
		return snapshot;
	});
}

function assertNqlProgramSteps(
	compiledIntent: CompiledNqlIntent,
	steps: readonly NqlProgramStep[],
): void {
	if (steps.length === 0) {
		throw new Error('NQL program sequence did not contain any statements.');
	}
	const finalIndexes = steps
		.map((step, index) => (step.final ? index : -1))
		.filter((index) => index !== -1);
	if (finalIndexes.length !== 1 || finalIndexes[0] !== steps.length - 1) {
		throw new Error(
			'NQL program sequence must contain exactly one final statement at the end.',
		);
	}
	const finalStep = steps.at(-1);
	if (finalStep === undefined) {
		throw new Error('NQL program sequence did not contain a final statement.');
	}
	if (
		finalStep.kind !== compiledIntent.kind ||
		finalStep.intent !== compiledIntent.intent
	) {
		throw new Error(
			'NQL program sequence final statement does not match the compiled NQL result.',
		);
	}
	const seenBindNames = new Set<string>();
	for (const step of steps) {
		if (step.kind === 'query' && step.snapshot === true) {
			if (step.bindName === undefined || step.final) {
				throw new Error(
					'NQL program sequence query snapshots must be named non-final statements.',
				);
			}
		}
		if (step.bindName === undefined) continue;
		if (seenBindNames.has(step.bindName)) {
			throw new Error(
				`NQL program sequence contains duplicate binding '${step.bindName}'.`,
			);
		}
		seenBindNames.add(step.bindName);
		if (!(compiledIntent.bundle.bindings?.has(step.bindName) ?? false)) {
			throw new Error(
				`NQL program sequence references unknown binding '${step.bindName}'.`,
			);
		}
	}
}

function createNqlProgramSteps(
	compiledIntent: CompiledNqlIntent,
): readonly NqlProgramStep[] {
	const sourceBundle = compiledIntent.bundle;
	if (sourceBundle.nqlProgramSequence !== undefined) {
		const steps = sourceBundle.nqlProgramSequence.map(
			orderedSequenceStepToProgramStep,
		);
		assertNqlProgramSteps(compiledIntent, steps);
		return steps;
	}

	const bindingEntries = [...(sourceBundle.bindings ?? new Map())];
	const steps: NqlProgramStep[] = bindingEntries.map(
		([bindName, boundQuery]) => {
			const boundMutation = sourceBundle.mutationBindings?.get(bindName);
			if (boundMutation !== undefined) {
				return {
					kind: 'mutation',
					intent: boundMutation as MutationIntent,
					bindName,
					final: false,
				};
			}
			return {
				kind: 'query',
				intent: boundQuery as QueryIntent,
				bindName,
				final: false,
			};
		},
	);

	const lastBindingEntry = bindingEntries.at(-1);
	const finalIsBound =
		lastBindingEntry !== undefined &&
		bindingEntryIsFinal(
			compiledIntent,
			lastBindingEntry[0],
			lastBindingEntry[1] as QueryIntent,
			sourceBundle,
		);

	if (finalIsBound) {
		const lastStep = steps.at(-1);
		if (lastStep === undefined) return steps;
		steps[steps.length - 1] = { ...lastStep, final: true };
		return steps;
	}

	if (compiledIntent.kind === 'query') {
		steps.push({
			kind: 'query',
			intent: compiledIntent.intent,
			final: true,
		});
	} else {
		steps.push({
			kind: 'mutation',
			intent: compiledIntent.intent,
			final: true,
		});
	}
	assertNqlProgramSteps(compiledIntent, steps);
	return steps;
}

function renumberDumpSqlParams(sql: string, offset: number): string {
	if (offset === 0) return sql;
	return sql.replace(/\$(\d+)/g, (_match, num) => {
		return `$${Number.parseInt(num, 10) + offset}`;
	});
}

function joinDumpSequenceSql(sequence: readonly DumpSequenceStep[]): string {
	let parameterOffset = 0;
	return sequence
		.map((step) => {
			const sql = renumberDumpSqlParams(step.sql, parameterOffset);
			parameterOffset += step.params.length;
			return sql;
		})
		.join(';\n');
}

function flattenDumpSequenceParams(
	sequence: readonly DumpSequenceStep[],
): readonly unknown[] {
	return sequence.flatMap((step) => [...step.params]);
}

function filterMapByBindingDependencies<T>(
	source: ReadonlyMap<string, T> | undefined,
	bindingDependencies: readonly string[] | undefined,
): Map<string, T> {
	if (source === undefined) return new Map();
	if (bindingDependencies === undefined) return new Map(source);
	const filtered = new Map<string, T>();
	for (const bindName of bindingDependencies) {
		const value = source.get(bindName);
		if (value !== undefined) {
			filtered.set(bindName, value);
		}
	}
	return filtered;
}

function filterOptionalMapByBindingDependencies<T>(
	source: ReadonlyMap<string, T> | undefined,
	bindingDependencies: readonly string[] | undefined,
): ReadonlyMap<string, T> | undefined {
	const filtered = filterMapByBindingDependencies(source, bindingDependencies);
	return filtered.size > 0 ? filtered : undefined;
}

function runtimeSourceBindingNames(
	sourceBundle: CompiledNqlQuery,
): ReadonlySet<string> | undefined {
	const names = new Set<string>();
	for (const name of sourceBundle.mutationBindings?.keys() ?? []) {
		names.add(name);
	}
	for (const step of sourceBundle.nqlProgramSequence ?? []) {
		if (
			step.kind === 'query' &&
			step.snapshot === true &&
			step.bindName !== undefined
		) {
			names.add(step.bindName);
		}
	}
	return names.size > 0 ? names : undefined;
}

// Inline read bindings are cheap SQL CTEs and remain always-emitted; bindings
// materialized into runtime VALUES rows are dependency-filtered.
function filterMapByRuntimeBindingDependencies<T>(
	source: ReadonlyMap<string, T> | undefined,
	runtimeSourceBindings: ReadonlySet<string> | undefined,
	bindingDependencies: readonly string[] | undefined,
): Map<string, T> {
	if (source === undefined) return new Map();
	if (
		bindingDependencies === undefined ||
		runtimeSourceBindings === undefined ||
		runtimeSourceBindings.size === 0
	) {
		return new Map(source);
	}

	const dependencies = new Set(bindingDependencies);
	const filtered = new Map<string, T>();
	for (const [bindName, value] of source) {
		if (!runtimeSourceBindings.has(bindName) || dependencies.has(bindName)) {
			filtered.set(bindName, value);
		}
	}
	return filtered;
}

function filterOptionalMapByNames<T>(
	source: ReadonlyMap<string, T> | undefined,
	names: Iterable<string>,
): ReadonlyMap<string, T> | undefined {
	if (source === undefined) return undefined;
	const filtered = new Map<string, T>();
	for (const name of names) {
		const value = source.get(name);
		if (value !== undefined) {
			filtered.set(name, value);
		}
	}
	return filtered.size > 0 ? filtered : undefined;
}

/**
 * Create an NQL template tag function.
 *
 * Each non-raw `${value}` in the template is bound as a generated named param.
 * Use `nqlRaw()` only for trusted dynamic NQL structure.
 *
 * @param schemaDefinition - Schema definition for validation
 * @param model - ModelIR for plan execution
 * @param adapter - Optional adapter for query execution
 * @param schemaName - Optional schema name for multi-tenant queries
 * @returns NQL template tag function
 */
export function createNqlTag(
	_schemaDefinition: unknown,
	model: ModelIR,
	adapter?: Adapter<unknown>,
	schemaName?: string,
	hookStore?: HookStore,
	onHookError?: HookErrorHandler,
	inTransaction?: boolean,
): NqlTag {
	return function nql<T>(
		strings: TemplateStringsArray,
		...values: unknown[]
	): NqlBuilder<T> {
		const assembled = assembleNqlTemplate(strings, values);

		return new NqlBuilderImpl<T>(
			assembled.query,
			assembled.params,
			assembled.hasBoundParams,
			assembled.sourceError,
			model,
			adapter,
			schemaName,
			hookStore,
			onHookError,
			inTransaction,
		);
	};
}

/**
 * NQL builder implementation.
 * @internal
 */
class NqlBuilderImpl<T> implements NqlBuilder<T> {
	private _compiled: CompiledNqlIntent | undefined;
	private readonly query: string;
	private readonly params: Readonly<Record<string, unknown>>;
	private readonly hasBoundParams: boolean;
	private readonly sourceError: string | undefined;
	private readonly model: ModelIR;
	private readonly _schemaName: string | undefined;
	private readonly adapter: Adapter<unknown> | undefined;
	private readonly hookStore: HookStore | undefined;
	private readonly onHookError: HookErrorHandler | undefined;
	private readonly inTransaction: boolean | undefined;

	constructor(
		query: string,
		params: Readonly<Record<string, unknown>>,
		hasBoundParams: boolean,
		sourceError: string | undefined,
		model: ModelIR,
		adapter: Adapter<unknown> | undefined,
		schemaName: string | undefined,
		hookStore: HookStore | undefined,
		onHookError: HookErrorHandler | undefined,
		inTransaction: boolean | undefined,
	) {
		this.query = query;
		this.params = params;
		this.hasBoundParams = hasBoundParams;
		this.sourceError = sourceError;
		this.model = model;
		this.adapter = adapter;
		this._schemaName = schemaName;
		this.hookStore = hookStore;
		this.onHookError = onHookError;
		this.inTransaction = inTransaction;
	}

	private compile(): CompiledNqlIntent {
		if (this._compiled) {
			return this._compiled;
		}

		if (this.sourceError !== undefined) {
			throw new Error(`NQL compilation failed: ${this.sourceError}`);
		}

		// Extract dynamic pseudo-column keywords from model configuration
		const compilerOptions = {
			...(extractPseudoColumnKeywords(this.model) ?? {}),
			params: this.params,
			[NQL_INTERNAL_COMPILER_OPTIONS]: { allowInternalParams: true },
		} satisfies NqlCompilerOptions & {
			readonly [NQL_INTERNAL_COMPILER_OPTIONS]: {
				readonly allowInternalParams: true;
			};
		};

		// Use integrated @dbsp/nql compiler with dynamic keywords
		const result = nqlCompile(
			this.query,
			this.model,
			undefined,
			compilerOptions,
		);
		if (!result.success) {
			const errors =
				result.errors?.map((e) => e.message).join(', ') ?? 'Unknown error';
			const rawHint = this.hasBoundParams
				? ' If an interpolation was intended as NQL structure, wrap a trusted fragment with nqlRaw().'
				: '';
			throw new Error(`NQL compilation failed: ${errors}${rawHint}`);
		}
		const bundle = result.ast;
		if (!bundle) {
			throw new Error('NQL compilation failed: no query AST produced');
		}
		if (bundle.query) {
			// Type assertion: NQL imports QueryIntent from @dbsp/types (ARCH-007),
			// structurally identical to core's re-export.
			this._compiled = {
				kind: 'query',
				bundle,
				intent: bundle.query as QueryIntent,
			};
			return this._compiled;
		}
		if (bundle.mutation) {
			this._compiled = {
				kind: 'mutation',
				bundle,
				intent: bundle.mutation as MutationIntent,
			};
			return this._compiled;
		}
		throw new Error('NQL compilation failed: no query AST produced');
	}

	toIntentIR(): QueryIntent | MutationIntent {
		return this.compile().intent;
	}

	private planInternal(): PlanReport {
		const compiled = this.compile();
		if (compiled.kind === 'mutation') {
			throw new Error(
				'NQL mutations do not have execution plans; use dump() for SQL and parameters.',
			);
		}
		return executePlan(compiled.intent, this.model);
	}

	plan(): PlanReport {
		const compiled = this.compile();
		if (compiled.kind === 'mutation') {
			throw new Error(
				'NQL mutations do not have execution plans; use dump() for SQL and parameters.',
			);
		}
		return isBindingFinalQuery(compiled.bundle)
			? createBindingFinalPlan(
					compiled.intent,
					compiled.bundle,
					this.model,
					this.adapter?.dialectCapabilities,
				)
			: this.planInternal();
	}

	dump(meta?: DumpMetaInput): Dump | MutationDump {
		const compiledIntent = this.compile();
		if (hasExecutableNqlProgramSequence(compiledIntent.bundle)) {
			return this.dumpNqlProgramSequence(compiledIntent, meta);
		}
		if (compiledIntent.kind === 'mutation') {
			return this.dumpMutation(
				this.createFinalNqlStatementBundle(compiledIntent),
				compiledIntent.intent,
				meta,
			);
		}

		const bindingFinalQuery = isBindingFinalQuery(compiledIntent.bundle);
		const planReport = bindingFinalQuery
			? createBindingFinalPlan(
					compiledIntent.intent,
					compiledIntent.bundle,
					this.model,
					this.adapter?.dialectCapabilities,
				)
			: this.planInternal();

		if (!this.adapter) {
			return {
				plan: planReport,
				sql: '[No adapter - SQL not available]',
				params: [],
				...(meta !== undefined && { meta }),
			};
		}

		const finalBundle = this.createFinalNqlStatementBundle(
			compiledIntent,
			bindingFinalPlanHasJsonAggIncludes(planReport) ? planReport : undefined,
		);
		const compiled =
			bindingFinalQuery || hasNqlBindings(finalBundle)
				? this.adapter.compile<T>(finalBundle, this.nqlBundleCompileOptions())
				: this.adapter.compile<T>(planReport);

		try {
			return this.adapter.createDump(planReport, compiled, meta);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message.toLowerCase().includes('not implemented')
			) {
				// Fallback for mock adapters that don't implement createDump
				const base: Dump = {
					plan: planReport,
					sql: compiled.sql,
					params: compiled.parameters as readonly unknown[],
				};
				if (meta !== undefined) {
					return {
						...base,
						meta: {
							...(meta.queryName !== undefined && {
								queryName: meta.queryName,
							}),
							...(meta.correlationId !== undefined && {
								correlationId: meta.correlationId,
							}),
						},
					};
				}
				return base;
			}
			throw err;
		}
	}

	private requireAdapter(operation: string): Adapter<unknown> {
		if (!this.adapter) {
			throw new ExecutionError({
				operation,
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}
		return this.adapter;
	}

	private mutationCompileOptions(extraOptions?: DumpMetaInput): CompileOptions {
		return {
			model: this.model,
			...(this._schemaName !== undefined && { schemaName: this._schemaName }),
			...extraOptions,
		};
	}

	private nqlBundleCompileOptions(): CompileOptions {
		return {
			model: this.model,
			...(this._schemaName !== undefined && { schemaName: this._schemaName }),
		};
	}

	private createNqlStatementBundle(
		statement:
			| { readonly query: QueryIntent }
			| { readonly mutation: MutationIntent },
		bindings: ReadonlyMap<string, QueryIntent>,
		runtimeBindings: ReadonlyMap<string, NqlRuntimeBinding>,
		sourceBundle: CompiledNqlQuery,
		bindingDependencies?: readonly string[],
		planReport?: PlanReport,
	): CompiledNqlQuery {
		const statementBindings = filterMapByRuntimeBindingDependencies(
			bindings,
			runtimeSourceBindingNames(sourceBundle),
			bindingDependencies,
		);
		const statementRuntimeBindings = filterMapByBindingDependencies(
			runtimeBindings,
			bindingDependencies,
		);
		const emittedBindingNames = new Set([
			...statementBindings.keys(),
			...statementRuntimeBindings.keys(),
		]);
		const statementBindingOutputSchemas = filterOptionalMapByNames(
			sourceBundle.bindingOutputSchemas,
			emittedBindingNames,
		);
		const statementMutationBindings = filterOptionalMapByBindingDependencies(
			sourceBundle.mutationBindings,
			bindingDependencies,
		);
		return {
			...statement,
			...(planReport !== undefined && { plan: planReport }),
			...(statementBindings.size > 0 && { bindings: statementBindings }),
			...(statementBindingOutputSchemas !== undefined && {
				bindingOutputSchemas: statementBindingOutputSchemas,
			}),
			...(statementMutationBindings !== undefined && {
				mutationBindings: statementMutationBindings,
			}),
			...(statementRuntimeBindings.size > 0 && {
				runtimeBindings: statementRuntimeBindings,
			}),
		};
	}

	private createFinalNqlStatementBundle(
		compiledIntent: CompiledNqlIntent,
		planReport?: PlanReport,
	): CompiledNqlQuery {
		const finalStep = createNqlProgramSteps(compiledIntent).at(-1);
		if (compiledIntent.kind === 'query') {
			return this.createNqlStatementBundle(
				{ query: compiledIntent.intent },
				compiledIntent.bundle.bindings ?? new Map(),
				compiledIntent.bundle.runtimeBindings ?? new Map(),
				compiledIntent.bundle,
				finalStep?.bindingDependencies,
				planReport,
			);
		}
		return this.createNqlStatementBundle(
			{ mutation: compiledIntent.intent },
			compiledIntent.bundle.bindings ?? new Map(),
			compiledIntent.bundle.runtimeBindings ?? new Map(),
			compiledIntent.bundle,
			finalStep?.bindingDependencies,
			planReport,
		);
	}

	private runMutationStatement(
		adapter: Adapter<unknown>,
		bundle: CompiledNqlQuery,
		intent: MutationIntent,
		inTransaction: boolean | undefined,
	): Promise<NqlMutationStatementResult> {
		const hasReturning = (intent.returning?.length ?? 0) > 0;
		return runMutationWithHooks<NqlMutationStatementExecution, MutationIntent>({
			table: intent.table,
			intent,
			hookStore: this.hookStore,
			onHookError: this.onHookError,
			schemaName: this._schemaName,
			inTransaction,
			prepare: () => {
				const compiled = adapter.compile<unknown[]>(
					bundle,
					this.mutationCompileOptions(),
				);
				return {
					sql: compiled.sql,
					parameters: compiled.parameters,
					execute: async () => {
						const hookRows = (await adapter.execute(compiled)) as unknown[];
						const rawRows = snapshotMutationRows(hookRows);
						return {
							rawRows,
							hookRows,
							transformedRows: hookRows,
						};
					},
					getAfterMutationResult: (result) =>
						hasReturning ? result.hookRows : [],
					mapAfterMutationResult: (result, transformedRows) => ({
						rawRows: result.rawRows,
						hookRows: result.hookRows,
						transformedRows: [...transformedRows],
					}),
					returnAfterMutationResult: hasReturning,
				};
			},
		});
	}

	private async executeNqlProgramSequence(
		compiledIntent: CompiledNqlIntent,
		adapter: Adapter<unknown>,
	): Promise<T[]> {
		if (!supportsTransactions(adapter)) {
			throw new ExecutionError({
				operation: 'nql',
				reason:
					'NQL programs with mutation bindings require adapter transaction support',
				fix: 'Use an adapter that implements transaction(fn), such as the PostgreSQL adapter.',
			});
		}

		return adapter.transaction(async (txAdapter) => {
			const sourceBundle = compiledIntent.bundle;
			const priorBindings = new Map<string, QueryIntent>();
			const runtimeBindings = new Map<string, NqlRuntimeBinding>();
			const steps = createNqlProgramSteps(compiledIntent);
			let finalRows: unknown[] = [];

			for (const step of steps) {
				if (step.kind === 'mutation') {
					if ((step.intent.returning?.length ?? 0) === 0 && step.bindName) {
						throw new Error(
							`NQL mutation binding '${step.bindName}' cannot execute without a RETURNING projection.`,
						);
					}
					const statementBundle = this.createNqlStatementBundle(
						{ mutation: step.intent },
						priorBindings,
						runtimeBindings,
						sourceBundle,
						step.bindingDependencies,
					);
					const rows = await this.runMutationStatement(
						txAdapter as Adapter<unknown>,
						statementBundle,
						step.intent,
						true,
					);
					if (step.bindName) {
						runtimeBindings.set(
							step.bindName,
							createRuntimeBinding(
								sourceBundle,
								step.bindName,
								rows.rawRows,
								txAdapter.dbCasing,
							),
						);
					}
					if (step.final) {
						finalRows = rows.transformedRows;
					}
				} else if (step.snapshot === true && step.bindName !== undefined) {
					const statementBundle = this.createNqlStatementBundle(
						{ query: step.intent },
						priorBindings,
						runtimeBindings,
						sourceBundle,
						step.bindingDependencies,
					);
					const compiled = txAdapter.compile<unknown[]>(
						statementBundle,
						this.nqlBundleCompileOptions(),
					);
					const rows = await txAdapter.execute(compiled);
					runtimeBindings.set(
						step.bindName,
						createRuntimeBinding(
							sourceBundle,
							step.bindName,
							snapshotMutationRows(rows),
							txAdapter.dbCasing,
						),
					);
				} else if (step.final) {
					const planReport =
						isBindingFinalQuery(compiledIntent.bundle) &&
						compiledIntent.kind === 'query'
							? createBindingFinalPlan(
									step.intent,
									sourceBundle,
									this.model,
									txAdapter.dialectCapabilities,
								)
							: undefined;
					const statementBundle = this.createNqlStatementBundle(
						{ query: step.intent },
						priorBindings,
						runtimeBindings,
						sourceBundle,
						step.bindingDependencies,
						planReport !== undefined &&
							bindingFinalPlanHasJsonAggIncludes(planReport)
							? planReport
							: undefined,
					);
					const compiled = txAdapter.compile<T>(
						statementBundle,
						this.nqlBundleCompileOptions(),
					);
					finalRows = await txAdapter.execute(compiled);
					if (
						planReport !== undefined &&
						bindingFinalPlanHasJsonAggIncludes(planReport)
					) {
						hydrateJsonAggIncludes(finalRows as T[], planReport);
					}
				}

				if (step.bindName) {
					const boundQuery = sourceBundle.bindings?.get(step.bindName);
					if (boundQuery !== undefined) {
						priorBindings.set(step.bindName, boundQuery as QueryIntent);
					}
				}
			}

			return finalRows as T[];
		});
	}

	private dumpNqlProgramSequence(
		compiledIntent: CompiledNqlIntent,
		meta?: DumpMetaInput,
	): Dump | MutationDump {
		const adapter = this.requireAdapter('dump');
		const sourceBundle = compiledIntent.bundle;
		const priorBindings = new Map<string, QueryIntent>();
		const runtimeBindings = new Map<string, NqlRuntimeBinding>();
		const sequence: DumpSequenceStep[] = [];
		const steps = createNqlProgramSteps(compiledIntent);

		for (const step of steps) {
			if (step.kind === 'mutation') {
				const statementBundle = this.createNqlStatementBundle(
					{ mutation: step.intent },
					priorBindings,
					runtimeBindings,
					sourceBundle,
					step.bindingDependencies,
				);
				const compiled = adapter.compile(
					statementBundle,
					this.mutationCompileOptions(),
				);
				sequence.push({
					kind: 'mutation',
					...(step.bindName !== undefined && { bindName: step.bindName }),
					sql: compiled.sql,
					params: compiled.parameters,
				});
				if (step.bindName !== undefined) {
					runtimeBindings.set(step.bindName, {
						columns: requireMutationBindingColumns(sourceBundle, step.bindName),
						rows: [],
					});
				}
			} else {
				const planReport =
					step.final &&
					isBindingFinalQuery(compiledIntent.bundle) &&
					compiledIntent.kind === 'query'
						? createBindingFinalPlan(
								step.intent,
								sourceBundle,
								this.model,
								adapter.dialectCapabilities,
							)
						: undefined;
				const statementBundle = this.createNqlStatementBundle(
					{ query: step.intent },
					priorBindings,
					runtimeBindings,
					sourceBundle,
					step.bindingDependencies,
					planReport !== undefined &&
						bindingFinalPlanHasJsonAggIncludes(planReport)
						? planReport
						: undefined,
				);
				const compiled = adapter.compile(
					statementBundle,
					this.nqlBundleCompileOptions(),
				);
				sequence.push({
					kind: 'query',
					...(step.bindName !== undefined && { bindName: step.bindName }),
					sql: compiled.sql,
					params: compiled.parameters,
				});
				if (step.snapshot === true && step.bindName !== undefined) {
					runtimeBindings.set(step.bindName, {
						columns: requireMutationBindingColumns(sourceBundle, step.bindName),
						rows: [],
					});
				}
			}

			if (step.bindName !== undefined) {
				const boundQuery = sourceBundle.bindings?.get(step.bindName);
				if (boundQuery !== undefined) {
					priorBindings.set(step.bindName, boundQuery as QueryIntent);
				}
			}
		}

		const finalStep = steps.at(-1);
		if (finalStep?.kind === 'query') {
			const planReport = isBindingFinalQuery(compiledIntent.bundle)
				? createBindingFinalPlan(
						finalStep.intent,
						compiledIntent.bundle,
						this.model,
						this.adapter?.dialectCapabilities,
					)
				: this.planInternal();
			const dumpMeta: DumpMeta = {
				compiledAt: new Date(),
				...(this._schemaName !== undefined && { schema: this._schemaName }),
				...(meta?.queryName !== undefined && { queryName: meta.queryName }),
				...(meta?.correlationId !== undefined && {
					correlationId: meta.correlationId,
				}),
			};
			return {
				plan: planReport,
				sql: joinDumpSequenceSql(sequence),
				params: flattenDumpSequenceParams(sequence),
				meta: dumpMeta,
				sequence,
			};
		}
		if (finalStep?.kind !== 'mutation') {
			throw new Error(
				'NQL program sequence did not contain a final statement.',
			);
		}

		const dumpMeta: DumpMeta = {
			compiledAt: new Date(),
			...(this._schemaName !== undefined && { schema: this._schemaName }),
			...(meta?.queryName !== undefined && { queryName: meta.queryName }),
			...(meta?.correlationId !== undefined && {
				correlationId: meta.correlationId,
			}),
		};

		return {
			sql: joinDumpSequenceSql(sequence),
			parameters: flattenDumpSequenceParams(sequence),
			intent: finalStep.intent,
			meta: dumpMeta,
			sequence,
		};
	}

	private dumpMutation(
		bundle: CompiledNqlQuery,
		intent: MutationIntent,
		meta?: DumpMetaInput,
	): MutationDump {
		const adapter = this.requireAdapter('dump');
		const compiled = adapter.compile(bundle, this.mutationCompileOptions(meta));

		const dumpMeta: DumpMeta = {
			compiledAt: new Date(),
			...(this._schemaName !== undefined && { schema: this._schemaName }),
			...(meta?.queryName !== undefined && { queryName: meta.queryName }),
			...(meta?.correlationId !== undefined && {
				correlationId: meta.correlationId,
			}),
		};

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			intent,
			meta: dumpMeta,
		};
	}

	async all(): Promise<T[]> {
		const adapter = this.adapter;
		if (!adapter) {
			throw new Error(
				'Cannot execute query: no adapter configured. ' +
					'Pass an adapter to createOrm() or use .toIntentIR() / .plan() for debugging.',
			);
		}

		const compiledIntent = this.compile();
		if (hasExecutableNqlProgramSequence(compiledIntent.bundle)) {
			return this.executeNqlProgramSequence(compiledIntent, adapter);
		}
		if (compiledIntent.kind === 'mutation') {
			return (
				await this.runMutationStatement(
					adapter,
					this.createFinalNqlStatementBundle(compiledIntent),
					compiledIntent.intent,
					this.inTransaction,
				)
			).transformedRows as T[];
		}

		if (isBindingFinalQuery(compiledIntent.bundle)) {
			const planReport = createBindingFinalPlan(
				compiledIntent.intent,
				compiledIntent.bundle,
				this.model,
				adapter.dialectCapabilities,
			);
			const compiled = adapter.compile<T>(
				this.createFinalNqlStatementBundle(
					compiledIntent,
					bindingFinalPlanHasJsonAggIncludes(planReport)
						? planReport
						: undefined,
				),
				this.nqlBundleCompileOptions(),
			);
			const rows = await adapter.execute(compiled);
			if (bindingFinalPlanHasJsonAggIncludes(planReport)) {
				hydrateJsonAggIncludes(rows, planReport);
			}
			return rows;
		}

		const planReport = this.planInternal();
		const finalBundle = this.createFinalNqlStatementBundle(compiledIntent);
		const compiled = hasNqlBindings(finalBundle)
			? adapter.compile<T>(finalBundle, this.nqlBundleCompileOptions())
			: adapter.compile<T>(planReport);
		return adapter.execute(compiled);
	}

	async run(): Promise<void> {
		await this.all();
	}

	async first(): Promise<T | null> {
		const rows = await this.all();
		return rows[0] ?? null;
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract pseudo-column keywords from model configuration.
 * Collects all configured roles and recursive keywords from all tables'
 * pseudoColumns metadata, falling back to defaults if no configuration exists.
 */
export function extractPseudoColumnKeywords(
	model: ModelIR,
): NqlCompilerOptions | undefined {
	const allKeywords = new Set<string>();
	const recursiveKeywords = new Set<string>();

	for (const table of model.tables.values()) {
		if (!table.pseudoColumns) continue;
		for (const pc of table.pseudoColumns) {
			allKeywords.add(pc.parentRole.toLowerCase());
			allKeywords.add(pc.childRole.toLowerCase());
			allKeywords.add(pc.ascendantKeyword.toLowerCase());
			allKeywords.add(pc.descendantKeyword.toLowerCase());
			recursiveKeywords.add(pc.ascendantKeyword.toLowerCase());
			recursiveKeywords.add(pc.descendantKeyword.toLowerCase());
		}
	}

	// No pseudo-columns configured → let compiler use defaults
	if (allKeywords.size === 0) return undefined;

	return {
		pseudoColumnKeywords: [...allKeywords],
		recursiveKeywords: [...recursiveKeywords],
	};
}
