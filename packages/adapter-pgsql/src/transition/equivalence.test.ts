import { createEvidenceView } from '@dbsp/core';
import type {
	Assumption,
	CollationRef,
	EquivalenceContext,
	EvidenceObservation,
	ExpressionValue,
	ObservationContext,
	ObservationRequest,
	ResourceAddress,
	TypeRef,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { withDeparseRequest } from '../test-compat/equivalence-deparse-request.js';
import {
	EXPRESSION_DEPARSE_OBSERVATION,
	PG_EQUIVALENCE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
} from './constants.js';
import { createPgEquivalenceCapability } from './equivalence.js';
import { assumptionId, evidenceId, semanticArtifactId } from './ids.js';

const context = { engine: 'postgresql' };
const proofObservationContext: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'test',
	capabilities: [],
	privileges: [],
	effectiveRole: 'app_owner',
	targetSchema: 'public',
	searchPath: ['public'],
	sessionConfiguration: { standard_conforming_strings: 'on' },
	extensions: { pgcrypto: '1.3' },
	collationProvider: 'icu',
	collationVersion: '153.120',
	transaction: 'tx:deparse',
};
type ProofBoundEquivalenceContext = EquivalenceContext & {
	readonly proofObservationContext?: ObservationContext;
	readonly deparseRequest?: ObservationRequest;
};
const proofEquivalenceContext: ProofBoundEquivalenceContext = {
	engine: proofObservationContext.engine,
	databaseId: proofObservationContext.databaseId,
	...(proofObservationContext.targetSchema
		? { targetSchema: proofObservationContext.targetSchema }
		: {}),
	...(proofObservationContext.searchPath
		? { searchPath: proofObservationContext.searchPath }
		: {}),
	proofObservationContext,
};

function jsonFixture(value: unknown) {
	return JSON.parse(JSON.stringify(value));
}

function typeRef(
	name: string,
	schema?: string,
	schemaScope?: TypeRef['schemaScope'],
): TypeRef {
	return {
		kind: 'type',
		name,
		...(schema ? { schema } : {}),
		...(schemaScope ? { schemaScope } : {}),
		modifiers: [],
		arrayDepth: 0,
	};
}

function collationRef(name: string, schema?: string): CollationRef {
	return {
		kind: 'collation',
		name,
		...(schema ? { schema } : {}),
		isDefault: false,
	};
}

function sqlExpression(text: string): ExpressionValue {
	return {
		kind: 'vendor-validated',
		category: 'scalar',
		validatedBy: PG_EQUIVALENCE_ARTIFACT,
		text,
	};
}

function columnResource(): ResourceAddress {
	return {
		engine: 'postgresql',
		database: 'model',
		kind: 'column',
		name: 'created_at',
		qualifiedBy: ['users'],
	};
}

function nativeDefaultAssumption(id = 'unsafe.default.now'): Assumption {
	return {
		id: assumptionId(id),
		class: 'user-attested-native-default',
		asserter: { kind: 'human', identity: 'schema-author' },
		statement:
			'Schema author attests this raw SQL column default is unchanged.',
		scope: [columnResource()],
	};
}

function unsafeNativeDefault(
	text: string,
	attestation?: Assumption,
): ExpressionValue {
	return {
		kind: 'unsafe-native',
		category: 'scalar',
		text,
		assumption: attestation?.id ?? assumptionId('unsafe.default.now'),
		...(attestation ? { attestation } : {}),
	};
}

function portable(ast: unknown): ExpressionValue {
	return {
		kind: 'portable',
		ast: JSON.parse(JSON.stringify(ast)),
	};
}

function unresolvableDefault(): ExpressionValue {
	return {
		kind: 'unresolvable',
		category: 'scalar',
		source: 'authored-column-default',
		reason: 'column default is not a finite, plain, cycle-free JSON value',
	};
}

function deparseEvidence(
	left: ExpressionValue,
	right: ExpressionValue,
	leftCanonical: string,
	rightCanonical: string,
	options: {
		readonly request?: ObservationRequest;
		readonly context?: EvidenceObservation['context'];
		readonly claims?: readonly Record<string, unknown>[];
	} = {},
): EvidenceObservation {
	const request: ObservationRequest = options.request ?? {
		kind: EXPRESSION_DEPARSE_OBSERVATION,
		scope: [],
		detail: {
			surface: 'column-default',
			category: 'scalar',
			table: 'users',
			column: 'status',
			schema: 'public',
			left: jsonFixture(left),
			right: jsonFixture(right),
		},
	};
	return {
		role: 'evidence',
		id: evidenceId(`deparse.${leftCanonical}.${rightCanonical}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: {
			value: {
				ok: true,
				surface: 'column-default',
				category: 'scalar',
				leftCanonical,
				rightCanonical,
				...(options.claims ? { claims: jsonFixture(options.claims) } : {}),
			},
		},
		context: options.context ?? {
			...proofObservationContext,
		},
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: [],
		source: 'vendor-deparser',
		validity: { invalidatedBy: ['external-ddl'] },
	};
}

function evidenceView(
	items: readonly EvidenceObservation[],
	ctx: ObservationContext = proofObservationContext,
	requests: readonly ObservationRequest[] = items.map((item) => item.request),
) {
	return createEvidenceView({ evidence: items, context: ctx, requests });
}

function columnDeparseRequest(
	left: ExpressionValue,
	right: ExpressionValue,
	table = 'users',
	column = 'status',
): ObservationRequest {
	return {
		kind: EXPRESSION_DEPARSE_OBSERVATION,
		scope: [
			{
				engine: 'postgresql',
				database: 'test',
				schema: 'public',
				kind: 'column',
				name: column,
				qualifiedBy: [table],
			},
		],
		detail: {
			surface: 'column-default',
			category: 'scalar',
			table,
			column,
			schema: 'public',
			left: jsonFixture(left),
			right: jsonFixture(right),
		},
	};
}

describe('PostgreSQL transition equivalence', () => {
	it('keeps identical unsafe-native expressions equivalent under author attestation', () => {
		const equivalence = createPgEquivalenceCapability();
		const assumption = nativeDefaultAssumption();

		const result = equivalence.compareExpression(
			unsafeNativeDefault(' now() ', assumption),
			unsafeNativeDefault('now()', assumption),
			'scalar',
			context,
		);

		expect(result.kind).toBe('equivalent');
		if (result.kind !== 'equivalent') {
			return;
		}
		expect(result.claim.conclusion).toBe('established-under-assumptions');
		expect(result.claim.assumes).toEqual([assumption.id]);
		expect(result.assumptions).toEqual([assumption]);
	});

	it('refuses identical unsafe-native expressions without a real attestation', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareExpression(
			unsafeNativeDefault('now()'),
			unsafeNativeDefault('now()'),
			'scalar',
			context,
		);

		expect(result).toMatchObject({
			kind: 'unknown',
			obligations: [
				{
					proposition: {
						kind: 'postgresql.equivalence.expression.unknown',
					},
				},
			],
		});
	});

	it('does not prove different unsafe-native text under author attestation', () => {
		const equivalence = createPgEquivalenceCapability();
		const assumption = nativeDefaultAssumption();

		const result = equivalence.compareExpression(
			unsafeNativeDefault('now()', assumption),
			unsafeNativeDefault('clock_timestamp()', assumption),
			'scalar',
			context,
		);

		expect(result.kind).not.toBe('equivalent');
	});

	it('refuses vendor-validated expressions with different trust roots', () => {
		const equivalence = createPgEquivalenceCapability();
		const otherValidatedBy = {
			id: semanticArtifactId('dbsp.postgresql.equivalence.other'),
			version: '0.1.0',
		};

		const result = equivalence.compareExpression(
			sqlExpression('42'),
			{
				kind: 'vendor-validated',
				category: 'scalar',
				validatedBy: otherValidatedBy,
				text: '42',
			},
			'scalar',
			context,
		);

		expect(result.kind).toBe('unknown');
	});

	it('refuses expressions whose own category does not match the requested category', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareExpression(
			sqlExpression('value > 0'),
			sqlExpression('value > 0'),
			'predicate',
			context,
		);

		expect(result.kind).toBe('unknown');
	});

	it('keeps same-trust vendor scalar defaults equivalent', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareExpression(
			sqlExpression('42'),
			sqlExpression('42'),
			'scalar',
			context,
		);

		expect(result.kind).toBe('equivalent');
	});

	it('keeps same-trust vendor scalar defaults equivalent with trim-only drift', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareExpression(
			sqlExpression(' 42 '),
			sqlExpression('42'),
			'scalar',
			context,
		);

		expect(result.kind).toBe('equivalent');
	});

	it('keeps equal portable ASTs equivalent under the requested category', () => {
		const equivalence = createPgEquivalenceCapability();
		const left = portable({ kind: 'literal', value: 42 });
		const right = portable({ value: 42, kind: 'literal' });

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			context,
		);

		expect(result.kind).toBe('equivalent');
	});

	it('returns a deparse obligation for mixed portable and vendor defaults', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareExpression(
			portable('active'),
			sqlExpression("'active'::text"),
			'scalar',
			context,
		);

		expect(result).toMatchObject({
			kind: 'unknown',
			obligations: [
				{
					proposition: {
						kind: 'postgresql.equivalence.expression.deparse-required',
						detail: {
							observationKind: EXPRESSION_DEPARSE_OBSERVATION,
						},
					},
				},
			],
		});
	});

	it('resolves mixed default equivalence from vendor-deparser evidence', () => {
		const equivalence = createPgEquivalenceCapability();
		const left = portable('active');
		const right = sqlExpression("'active'::text");
		const request = columnDeparseRequest(left, right);

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			withDeparseRequest(proofEquivalenceContext, request),
			evidenceView([
				deparseEvidence(left, right, "'active'::text", "'active'::text", {
					request,
				}),
			]),
		);

		expect(result.kind).toBe('equivalent');
	});

	it('keeps deparse evidence unknown without a full proof observation context', () => {
		const equivalence = createPgEquivalenceCapability();
		const left = portable('active');
		const right = sqlExpression("'active'::text");
		const request = columnDeparseRequest(left, right);

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			withDeparseRequest(
				{
					engine: proofObservationContext.engine,
					databaseId: proofObservationContext.databaseId,
					targetSchema: 'public',
					searchPath: ['public'],
				},
				request,
			),
			evidenceView([
				deparseEvidence(left, right, "'active'::text", "'active'::text", {
					request,
				}),
			]),
		);

		expect(result.kind).toBe('unknown');
	});

	it.each([
		[
			'effectiveRole',
			(ctx: ObservationContext) => ({ ...ctx, effectiveRole: 'readonly_app' }),
		],
		[
			'sessionConfiguration',
			(ctx: ObservationContext) => ({
				...ctx,
				sessionConfiguration: {
					...ctx.sessionConfiguration,
					TimeZone: 'UTC',
				},
			}),
		],
		[
			'extensions',
			(ctx: ObservationContext) => ({
				...ctx,
				extensions: { ...ctx.extensions, citext: '1.6' },
			}),
		],
		[
			'collationVersion',
			(ctx: ObservationContext) => ({
				...ctx,
				collationVersion: '153.121',
			}),
		],
		[
			'collationProvider',
			(ctx: ObservationContext) => ({
				...ctx,
				collationProvider: 'libc',
			}),
		],
		[
			'transaction',
			(ctx: ObservationContext) => ({ ...ctx, transaction: 'tx:other' }),
		],
	] as const)('does not consume deparse evidence from a different %s', (_field, mutate) => {
		const equivalence = createPgEquivalenceCapability();
		const left = portable('active');
		const right = sqlExpression("'active'::text");
		const mismatchedProofContext = mutate(proofObservationContext);
		const request = columnDeparseRequest(left, right);

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			withDeparseRequest(
				{
					...proofEquivalenceContext,
					proofObservationContext: mismatchedProofContext,
				},
				request,
			),
			evidenceView([
				deparseEvidence(left, right, "'active'::text", "'active'::text", {
					request,
				}),
			]),
		);

		expect(result.kind).toBe('unknown');
	});

	it('does not use sibling column deparse evidence for a bound comparison target', () => {
		const equivalence = createPgEquivalenceCapability();
		const left = portable('active');
		const right = sqlExpression("'active'::text");
		const request = columnDeparseRequest(left, right, 'users', 'status');
		const siblingRequest = columnDeparseRequest(
			left,
			right,
			'accounts',
			'status',
		);
		const boundContext = {
			...proofEquivalenceContext,
			deparseRequest: request,
		};

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			boundContext,
			evidenceView([
				deparseEvidence(left, right, "'active'::text", "'active'::text", {
					request: siblingRequest,
					context: {
						...proofObservationContext,
					},
				}),
			]),
		);

		expect(result.kind).toBe('unknown');
	});

	it('fails closed when scoped deparse evidence conflicts', () => {
		const equivalence = createPgEquivalenceCapability();
		const left = portable('active');
		const right = sqlExpression("'active'::text");
		const request = columnDeparseRequest(left, right);
		const boundContext = {
			...proofEquivalenceContext,
			deparseRequest: request,
		};

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			boundContext,
			evidenceView([
				deparseEvidence(left, right, "'active'::text", "'active'::text", {
					request,
					context: {
						...proofObservationContext,
					},
				}),
				deparseEvidence(left, right, "'active'::text", "'pending'::text", {
					request,
					context: {
						...proofObservationContext,
					},
				}),
			]),
		);

		expect(result.kind).toBe('unknown');
		if (result.kind === 'unknown') {
			expect(result.obligations[0]?.proposition.detail).toMatchObject({
				reason:
					'deparse evidence contains both equivalent and different results',
			});
		}
	});

	it('keeps unresolvable defaults unknown without accepting deparse evidence', () => {
		const equivalence = createPgEquivalenceCapability();
		const left = unresolvableDefault();
		const right = sqlExpression('10');

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			context,
			evidenceView([deparseEvidence(left, right, '10', '10')]),
		);

		expect(result).toMatchObject({
			kind: 'unknown',
			obligations: [
				{
					proposition: {
						kind: 'postgresql.equivalence.expression.unknown',
					},
				},
			],
		});
	});

	it('refutes mixed default equivalence from unequal vendor-deparser evidence', () => {
		const equivalence = createPgEquivalenceCapability();
		const left = portable('active');
		const right = sqlExpression("'pending'::text");
		const request = columnDeparseRequest(left, right);

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			withDeparseRequest(proofEquivalenceContext, request),
			evidenceView([
				deparseEvidence(left, right, "'active'::text", "'pending'::text", {
					request,
				}),
			]),
		);

		expect(result.kind).toBe('different');
	});

	it('does not case-fold SQL expression literal content', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareExpression(
			sqlExpression("'A'"),
			sqlExpression("'a'"),
			'scalar',
			context,
		);

		expect(result.kind).not.toBe('equivalent');
	});

	it('compares quoted type identifiers case-sensitively while preserving unquoted aliases', () => {
		const equivalence = createPgEquivalenceCapability();

		expect(
			equivalence.compareType(typeRef('"MyType"'), typeRef('"mytype"'), context)
				.kind,
		).not.toBe('equivalent');
		expect(
			equivalence.compareType(typeRef('int4'), typeRef('integer'), context)
				.kind,
		).toBe('equivalent');
		expect(
			equivalence.compareType(
				typeRef('int4', 'pg_catalog'),
				typeRef('integer', 'pg_catalog'),
				context,
			).kind,
		).toBe('equivalent');
	});

	it('does not treat an explicit non-pg_catalog alias spelling as a built-in type', () => {
		const equivalence = createPgEquivalenceCapability();

		expect(
			equivalence.compareType(
				typeRef('int4', 'public'),
				typeRef('integer', 'pg_catalog'),
				context,
			).kind,
		).not.toBe('equivalent');
		expect(
			equivalence.compareType(
				typeRef('text', 'public'),
				typeRef('text', 'pg_catalog'),
				context,
			).kind,
		).not.toBe('equivalent');
	});

	it('retargets target-scoped custom types through the equivalence context', () => {
		const equivalence = createPgEquivalenceCapability();

		expect(
			equivalence.compareType(
				typeRef('status', 'tenant_a', 'target'),
				typeRef('status', 'tenant_b'),
				{ engine: 'postgresql', targetSchema: 'tenant_b' },
			).kind,
		).toBe('equivalent');
		expect(
			equivalence.compareType(
				typeRef('status', 'tenant_a', 'absolute'),
				typeRef('status', 'tenant_b', 'absolute'),
				{ engine: 'postgresql', targetSchema: 'tenant_b' },
			).kind,
		).toBe('different');
		expect(
			equivalence.compareType(
				typeRef('int4', 'tenant_a', 'target'),
				typeRef('integer', 'pg_catalog'),
				{ engine: 'postgresql', targetSchema: 'tenant_b' },
			).kind,
		).not.toBe('equivalent');
	});

	it('keeps target-scoped custom types unresolved without explicit target schema', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareType(
			typeRef('status', 'tenant_a', 'target'),
			typeRef('status', 'tenant_b', 'target'),
			{ engine: 'postgresql', searchPath: ['tenant_a', 'public'] },
		);

		expect(result.kind).toBe('unknown');
		if (result.kind === 'unknown') {
			expect(result.obligations[0]?.proposition.kind).toBe(
				'postgresql.equivalence.type.identity-unresolved',
			);
		}
	});

	it('compares quoted collation identifiers case-sensitively', () => {
		const equivalence = createPgEquivalenceCapability();

		const result = equivalence.compareCollation(
			collationRef('"MyCollation"'),
			collationRef('"mycollation"'),
			context,
		);

		expect(result.kind).not.toBe('equivalent');
	});
});
