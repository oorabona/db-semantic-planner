import type { OutcomeClaimPlan } from '@dbsp/types';

// @ts-expect-error Cascade-covered claims must bind to their SQL-bearing root.
const cascadeCoveredWithoutRoot: OutcomeClaimPlan = {
	claimId: 'covered-member',
	claimSpecies: 'cascade-covered',
	address: {
		scope: 'schema',
		engine: 'postgresql',
		database: 'app',
		schema: 'tenant',
		kind: 'sequence',
		name: 'accounts_id_seq',
	},
	claimKind: 'retire-intent',
	statementBundle: { statements: [] },
};

void cascadeCoveredWithoutRoot;
