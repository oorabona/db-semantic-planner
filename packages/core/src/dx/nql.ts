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
	type NqlCompilerOptions,
	NqlLexer,
	compile as nqlCompile,
} from '@dbsp/nql';
import type { Adapter, Dump } from '../adapter.js';
import type { QueryIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';
import { plan as executePlan } from '../planner.js';
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
	/** Execute query and return first result or null */
	first(): Promise<T | null>;
	/** Get the IntentIR for debugging */
	toIntentIR(): QueryIntent;
	/** Get the execution plan */
	plan(): PlanReport;
	/** Get full dump (plan + SQL + params) */
	dump(meta?: DumpMetaInput): Dump;
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
	schemaDefinition: unknown,
	model: ModelIR,
	adapter?: Adapter<unknown>,
	schemaName?: string,
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
			schemaDefinition,
			model,
			adapter,
			schemaName,
		);
	};
}

/**
 * NQL builder implementation.
 * @internal
 */
class NqlBuilderImpl<T> implements NqlBuilder<T> {
	private _intent: QueryIntent | undefined;
	private readonly query: string;
	private readonly params: Readonly<Record<string, unknown>>;
	private readonly hasBoundParams: boolean;
	private readonly sourceError: string | undefined;
	private readonly schemaDefinition: unknown;
	private readonly model: ModelIR;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: Reserved for future schema-scoping support
	private readonly _schemaName: string | undefined;
	private readonly adapter: Adapter<unknown> | undefined;

	constructor(
		query: string,
		params: Readonly<Record<string, unknown>>,
		hasBoundParams: boolean,
		sourceError: string | undefined,
		schemaDefinition: unknown,
		model: ModelIR,
		adapter: Adapter<unknown> | undefined,
		schemaName: string | undefined,
	) {
		this.query = query;
		this.params = params;
		this.hasBoundParams = hasBoundParams;
		this.sourceError = sourceError;
		this.schemaDefinition = schemaDefinition;
		this.model = model;
		this.adapter = adapter;
		this._schemaName = schemaName;
	}

	private compile(): QueryIntent {
		if (this._intent) {
			return this._intent;
		}

		if (this.sourceError !== undefined) {
			throw new Error(`NQL compilation failed: ${this.sourceError}`);
		}

		// Extract dynamic pseudo-column keywords from model configuration
		const compilerOptions: NqlCompilerOptions = {
			...(extractPseudoColumnKeywords(this.model) ?? {}),
			params: this.params,
			allowInternalParams: true,
		};

		// Use integrated @dbsp/nql compiler with dynamic keywords
		const result = nqlCompile(
			this.query,
			this.schemaDefinition,
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
		if (result.ast?.mutation && !result.ast?.query) {
			throw new Error(
				'INSERT/UPDATE/DELETE/UPSERT not yet supported via the nql`...` tagged template. ' +
					'Use orm.insert(table, data) / orm.update(table, set) / orm.delete(table) / orm.upsert(table, data) instead. ' +
					'Tracking: https://github.com/oorabona/db-semantic-planner/issues/113',
			);
		}
		if (!result.ast?.query) {
			throw new Error('NQL compilation failed: no query AST produced');
		}

		// Type assertion: NQL imports QueryIntent from @dbsp/types (ARCH-007),
		// structurally identical to core's re-export.
		this._intent = result.ast.query as QueryIntent;
		return this._intent;
	}

	toIntentIR(): QueryIntent {
		return this.compile();
	}

	plan(): PlanReport {
		const intent = this.compile();
		return executePlan(intent, this.model);
	}

	dump(meta?: DumpMetaInput): Dump {
		const planReport = this.plan();

		if (!this.adapter) {
			return {
				plan: planReport,
				sql: '[No adapter - SQL not available]',
				params: [],
				...(meta !== undefined && { meta }),
			};
		}

		const compiled = this.adapter.compile<T>(planReport);

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

	async all(): Promise<T[]> {
		if (!this.adapter) {
			throw new Error(
				'Cannot execute query: no adapter configured. ' +
					'Pass an adapter to createOrm() or use .toIntentIR() / .plan() for debugging.',
			);
		}

		const planReport = this.plan();
		const compiled = this.adapter.compile<T>(planReport);
		return this.adapter.execute(compiled);
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
