import type { CollationRef, ExpressionValue, TypeRef } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { PG_EQUIVALENCE_ARTIFACT } from './constants.js';
import { createPgEquivalenceCapability } from './equivalence.js';
import { assumptionId, semanticArtifactId } from './ids.js';

const context = { engine: 'postgresql' };

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

describe('PostgreSQL transition equivalence', () => {
	it('refuses identical unsafe-native expressions before exact equality', () => {
		const equivalence = createPgEquivalenceCapability();
		const left: ExpressionValue = {
			kind: 'unsafe-native',
			category: 'scalar',
			text: 'now()',
			assumption: assumptionId('unsafe.default.now'),
		};
		const right: ExpressionValue = {
			kind: 'unsafe-native',
			category: 'scalar',
			text: 'now()',
			assumption: assumptionId('unsafe.default.now'),
		};

		const result = equivalence.compareExpression(
			left,
			right,
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

	it('keeps equal portable ASTs equivalent under the requested category', () => {
		const equivalence = createPgEquivalenceCapability();
		const left: ExpressionValue = {
			kind: 'portable',
			ast: { kind: 'literal', value: 42 },
		};
		const right: ExpressionValue = {
			kind: 'portable',
			ast: { value: 42, kind: 'literal' },
		};

		const result = equivalence.compareExpression(
			left,
			right,
			'scalar',
			context,
		);

		expect(result.kind).toBe('equivalent');
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
