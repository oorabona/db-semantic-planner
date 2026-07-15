import { createComparator, createPackRegistry } from '@dbsp/core';
import type {
	ColumnIR,
	EvidenceObservation,
	ModelIR,
	ObservationContext,
	ObservationRequest,
	TableIR,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { CamelCaseNamingPlugin } from '../../naming-plugin.js';
import {
	ALTER_AUTHORITY_OBSERVATION,
	COLUMN_EXISTS_OBSERVATION,
	ENGINE_VERSION_OBSERVATION,
	NO_NULLS_GUARD,
	PG_INTROSPECTION_ARTIFACT,
} from '../constants.js';
import { evidenceId } from '../ids.js';
import { createPgTransitionPack } from '../pack.js';
import { createSetNotNullRule } from './set-not-null.js';

const context: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '18',
	databaseId: 'test',
	capabilities: ['alter-column-set-not-null'],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

function column(
	nullable: boolean,
	overrides: Partial<ColumnIR> = {},
	name = 'age',
): ColumnIR {
	return { name, type: 'integer', nullable, ...overrides };
}

function table(
	nullable: boolean,
	columnOverrides: Partial<ColumnIR> = {},
	name = 'users',
	columnName = 'age',
): TableIR {
	return {
		name,
		columns: [column(nullable, columnOverrides, columnName)],
		foreignKeys: [],
		indexes: [],
	};
}

function model(
	nullable: boolean,
	columnOverrides: Partial<ColumnIR> = {},
	tableName = 'users',
	columnName = 'age',
): ModelIR {
	const tables = new Map<string, TableIR>([
		[tableName, table(nullable, columnOverrides, tableName, columnName)],
	]);
	return {
		tables,
		relations: new Map(),
		getTable: (name) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function normalizedRequest(
	request: ObservationRequest,
	schema = 'public',
): ObservationRequest {
	if (request.kind === ENGINE_VERSION_OBSERVATION) {
		return {
			...request,
			scope: request.scope.map((resource) => ({
				...resource,
				database: context.databaseId,
			})),
		};
	}
	const detail = request.detail as {
		readonly table: string;
		readonly column: string;
	};
	return {
		...request,
		scope: request.scope.map((resource) => ({
			...resource,
			database: context.databaseId,
			schema,
		})),
		detail: {
			table: detail.table,
			column: detail.column,
			schema,
		},
	};
}

function normalizedEvidence(
	request: ObservationRequest,
	holds = true,
	schema = 'public',
): EvidenceObservation {
	return evidence(normalizedRequest(request, schema), holds);
}

function evidence(
	request: ObservationRequest,
	holds: boolean,
): EvidenceObservation {
	return {
		role: 'evidence',
		id: evidenceId(`test.${request.kind}`),
		issuer: PG_INTROSPECTION_ARTIFACT,
		request,
		result: { value: { claims: [{ kind: request.kind, holds }] } },
		context,
		stability: 'externally-mutable',
		takenAt: new Date().toISOString(),
		scope: request.scope,
		source: 'system-catalog',
		validity: { invalidatedBy: [] },
	};
}

describe('postgresql.column.set-not-null rule', () => {
	it('recognizes nullable true to false', () => {
		const rule = createSetNotNullRule();
		const result = rule.recognize(model(false), model(true));
		expect(result.recognized).toBe(true);
		if (result.recognized) {
			expect(result.match).toEqual({ table: 'users', column: 'age' });
		}
	});

	it('uses the naming plugin to emit physical target identifiers', () => {
		const rule = createSetNotNullRule({
			naming: new CamelCaseNamingPlugin(),
		});
		const result = rule.recognize(
			model(false, {}, 'userProfiles', 'createdAt'),
			model(true, {}, 'userProfiles', 'createdAt'),
		);

		expect(result.recognized).toBe(true);
		if (!result.recognized) {
			return;
		}
		expect(result.match).toEqual({
			table: 'user_profiles',
			column: 'created_at',
		});
		const requests = rule.requiredObservations(result.match);
		expect(requests[0]?.detail).toEqual({
			table: 'user_profiles',
			column: 'created_at',
			schema: null,
		});
		const evaluation = rule.evaluate(
			result.match,
			requests.map((request) => normalizedEvidence(request)),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}
		const fragment = rule.generateCandidate(result.match, evaluation);
		expect(fragment.operations[0]?.payload).toEqual({
			schema: 'public',
			table: 'user_profiles',
			column: 'created_at',
		});
	});

	it('matches logical desired identifiers to physical current identifiers under snake_case dbCasing', () => {
		const registry = createPackRegistry([
			createPgTransitionPack({ dbCasing: 'snake_case' }),
		]);
		const compare = createComparator(registry).compare(
			model(false, {}, 'userProfiles', 'createdAt'),
			model(true, {}, 'user_profiles', 'created_at'),
		);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);
		expect(compare.candidates[0]?.match).toEqual({
			table: 'user_profiles',
			column: 'created_at',
		});
		expect(compare.candidates[0]?.requiredObservations[0]?.detail).toEqual({
			table: 'user_profiles',
			column: 'created_at',
			schema: null,
		});
	});

	it('does not recognize unchanged nullability', () => {
		const rule = createSetNotNullRule();
		expect(rule.recognize(model(false), model(false)).recognized).toBe(false);
	});

	it('does not recognize a combined nullability and type/default change', () => {
		const rule = createSetNotNullRule();
		expect(
			rule.recognize(
				model(false, { default: 0 }),
				model(true, { default: null }),
			).recognized,
		).toBe(false);
	});

	it('does not recognize nullability plus a changed Date-valued column field', () => {
		const desired = model(false, {
			default: new Date('2026-01-02T00:00:00.000Z'),
		});
		const current = model(true, {
			default: new Date('2026-01-01T00:00:00.000Z'),
		});

		expect(createSetNotNullRule().recognize(desired, current).recognized).toBe(
			false,
		);
		expect(
			createComparator(createPackRegistry([createPgTransitionPack()])).compare(
				desired,
				current,
			).kind,
		).toBe('unsupported');
	});

	it('evaluates applicable when durable evidence holds', () => {
		const rule = createSetNotNullRule();
		const match = { schema: 'public', table: 'users', column: 'age' };
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(
			match,
			requests.map((request) => evidence(request, true)),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
	});

	it('evaluates inapplicable when authority is refuted', () => {
		const rule = createSetNotNullRule();
		const match = { schema: 'public', table: 'users', column: 'age' };
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(
			match,
			requests.map((request) =>
				evidence(request, request.kind !== ALTER_AUTHORITY_OBSERVATION),
			),
			[],
		);
		expect(evaluation.outcome).toBe('inapplicable');
	});

	it('evaluates blocked when evidence is missing', () => {
		const rule = createSetNotNullRule();
		const match = { schema: 'public', table: 'users', column: 'age' };
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(match, [evidence(requests[0]!, true)], []);
		expect(evaluation.outcome).toBe('blocked');
	});

	it('generates an operation and an undischarged NO_NULLS apply guard', () => {
		const rule = createSetNotNullRule();
		const match = { schema: 'public', table: 'users', column: 'age' };
		const requests = rule.requiredObservations(match);
		const evaluation = rule.evaluate(
			match,
			requests.map((request) => normalizedEvidence(request)),
			[],
		);
		expect(evaluation.outcome).toBe('applicable');
		if (evaluation.outcome !== 'applicable') {
			return;
		}
		const fragment = rule.generateCandidate(match, evaluation);
		expect(fragment.operations[0]?.operationKind.name).toBe(
			'AlterColumnSetNotNull',
		);
		expect(fragment.guards[0]?.predicate.kind).toBe(NO_NULLS_GUARD);
		expect(fragment.guards[0]).not.toHaveProperty('discharged');
		expect(fragment.obligations.map((item) => item.proposition.kind)).toEqual([
			COLUMN_EXISTS_OBSERVATION,
			ALTER_AUTHORITY_OBSERVATION,
			ENGINE_VERSION_OBSERVATION,
		]);
		const resources = [
			...(fragment.assumptions[0]?.scope ?? []),
			...(fragment.guards[0]?.predicate.scope ?? []),
			...((fragment.guards[0]?.protocol.kind === 'lock-and-check' &&
				fragment.guards[0]?.protocol.binding?.scope) ||
				[]),
		];
		expect(resources.map((resource) => resource.database)).toEqual(
			resources.map(() => context.databaseId),
		);
	});
});
