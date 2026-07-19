import type {
	ApplyPolicy,
	ColumnIR,
	EnumIR,
	ModelIR,
	TableIR,
	TransitionConnectionPool,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	createToyTransitionPack,
	type ToyDb,
	toyChoiceDbType,
} from './__fixtures__/toy-transition-pack.js';
import { createApplier } from './applier.js';
import { createComparator } from './comparator.js';
import { createProver } from './prover.js';
import { createPackRegistry } from './registry.js';
import { createStagedTransitionOrchestrator } from './staged-orchestrator.js';

const policy: ApplyPolicy = {
	accepts: [{ class: 'operation-pack-semantics' }],
};

const context = {
	engine: 'toydb',
	engineVersion: '1',
	databaseId: 'toy-memory',
	capabilities: [],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

function table(columns: readonly ColumnIR[]): TableIR {
	return {
		name: 'tasks',
		columns,
		foreignKeys: [],
		indexes: [],
	};
}

function model(
	columns: readonly ColumnIR[],
	options: {
		readonly enums?: ReadonlyMap<string, EnumIR>;
		readonly tableOverride?: TableIR;
	} = {},
): ModelIR {
	const taskTable = options.tableOverride ?? table(columns);
	const tables = new Map([[taskTable.name, taskTable]]);
	const relations = new Map();
	return {
		tables,
		relations,
		...(options.enums ? { enums: options.enums } : {}),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function statusColumn(overrides: Partial<ColumnIR> = {}): ColumnIR {
	return {
		name: 'status',
		type: 'text',
		nullable: true,
		...overrides,
	};
}

function dbWith(column: ColumnIR): ToyDb {
	return {
		model: model([column]),
		rows: {
			tasks: [{ status: 'active' }],
		},
	};
}

function target(): TransitionConnectionPool {
	return {
		connect: async () => ({
			query: async () => ({ rows: [] }),
			release: () => undefined,
		}),
	};
}

function currentStatus(db: ToyDb): ColumnIR {
	const column = db.model
		.getTable('tasks')
		?.columns.find((entry) => entry.name === 'status');
	if (!column) {
		throw new Error('missing status column');
	}
	return column;
}

describe('toy transition pack', () => {
	it('runs the supported direct pipeline for nullable to required', async () => {
		const db = dbWith(statusColumn({ nullable: true }));
		const desired = model([statusColumn({ nullable: false })]);
		const registry = createPackRegistry([createToyTransitionPack(db)]);
		const compare = createComparator(registry).compare(desired, db.model);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		expect(compare.candidates).toHaveLength(1);

		const proof = await createProver(registry).prove(
			compare,
			target(),
			context,
		);
		expect(proof.kind).toBe('proven');
		if (proof.kind !== 'proven') {
			return;
		}

		const result = await createApplier(registry).apply(
			{ plan: proof.plan, assessment: proof.assessment },
			policy,
			target(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(currentStatus(db).nullable).toBe(false);
		expect(result.journals).toHaveLength(1);
		expect(result.journals[0]?.outcome).toBe('completed');
	});

	it('runs the supported staged orchestrator path as a single stage without PG kinds', async () => {
		const db = dbWith(statusColumn({ nullable: true }));
		const desired = model([statusColumn({ nullable: false })]);
		const registry = createPackRegistry([createToyTransitionPack(db)]);

		const result = await createStagedTransitionOrchestrator(
			registry,
		).applyStagedTransition({
			desired,
			loadCurrent: async () => db.model,
			readContext: async () => context,
			target: target(),
			policy,
		});
		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.assessment.continuation).toBe('none');
		expect(currentStatus(db).nullable).toBe(false);
		expect(result.journals).toHaveLength(1);

		const kinds = [
			...result.journals.map(
				(journal) => journal.intent.operation.operationKind.name,
			),
			...result.journals.map(
				(journal) => journal.intent.operation.operationKind.artifact.id,
			),
			...result.observations.map((observation) => observation.request.kind),
		].join('\n');
		expect(kinds).not.toMatch(
			/postgresql|enum-label|check-constraint|alter-type/i,
		);
	});

	it('fails closed for a PG-shaped feature the toy pack has no rule for', async () => {
		const initial = statusColumn({ nullable: true });
		const db = dbWith(initial);
		const pgEnum = new Map<string, EnumIR>([
			['status', { name: 'status', values: ['active', 'pending'] }],
		]);
		const desired = model([initial], { enums: pgEnum });
		const registry = createPackRegistry([createToyTransitionPack(db)]);

		const result = await createStagedTransitionOrchestrator(
			registry,
		).applyStagedTransition({
			desired,
			loadCurrent: async () => db.model,
			readContext: async () => context,
			target: target(),
			policy,
		});

		expect(result.assessment.decision).toBe('blocked');
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'unsupported-transition',
		});
		expect(result.journals).toHaveLength(0);
		expect(currentStatus(db)).toEqual(initial);
		expect(db.model.enums).toBeUndefined();
	});

	it('adds a toy choice value declared through originalDbType only', async () => {
		const db = dbWith(
			statusColumn({ originalDbType: toyChoiceDbType(['active']) }),
		);
		const desired = model([
			statusColumn({
				originalDbType: toyChoiceDbType(['active', 'pending']),
			}),
		]);
		const registry = createPackRegistry([createToyTransitionPack(db)]);
		const compare = createComparator(registry).compare(desired, db.model);

		expect(compare.kind).toBe('transitions');
		if (compare.kind !== 'transitions') {
			return;
		}
		const proof = await createProver(registry).prove(
			compare,
			target(),
			context,
		);
		expect(proof.kind).toBe('proven');
		if (proof.kind !== 'proven') {
			return;
		}

		const result = await createApplier(registry).apply(
			{ plan: proof.plan, assessment: proof.assessment },
			policy,
			target(),
		);

		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.journals[0]?.intent.operation.operationKind.name).toBe(
			'ToyChoiceAddValue',
		);
		expect(currentStatus(db).originalDbType).toBe(
			toyChoiceDbType(['active', 'pending']),
		);
		expect(db.model.enums).toBeUndefined();
		expect(db.model.getTable('tasks')?.checkConstraints).toBeUndefined();
	});

	it('stages toy choice composition through the pack-owned satisfaction hook', async () => {
		const db = dbWith(
			statusColumn({ originalDbType: toyChoiceDbType(['active']) }),
		);
		const desired = model([
			statusColumn({
				nullable: false,
				originalDbType: toyChoiceDbType(['active', 'pending']),
				default: 'pending',
			}),
		]);
		const registry = createPackRegistry([createToyTransitionPack(db)]);

		const result = await createStagedTransitionOrchestrator(
			registry,
		).applyStagedTransition({
			desired,
			loadCurrent: async () => db.model,
			readContext: async () => context,
			target: target(),
			policy,
		});
		expect(result.assessment.lifecycle).toBe('completed');
		expect(result.assessment.continuation).toBe('none');
		expect(result.journals.map((journal) => journal.outcome)).toEqual([
			'completed',
			'completed',
		]);
		expect(
			result.journals.map(
				(journal) => journal.intent.operation.operationKind.name,
			),
		).toEqual(['ToyChoiceAddValue', 'ToySetRequired']);
		expect(result.observations.map((entry) => entry.request.kind)).toContain(
			'toy.choice.value-visible',
		);
		expect(currentStatus(db)).toMatchObject({
			nullable: false,
			originalDbType: toyChoiceDbType(['active', 'pending']),
			default: 'pending',
		});
	});
});
