import type { TableIR } from '@dbsp/types';

// Adding a TableIR field makes this assignment fail until it is classified.
// @ts-expect-error TableIR.policies is deliberately omitted from this probe.
const missingTableField: Record<keyof TableIR, 'map' | 'preserve'> = {
	name: 'map',
	readdress: 'preserve',
	adopt: 'preserve',
	replace: 'preserve',
	logicalIdentity: 'preserve',
	columns: 'map',
	primaryKey: 'map',
	foreignKeys: 'map',
	indexes: 'map',
	checkConstraints: 'map',
	pseudoColumns: 'preserve',
	comment: 'preserve',
	partition: 'map',
	rlsEnabled: 'preserve',
};
void missingTableField;
