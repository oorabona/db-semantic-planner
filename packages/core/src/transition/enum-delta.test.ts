import type { EnumIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { enumAddDelta } from './enum-delta.js';

function enumDef(
	values: readonly string[],
	overrides: Partial<EnumIR> = {},
): EnumIR {
	return { name: 'status', values, ...overrides };
}

describe('enumAddDelta', () => {
	it('treats an authored unspecified schema as matching the current schema', () => {
		expect(
			enumAddDelta(
				enumDef(['active', 'pending']),
				enumDef(['active'], { schema: 'tenant' }),
			),
		).toEqual({ kind: 'add-label', label: 'pending' });
	});

	it('surfaces explicit schema drift before the no-drift fast path', () => {
		expect(
			enumAddDelta(
				enumDef(['active'], { schema: 'desired' }),
				enumDef(['active'], { schema: 'current' }),
			),
		).toEqual({ kind: 'unsupported' });
	});

	it('returns none when schema and labels are unchanged', () => {
		expect(
			enumAddDelta(
				enumDef(['active', 'pending'], { schema: 'tenant' }),
				enumDef(['active', 'pending'], { schema: 'tenant' }),
			),
		).toEqual({ kind: 'none' });
	});
});
