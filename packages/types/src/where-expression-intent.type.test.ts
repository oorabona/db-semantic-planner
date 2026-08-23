import { test } from 'vitest';
import type { WhereExpressionIntent } from './intent-ast.js';

const expr = { kind: 'ref', column: 'active' } as const;

const standalone: WhereExpressionIntent = { kind: 'expression', expr };
const comparison: WhereExpressionIntent = {
	kind: 'expression',
	expr,
	operator: 'eq',
	value: true,
};

// @ts-expect-error expression WHERE intents cannot contain a value without an operator
const valueWithoutOperator: WhereExpressionIntent = {
	kind: 'expression',
	expr,
	value: true,
};

// @ts-expect-error expression WHERE intents cannot contain an operator without a value
const operatorWithoutValue: WhereExpressionIntent = {
	kind: 'expression',
	expr,
	operator: 'eq',
};

void standalone;
void comparison;
void valueWithoutOperator;
void operatorWithoutValue;

test('WhereExpressionIntent keeps operator and value paired', () => {});
