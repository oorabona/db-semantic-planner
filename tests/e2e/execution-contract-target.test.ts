import type { TransitionSessionClient } from '@dbsp/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPgExecutionTargetFromClient } from '../../packages/adapter-pgsql/src/transition/execution-contract.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';

const schemaName = 'execution_contract_target';

describe('PostgreSQL execution contract target', () => {
	beforeAll(async () => createSchema(schemaName));

	afterAll(async () => dropSchema(schemaName));

	it('mutation: passing a namespace list as scalar parameters makes PostgreSQL reject the text array', async () => {
		const target = await readPgExecutionTargetFromClient(
			(await getTestPool()) as unknown as TransitionSessionClient,
			['public', schemaName],
		);

		expect(
			target.identity.namespaces.map((namespace) => namespace.name),
		).toEqual(['execution_contract_target', 'public']);
	});
});
