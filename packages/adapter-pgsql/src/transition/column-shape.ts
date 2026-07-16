import type {
	Assumption,
	AuthorAttestedNativeDefault,
	CollationRef,
	ColumnIR,
	EquivalenceCapability,
	EquivalenceContext,
	EquivalenceResult,
	EvidenceObservation,
	ExpressionValue,
	JsonValue,
	ProofClaimDraft,
	ProofObligation,
	ResourceAddress,
	TypeRef,
} from '@dbsp/types';
import { PG_DEPARSE_ARTIFACT } from './constants.js';
import { assumptionId } from './ids.js';

export interface SetNotNullColumnShapeExpectation {
	readonly kind: 'postgresql.set-not-null.column-shape.v1';
	readonly name: string;
	readonly nullability: {
		readonly from: true;
		readonly to: boolean;
	};
	readonly type: TypeRef;
	readonly default: ExpressionValue | null;
	readonly collation: CollationRef;
	readonly identity: 'always' | 'byDefault' | null;
	readonly generated: string | null;
	readonly autoIncrement: boolean;
	readonly unique: boolean;
	readonly uniqueConstraintName: string | null;
	readonly comment: string | null;
}

export interface SetNotNullObservedColumnShape {
	readonly name: string;
	readonly nullable: boolean;
	readonly type: TypeRef;
	readonly default: ExpressionValue | null;
	readonly collation: CollationRef;
	readonly identity: 'always' | 'byDefault' | null;
	readonly generated: string | null;
	readonly autoIncrement: boolean;
	readonly unique: boolean;
	readonly uniqueConstraintName: string | null;
	readonly comment: string | null;
}

export type SetNotNullColumnShapeComparison =
	| {
			readonly kind: 'equivalent';
			readonly claimDrafts: readonly ProofClaimDraft[];
			readonly assumptions: readonly Assumption[];
	  }
	| {
			readonly kind: 'different';
			readonly field: string;
			readonly detail: string;
			readonly claimDrafts: readonly ProofClaimDraft[];
	  }
	| {
			readonly kind: 'unknown';
			readonly field: string;
			readonly obligations: readonly ProofObligation[];
			readonly claimDrafts: readonly ProofClaimDraft[];
	  };

export interface CatalogColumnShapeInput {
	readonly nullable: boolean | null;
	readonly atttypid: string | null;
	readonly atttypmod: number | null;
	readonly formatType: string | null;
	readonly typeName: string | null;
	readonly typeSchema: string | null;
	readonly hasDefault: boolean | null;
	readonly defaultExpression: string | null;
	readonly attcollation: string | null;
	readonly collationName: string | null;
	readonly collationSchema: string | null;
	readonly collationProvider: string | null;
	readonly collationVersion: string | null;
	readonly identity: 'always' | 'byDefault' | null;
	readonly attgenerated: string | null;
	readonly unique: boolean | null;
	readonly uniqueConstraintName: string | null;
	readonly autoIncrement: boolean | null;
	readonly comment: string | null;
}

export interface ColumnDefaultAttestationTarget {
	readonly database?: string;
	readonly schema?: string;
	readonly table: string;
	readonly column: string;
}

type ParsedTypeSpelling = {
	readonly name: string;
	readonly schema?: string;
	readonly modifiers: readonly string[];
	readonly arrayDepth: number;
};

const SAFE_LOWERCASE_IDENTIFIER_RE = /^[a-z_][a-z0-9_$]*$/;
function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function authorAttester(
	value: unknown,
): AuthorAttestedNativeDefault['attestedBy'] | undefined {
	if (!isRecord(value) || typeof value.kind !== 'string') {
		return undefined;
	}
	if (value.kind === 'human' && typeof value.identity === 'string') {
		return { kind: 'human', identity: value.identity };
	}
	if (value.kind === 'policy' && typeof value.policyId === 'string') {
		return { kind: 'policy', policyId: value.policyId };
	}
	return undefined;
}

function authorAttestedNativeDefault(
	value: unknown,
): AuthorAttestedNativeDefault | undefined {
	if (!isRecord(value) || typeof value.sql !== 'string') {
		return undefined;
	}
	const attestedBy = authorAttester(value.attestedBy);
	if (!attestedBy) {
		return undefined;
	}
	return {
		sql: value.sql,
		attestedBy,
		...(typeof value.statement === 'string'
			? { statement: value.statement }
			: {}),
	};
}

function json(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function jsonSafeSnapshot(
	value: unknown,
	seen: WeakSet<object> = new WeakSet(),
): JsonValue | undefined {
	if (value === null) {
		return null;
	}
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : undefined;
		case 'bigint':
		case 'function':
		case 'symbol':
		case 'undefined':
			return undefined;
		case 'object':
			break;
	}

	if (seen.has(value)) {
		return undefined;
	}
	const prototype = Object.getPrototypeOf(value);
	const isPlainArray = Array.isArray(value);
	if (
		(isPlainArray && prototype !== Array.prototype && prototype !== null) ||
		(!isPlainArray && prototype !== Object.prototype && prototype !== null)
	) {
		return undefined;
	}
	if (
		Object.getOwnPropertySymbols(value).some((symbol) =>
			Object.prototype.propertyIsEnumerable.call(value, symbol),
		)
	) {
		return undefined;
	}

	seen.add(value);
	try {
		if (isPlainArray) {
			const array = value as readonly unknown[];
			if (Object.keys(array).length !== array.length) {
				return undefined;
			}
			const snapshot: JsonValue[] = [];
			for (let index = 0; index < array.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(array, index);
				if (!descriptor || !('value' in descriptor)) {
					return undefined;
				}
				const item = jsonSafeSnapshot(descriptor.value, seen);
				if (item === undefined) {
					return undefined;
				}
				snapshot.push(item);
			}
			return snapshot;
		}

		const snapshot: Record<string, JsonValue> = {};
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !('value' in descriptor)) {
				return undefined;
			}
			const item = jsonSafeSnapshot(descriptor.value, seen);
			if (item === undefined) {
				return undefined;
			}
			snapshot[key] = item;
		}
		return snapshot;
	} finally {
		seen.delete(value);
	}
}

function quoteRawIdentifierIfNeeded(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		return value;
	}
	return SAFE_LOWERCASE_IDENTIFIER_RE.test(value)
		? value
		: `"${value.replace(/"/g, '""')}"`;
}

function splitQualifiedIdentifier(
	value: string,
): { readonly schema: string; readonly name: string } | null {
	let inQuote = false;
	for (let index = 0; index < value.length; index++) {
		const ch = value[index];
		if (ch === '"') {
			if (inQuote && value[index + 1] === '"') {
				index += 1;
			} else {
				inQuote = !inQuote;
			}
			continue;
		}
		if (ch !== '.' || inQuote) {
			continue;
		}
		const schema = value.slice(0, index).trim();
		const name = value.slice(index + 1).trim();
		if (!schema || !name) {
			return null;
		}
		return { schema, name };
	}
	return null;
}

function trailingModifierStart(value: string): number | undefined {
	if (!value.endsWith(')')) {
		return undefined;
	}
	let inQuote = false;
	let depth = 0;
	for (let index = value.length - 1; index >= 0; index--) {
		const ch = value[index];
		if (ch === '"') {
			if (inQuote && value[index - 1] === '"') {
				index -= 1;
			} else {
				inQuote = !inQuote;
			}
			continue;
		}
		if (inQuote) {
			continue;
		}
		if (ch === ')') {
			depth += 1;
			continue;
		}
		if (ch !== '(') {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
	}
	return undefined;
}

function parseTypeSpelling(value: string): ParsedTypeSpelling {
	let remaining = value.trim();
	let arrayDepth = 0;
	while (remaining.endsWith('[]')) {
		arrayDepth += 1;
		remaining = remaining.slice(0, -2).trimEnd();
	}

	let modifiers: readonly string[] = [];
	const modifierStart = trailingModifierStart(remaining);
	if (modifierStart !== undefined && modifierStart > 0) {
		const modifierText = remaining.slice(modifierStart + 1, -1);
		remaining = remaining.slice(0, modifierStart).trimEnd();
		modifiers = modifierText
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
	}

	let schema: string | undefined;
	let name = remaining;
	const qualifier = splitQualifiedIdentifier(remaining);
	if (qualifier) {
		schema = qualifier.schema;
		name = qualifier.name;
	}

	return {
		name,
		...(schema ? { schema } : {}),
		modifiers,
		arrayDepth,
	};
}

function fallbackTypeName(type: ColumnIR['type']): string {
	switch (type) {
		case 'string':
			return 'character varying';
		case 'number':
		case 'decimal':
			return 'numeric';
		case 'integer':
			return 'integer';
		case 'bigint':
			return 'bigint';
		case 'boolean':
			return 'boolean';
		case 'datetime':
			return 'timestamp with time zone';
		case 'timestamp':
			return 'timestamp without time zone';
		case 'time':
			return 'time without time zone';
		default:
			return type;
	}
}

function typeRefFromColumn(column: ColumnIR): TypeRef {
	const parsed = parseTypeSpelling(
		column.originalDbType?.trim() || fallbackTypeName(column.type),
	);
	const schema =
		column.originalDbTypeSchema != null
			? quoteRawIdentifierIfNeeded(column.originalDbTypeSchema)
			: parsed.schema;
	return {
		kind: 'type',
		name: parsed.name,
		...(schema ? { schema } : {}),
		...(column.originalDbTypeSchemaScope
			? { schemaScope: column.originalDbTypeSchemaScope }
			: {}),
		modifiers: parsed.modifiers,
		arrayDepth: parsed.arrayDepth,
	};
}

function typeRefFromCatalog(catalog: CatalogColumnShapeInput): TypeRef {
	const parsed = parseTypeSpelling(
		catalog.formatType?.trim() || catalog.typeName?.trim() || 'unknown',
	);
	const name =
		catalog.formatType == null &&
		catalog.typeName != null &&
		catalog.typeSchema !== 'pg_catalog'
			? quoteRawIdentifierIfNeeded(catalog.typeName)
			: parsed.arrayDepth > 0 || catalog.typeSchema !== 'pg_catalog'
				? parsed.name
				: (catalog.typeName ?? parsed.name);
	const schema =
		catalog.typeSchema != null
			? quoteRawIdentifierIfNeeded(catalog.typeSchema)
			: parsed.schema;
	const catalogIdentity = {
		...(catalog.atttypid ? { oid: catalog.atttypid } : {}),
		...(catalog.typeName ? { name: catalog.typeName } : {}),
		...(catalog.typeSchema ? { schema: catalog.typeSchema } : {}),
		...(catalog.atttypmod != null ? { typmod: catalog.atttypmod } : {}),
		...(catalog.formatType ? { formatType: catalog.formatType } : {}),
	};
	return {
		kind: 'type',
		name,
		...(schema ? { schema } : {}),
		modifiers: parsed.modifiers,
		arrayDepth: parsed.arrayDepth,
		...(Object.keys(catalogIdentity).length > 0
			? { catalog: catalogIdentity }
			: {}),
	};
}

function columnDefaultScope(
	target: ColumnDefaultAttestationTarget,
): readonly ResourceAddress[] {
	const base: ResourceAddress = {
		engine: 'postgresql',
		database: target.database ?? 'model',
		kind: 'column',
		name: target.column,
		qualifiedBy: [target.table],
	};
	return [target.schema ? { ...base, schema: target.schema } : base];
}

function userAttestedNativeDefaultAssumption(
	defaultValue: AuthorAttestedNativeDefault,
	target: ColumnDefaultAttestationTarget,
): Assumption {
	const database = target.database ?? 'model';
	const scope = columnDefaultScope({ ...target, database });
	return {
		id: assumptionId(
			`dbsp.postgresql.default.user-attested-native-default:${JSON.stringify([
				database,
				target.schema ?? null,
				target.table,
				target.column,
				defaultValue.sql,
				defaultValue.attestedBy,
			])}`,
		),
		class: 'user-attested-native-default',
		asserter: defaultValue.attestedBy,
		statement:
			defaultValue.statement ??
			'Schema author attests this native SQL fragment is the intended unchanged scalar column default.',
		scope,
	};
}

function unsafeNativeDefault(
	rawSql: string,
	attestation?: Assumption,
): ExpressionValue {
	return {
		kind: 'unsafe-native',
		category: 'scalar',
		text: rawSql,
		assumption:
			attestation?.id ??
			assumptionId(
				`dbsp.postgresql.default.unsafe-native:${JSON.stringify(rawSql)}`,
			),
		...(attestation ? { attestation } : {}),
	};
}

function portableDefault(value: unknown, source: string): ExpressionValue {
	const ast = jsonSafeSnapshot(value);
	if (ast === undefined) {
		return {
			kind: 'unresolvable',
			category: 'scalar',
			source,
			reason: 'column default is not a finite, plain, cycle-free JSON value',
		};
	}
	return {
		kind: 'portable',
		ast,
	};
}

function defaultExpressionFromAuthoredValue(
	value: unknown,
	target?: ColumnDefaultAttestationTarget,
): ExpressionValue | null {
	if (isRecord(value) && typeof value.sql === 'string') {
		const attestedDefault = authorAttestedNativeDefault(value);
		const attestation =
			attestedDefault && target
				? userAttestedNativeDefaultAssumption(attestedDefault, target)
				: undefined;
		return unsafeNativeDefault(value.sql, attestation);
	}
	return portableDefault(value, 'authored-column-default');
}

function defaultExpressionFromObservedColumnValue(
	value: unknown,
	target?: ColumnDefaultAttestationTarget,
): ExpressionValue | null {
	const attestedDefault = authorAttestedNativeDefault(value);
	if (attestedDefault && target) {
		return unsafeNativeDefault(
			attestedDefault.sql,
			userAttestedNativeDefaultAssumption(attestedDefault, target),
		);
	}
	if (isRecord(value) && typeof value.sql === 'string') {
		return {
			kind: 'vendor-validated',
			category: 'scalar',
			validatedBy: PG_DEPARSE_ARTIFACT,
			text: value.sql,
		};
	}
	// Hand-built current models used by pure tests can still carry structured
	// values; keep those portable so exact AST equality remains compile-only.
	return portableDefault(value, 'observed-column-default');
}

function defaultExpressionFromCatalog(
	catalog: CatalogColumnShapeInput,
): ExpressionValue | null {
	if (!catalog.hasDefault || catalog.defaultExpression == null) {
		return null;
	}
	return {
		kind: 'vendor-validated',
		category: 'scalar',
		validatedBy: PG_DEPARSE_ARTIFACT,
		text: catalog.defaultExpression,
	};
}

function collationFromColumn(column: ColumnIR): CollationRef {
	if (!column.collation) {
		return { kind: 'collation', isDefault: true };
	}
	return {
		kind: 'collation',
		name: quoteRawIdentifierIfNeeded(column.collation),
		isDefault: false,
	};
}

function collationFromCatalog(catalog: CatalogColumnShapeInput): CollationRef {
	if (!catalog.collationName || catalog.collationName === 'default') {
		return {
			kind: 'collation',
			isDefault: true,
			...(catalog.attcollation && catalog.attcollation !== '0'
				? { catalog: { oid: catalog.attcollation } }
				: {}),
		};
	}
	return {
		kind: 'collation',
		name: quoteRawIdentifierIfNeeded(catalog.collationName),
		...(catalog.collationSchema
			? { schema: quoteRawIdentifierIfNeeded(catalog.collationSchema) }
			: {}),
		isDefault: false,
		catalog: {
			...(catalog.attcollation ? { oid: catalog.attcollation } : {}),
			...(catalog.collationProvider
				? { provider: catalog.collationProvider }
				: {}),
			...(catalog.collationVersion
				? { version: catalog.collationVersion }
				: {}),
		},
	};
}

function generatedFromColumn(column: ColumnIR): string | null {
	const generated = (column as { readonly generated?: unknown }).generated;
	return typeof generated === 'string' ? generated : null;
}

export function columnWithoutNullable(
	column: ColumnIR,
): Omit<ColumnIR, 'nullable'> {
	const rest: Record<string, unknown> = { ...column };
	delete rest.nullable;
	return rest as Omit<ColumnIR, 'nullable'>;
}

export function expectedColumnShapeFor(
	column: ColumnIR,
	physicalName: string,
	target?: ColumnDefaultAttestationTarget,
): SetNotNullColumnShapeExpectation {
	return {
		kind: 'postgresql.set-not-null.column-shape.v1',
		name: physicalName,
		nullability: { from: true, to: column.nullable },
		type: typeRefFromColumn(column),
		default: Object.hasOwn(column, 'default')
			? defaultExpressionFromAuthoredValue(column.default, target)
			: null,
		collation: collationFromColumn(column),
		identity: column.identity ?? null,
		generated: generatedFromColumn(column),
		autoIncrement: column.autoIncrement ?? false,
		unique: column.unique ?? false,
		uniqueConstraintName: column.uniqueConstraintName ?? null,
		comment: column.comment ?? null,
	};
}

export function columnShapeFromColumn(
	column: ColumnIR,
	physicalName: string,
	target?: ColumnDefaultAttestationTarget,
): SetNotNullObservedColumnShape {
	return {
		name: physicalName,
		nullable: column.nullable,
		type: typeRefFromColumn(column),
		default: Object.hasOwn(column, 'default')
			? defaultExpressionFromObservedColumnValue(column.default, target)
			: null,
		collation: collationFromColumn(column),
		identity: column.identity ?? null,
		generated: generatedFromColumn(column),
		autoIncrement: column.autoIncrement ?? false,
		unique: column.unique ?? false,
		uniqueConstraintName: column.uniqueConstraintName ?? null,
		comment: column.comment ?? null,
	};
}

export function columnShapeFromCatalog(
	catalog: CatalogColumnShapeInput,
	columnName: string,
): SetNotNullObservedColumnShape {
	return {
		name: columnName,
		nullable: catalog.nullable === true,
		type: typeRefFromCatalog(catalog),
		default: defaultExpressionFromCatalog(catalog),
		collation: collationFromCatalog(catalog),
		identity: catalog.identity ?? null,
		generated: catalog.attgenerated ?? null,
		autoIncrement: catalog.autoIncrement ?? false,
		unique: catalog.unique ?? false,
		uniqueConstraintName: catalog.uniqueConstraintName ?? null,
		comment: catalog.comment ?? null,
	};
}

function addFieldToObligations(
	obligations: readonly ProofObligation[],
	field: string,
): readonly ProofObligation[] {
	return obligations.map((obligation) => ({
		...obligation,
		appliesTo: obligation.appliesTo ?? field,
		proposition: {
			...obligation.proposition,
			detail: json({ field, detail: obligation.proposition.detail ?? null }),
		},
	}));
}

function equivalentClaims(
	result: EquivalenceResult,
): readonly ProofClaimDraft[] {
	return result.kind === 'equivalent' || result.kind === 'different'
		? [result.claim]
		: [];
}

function equivalentAssumptions(
	result: EquivalenceResult,
): readonly Assumption[] {
	return result.kind === 'equivalent' ? (result.assumptions ?? []) : [];
}

function handleEquivalenceField(
	field: string,
	result: EquivalenceResult,
	claimDrafts: readonly ProofClaimDraft[],
): SetNotNullColumnShapeComparison | undefined {
	const claims = [...claimDrafts, ...equivalentClaims(result)];
	if (result.kind === 'equivalent') {
		return undefined;
	}
	if (result.kind === 'different') {
		return {
			kind: 'different',
			field,
			detail: `${field} is semantically different`,
			claimDrafts: claims,
		};
	}
	return {
		kind: 'unknown',
		field,
		obligations: addFieldToObligations(result.obligations, field),
		claimDrafts,
	};
}

function structuralDifferent(
	field: string,
	detail: string,
	claimDrafts: readonly ProofClaimDraft[],
): SetNotNullColumnShapeComparison {
	return { kind: 'different', field, detail, claimDrafts };
}

export function compareSetNotNullColumnShape(
	expected: SetNotNullColumnShapeExpectation,
	observed: SetNotNullObservedColumnShape,
	equivalence: EquivalenceCapability,
	context: EquivalenceContext,
	evidence?: readonly EvidenceObservation[],
): SetNotNullColumnShapeComparison {
	let claimDrafts: readonly ProofClaimDraft[] = [];
	let assumptions: readonly Assumption[] = [];
	if (expected.name !== observed.name) {
		return structuralDifferent('name', 'column name changed', claimDrafts);
	}
	if (expected.nullability.to !== false) {
		return structuralDifferent(
			'nullability.to',
			'desired column is not a SET NOT NULL target',
			claimDrafts,
		);
	}
	if (observed.nullable !== expected.nullability.from) {
		return structuralDifferent(
			'nullability.from',
			'observed column is not currently nullable',
			claimDrafts,
		);
	}
	if (expected.identity !== observed.identity) {
		return structuralDifferent('identity', 'identity changed', claimDrafts);
	}
	if (expected.generated !== observed.generated) {
		return structuralDifferent(
			'generated',
			'generated column state changed',
			claimDrafts,
		);
	}
	if (expected.autoIncrement !== observed.autoIncrement) {
		return structuralDifferent(
			'autoIncrement',
			'auto-increment state changed',
			claimDrafts,
		);
	}
	if (expected.unique !== observed.unique) {
		return structuralDifferent('unique', 'unique state changed', claimDrafts);
	}
	if (expected.comment !== observed.comment) {
		return structuralDifferent(
			'comment',
			'column comment changed',
			claimDrafts,
		);
	}

	const typeResult = equivalence.compareType(
		expected.type,
		observed.type,
		context,
		evidence,
	);
	const typeComparison = handleEquivalenceField(
		'type',
		typeResult,
		claimDrafts,
	);
	if (typeComparison) {
		return typeComparison;
	}
	claimDrafts = [...claimDrafts, ...equivalentClaims(typeResult)];
	assumptions = [...assumptions, ...equivalentAssumptions(typeResult)];

	if (expected.default == null && observed.default != null) {
		return structuralDifferent(
			'default',
			'default expression added',
			claimDrafts,
		);
	}
	if (expected.default != null && observed.default == null) {
		return structuralDifferent(
			'default',
			'default expression removed',
			claimDrafts,
		);
	}
	if (expected.default != null && observed.default != null) {
		const defaultResult = equivalence.compareExpression(
			expected.default,
			observed.default,
			'scalar',
			context,
			evidence,
		);
		const defaultComparison = handleEquivalenceField(
			'default',
			defaultResult,
			claimDrafts,
		);
		if (defaultComparison) {
			return defaultComparison;
		}
		claimDrafts = [...claimDrafts, ...equivalentClaims(defaultResult)];
		assumptions = [...assumptions, ...equivalentAssumptions(defaultResult)];
	}

	const collationResult = equivalence.compareCollation(
		expected.collation,
		observed.collation,
		context,
		evidence,
	);
	const collationComparison = handleEquivalenceField(
		'collation',
		collationResult,
		claimDrafts,
	);
	if (collationComparison) {
		return collationComparison;
	}
	claimDrafts = [...claimDrafts, ...equivalentClaims(collationResult)];
	assumptions = [...assumptions, ...equivalentAssumptions(collationResult)];

	return { kind: 'equivalent', claimDrafts, assumptions };
}

export function isSetNotNullColumnShapeExpectation(
	value: unknown,
): value is SetNotNullColumnShapeExpectation {
	if (!isRecord(value)) {
		return false;
	}
	if (
		value.kind !== 'postgresql.set-not-null.column-shape.v1' ||
		typeof value.name !== 'string' ||
		!isRecord(value.nullability) ||
		value.nullability.from !== true ||
		typeof value.nullability.to !== 'boolean' ||
		!isRecord(value.type) ||
		value.type.kind !== 'type' ||
		!Array.isArray(value.type.modifiers) ||
		typeof value.type.arrayDepth !== 'number' ||
		!isRecord(value.collation) ||
		value.collation.kind !== 'collation' ||
		typeof value.collation.isDefault !== 'boolean' ||
		(value.identity !== null &&
			value.identity !== 'always' &&
			value.identity !== 'byDefault') ||
		(value.generated !== null && typeof value.generated !== 'string') ||
		typeof value.autoIncrement !== 'boolean' ||
		typeof value.unique !== 'boolean' ||
		(value.uniqueConstraintName !== null &&
			typeof value.uniqueConstraintName !== 'string') ||
		(value.comment !== null && typeof value.comment !== 'string')
	) {
		return false;
	}
	return value.default === null || isRecord(value.default);
}
