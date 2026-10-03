import type { IncludeOptions } from '@dbsp/core';
import type { IncludeIntent, PlanDecision } from '@dbsp/types';
import { sqlColumnRef } from './ast-helpers.js';

// @ts-expect-error Include emission accepts only identifiers that crossed an authority boundary.
sqlColumnRef('parent_id');

const expressionOrder = [
	{
		expression: { kind: 'literal' as const, value: 1 },
		direction: 'asc' as const,
	},
];
// @ts-expect-error IncludeIntent ordering is field-only.
const intentOrder: IncludeIntent['orderBy'] = expressionOrder;
// @ts-expect-error IncludeOptions ordering is field-only.
const optionOrder: IncludeOptions['orderBy'] = expressionOrder;
void intentOrder;
void optionOrder;

// @ts-expect-error Published plan include ordering is field-only.
const planOrder: PlanDecision['context']['includeOrderBy'] = expressionOrder;
void planOrder;
