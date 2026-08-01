import { POSTGRESQL_CAPABILITIES } from '@dbsp/core';
import type { DialectCapabilities, IndexIR } from '@dbsp/types';
import { isEngineCanonicalIndex } from '../expression-provenance.js';
import {
	INDEX_INCLUDE_CAPABILITY,
	INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
} from '../transition/index-feature-capabilities.js';
import {
	formatStorageParameterValue,
	validateCheckExpression,
	validateIdentifier,
	validateSqlExpression,
} from '../validate.js';
import { quoteIdent, validateIndexMethod } from './phases/utils.js';
import { escapeCanonicalSqlLiterals } from './rendered-sql.js';

export type IndexRenderKey = {
	readonly column?: string | undefined;
	readonly expression?: string | undefined;
	readonly opclass?: string | undefined;
};

export type IndexRenderSpec = {
	readonly name: string;
	readonly table: string;
	readonly schema?: string | undefined;
	readonly unique: boolean;
	readonly method?: string | undefined;
	readonly keys: readonly IndexRenderKey[];
	readonly include?: readonly string[] | undefined;
	readonly nullsNotDistinct?: boolean | undefined;
	readonly with?: Readonly<Record<string, unknown>> | undefined;
	readonly where?: string | undefined;
	/** The in-process index value that owns a deparsed `where` predicate. */
	readonly whereSource?: IndexIR | undefined;
	readonly concurrently?: boolean | undefined;
	readonly ifNotExists?: boolean | undefined;
};

export type IndexCapabilityContext = {
	readonly caps: DialectCapabilities;
	readonly targetVersion?: string | undefined;
};

type IndexFeature =
	| 'INCLUDE'
	| 'PARTIAL INDEX'
	| 'EXPRESSION INDEX'
	| 'INDEX METHOD'
	| 'OPCLASS'
	| 'NULLS NOT DISTINCT';

type FeatureDeclaration = {
	readonly feature: IndexFeature;
	readonly capability: keyof DialectCapabilities;
	readonly present: (spec: IndexRenderSpec) => boolean;
	readonly minServerVersionNum?: number;
};

const INDEX_FEATURE_DECLARATIONS: readonly FeatureDeclaration[] = [
	{
		feature: 'INCLUDE',
		capability: 'supportsDDLIndexInclude',
		present: (spec) => (spec.include?.length ?? 0) > 0,
		minServerVersionNum: INDEX_INCLUDE_CAPABILITY.predicate.minServerVersionNum,
	},
	{
		feature: 'PARTIAL INDEX',
		capability: 'supportsDDLPartialIndexes',
		present: (spec) => spec.where !== undefined,
	},
	{
		feature: 'EXPRESSION INDEX',
		capability: 'supportsDDLExpressionIndexes',
		present: (spec) => spec.keys.some((key) => key.expression !== undefined),
	},
	{
		feature: 'INDEX METHOD',
		capability: 'supportsDDLIndexMethods',
		present: (spec) => spec.method !== undefined && spec.method.length > 0,
	},
	{
		feature: 'OPCLASS',
		capability: 'supportsDDLIndexOpclass',
		present: (spec) => spec.keys.some((key) => key.opclass !== undefined),
	},
	{
		feature: 'NULLS NOT DISTINCT',
		capability: 'supportsDDLIndexNullsNotDistinct',
		present: (spec) => spec.nullsNotDistinct === true,
		minServerVersionNum:
			INDEX_NULLS_NOT_DISTINCT_CAPABILITY.predicate.minServerVersionNum,
	},
];

export class IndexFeatureUnsupportedError extends Error {
	readonly indexName: string;
	readonly unsupportedFeatures: readonly IndexFeature[];

	constructor(
		indexName: string,
		unsupportedFeatures: readonly IndexFeature[],
		message: string,
	) {
		super(message);
		this.name = 'IndexFeatureUnsupportedError';
		this.indexName = indexName;
		this.unsupportedFeatures = unsupportedFeatures;
	}
}

function formatServerVersion(versionNum: number): string {
	const major = Math.trunc(versionNum / 10_000);
	const minor = Math.trunc((versionNum % 10_000) / 100);
	return minor === 0 ? String(major) : `${major}.${minor}`;
}

function unsupportedMessage(
	spec: IndexRenderSpec,
	feature: FeatureDeclaration,
	ctx: IndexCapabilityContext,
): string {
	if (ctx.targetVersion && feature.minServerVersionNum !== undefined) {
		return `index \`${spec.name}\`: ${feature.feature} requires PostgreSQL >= ${formatServerVersion(feature.minServerVersionNum)} (target ${ctx.targetVersion})`;
	}
	return `index \`${spec.name}\`: ${feature.feature} is not enabled in the supplied dialect capabilities`;
}

function hasNonEmptyColumn(key: IndexRenderKey): boolean {
	return key.column !== undefined && key.column.trim().length > 0;
}

function hasNonEmptyExpression(key: IndexRenderKey): boolean {
	return key.expression !== undefined && key.expression.trim().length > 0;
}

export function assertCreateIndexSupported(
	spec: IndexRenderSpec,
	ctx: IndexCapabilityContext = { caps: POSTGRESQL_CAPABILITIES },
): void {
	if (spec.keys.length === 0) {
		throw new Error(
			`index \`${spec.name}\`: CREATE INDEX requires at least one key`,
		);
	}
	for (const [index, key] of spec.keys.entries()) {
		const hasColumn = hasNonEmptyColumn(key);
		const hasExpression = hasNonEmptyExpression(key);
		if (!hasColumn && !hasExpression) {
			throw new Error(
				`index \`${spec.name}\`: CREATE INDEX key #${index + 1} must declare a non-empty column or expression`,
			);
		}
		if (hasColumn && hasExpression) {
			throw new Error(
				`index \`${spec.name}\`: CREATE INDEX key #${index + 1} must not declare both column and expression`,
			);
		}
	}
	if (spec.nullsNotDistinct === true && !spec.unique) {
		throw new Error(
			`index \`${spec.name}\`: NULLS NOT DISTINCT is only valid for UNIQUE indexes`,
		);
	}

	const unsupported = INDEX_FEATURE_DECLARATIONS.filter(
		(feature) => feature.present(spec) && ctx.caps[feature.capability] !== true,
	);
	if (unsupported.length === 0) {
		return;
	}

	throw new IndexFeatureUnsupportedError(
		spec.name,
		unsupported.map((feature) => feature.feature),
		unsupported
			.map((feature) => unsupportedMessage(spec, feature, ctx))
			.join('; '),
	);
}

export function assertCreateIndexesSupported(
	specs: readonly IndexRenderSpec[],
	ctx: IndexCapabilityContext = { caps: POSTGRESQL_CAPABILITIES },
): void {
	const unsupportedErrors: IndexFeatureUnsupportedError[] = [];
	for (const spec of specs) {
		try {
			assertCreateIndexSupported(spec, ctx);
		} catch (error) {
			if (error instanceof IndexFeatureUnsupportedError) {
				unsupportedErrors.push(error);
				continue;
			}
			throw error;
		}
	}
	if (unsupportedErrors.length === 0) {
		return;
	}

	throw new IndexFeatureUnsupportedError(
		unsupportedErrors[0]!.indexName,
		unsupportedErrors.flatMap((error) => error.unsupportedFeatures),
		unsupportedErrors.map((error) => error.message).join('; '),
	);
}

function qualifyTable(table: string, schema?: string): string {
	return schema
		? `${quoteIdent(schema, 'schema')}.${quoteIdent(table, 'table')}`
		: quoteIdent(table, 'table');
}

function renderKey(key: IndexRenderKey): string {
	if (hasNonEmptyColumn(key)) {
		const columnName = key.column!;
		const column = quoteIdent(columnName, 'alias');
		if (key.opclass !== undefined) {
			validateIdentifier(key.opclass, 'alias');
		}
		return key.opclass ? `${column} ${key.opclass}` : column;
	}
	if (!hasNonEmptyExpression(key)) {
		throw new Error(
			'Index render key must declare a non-empty column or expression',
		);
	}
	const expression = key.expression!;
	validateSqlExpression(expression, 'index expression');
	if (key.opclass !== undefined) {
		validateIdentifier(key.opclass, 'alias');
	}
	return key.opclass ? `${expression} ${key.opclass}` : expression;
}

export function renderCreateIndex(
	spec: IndexRenderSpec,
	ctx: IndexCapabilityContext = { caps: POSTGRESQL_CAPABILITIES },
): string {
	assertCreateIndexSupported(spec, ctx);

	if (spec.method !== undefined) {
		validateIndexMethod(spec.method, 'index method');
	}

	const parts: string[] = ['CREATE'];
	if (spec.unique) parts.push('UNIQUE');
	parts.push('INDEX');
	if (spec.concurrently) parts.push('CONCURRENTLY');
	if (spec.ifNotExists) parts.push('IF NOT EXISTS');
	parts.push(quoteIdent(spec.name, 'alias'));
	parts.push(`ON ${qualifyTable(spec.table, spec.schema)}`);
	if (spec.method) parts.push(`USING ${spec.method}`);

	parts.push(`(${spec.keys.map(renderKey).join(', ')})`);

	if (spec.include && spec.include.length > 0) {
		parts.push(
			`INCLUDE (${spec.include.map((col) => quoteIdent(col, 'alias')).join(', ')})`,
		);
	}
	if (spec.nullsNotDistinct === true) {
		parts.push('NULLS NOT DISTINCT');
	}
	if (spec.with && Object.keys(spec.with).length > 0) {
		const withParams = Object.entries(spec.with)
			.map(([key, value]) => {
				validateIdentifier(key, 'alias');
				return `${key} = ${formatStorageParameterValue(value, `index WITH parameter "${key}"`)}`;
			})
			.join(', ');
		parts.push(`WITH (${withParams})`);
	}
	const where = spec.where;
	if (where !== undefined) {
		// Provenance lives on the frozen index object, not on a caller-controlled
		// boolean. A branded index can only bypass authored-input validation for
		// its exact deparsed predicate.
		const canonicalPredicate =
			isEngineCanonicalIndex(spec.whereSource) &&
			spec.whereSource.where === where;
		if (!canonicalPredicate) {
			validateCheckExpression(where, 'index WHERE predicate');
		}
		parts.push(
			`WHERE ${canonicalPredicate ? escapeCanonicalSqlLiterals(where) : where}`,
		);
	}

	return parts.join(' ');
}
