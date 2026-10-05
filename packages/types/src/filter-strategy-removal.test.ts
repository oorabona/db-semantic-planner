import { expect, it } from 'vitest';
import type { RelationIR } from './model-ir.js';
import type { PlanOptions } from './planner.js';

it('removed filter strategy inputs are compile errors', () => {
	const options: PlanOptions = {
		// @ts-expect-error Relation predicates have no strategy override.
		forceFilterStrategy: 'join',
	};
	const relation: RelationIR = {
		name: 'author',
		source: 'posts',
		target: 'users',
		type: 'belongsTo',
		cardinality: 'one',
		optionality: 'optional',
		includeStrategy: 'auto',
		joinDefault: 'auto',
		// @ts-expect-error Relation predicates have no model strategy hint.
		filterStrategy: 'auto',
	};
	expect(options).toBeDefined();
	expect(relation).toBeDefined();
});
