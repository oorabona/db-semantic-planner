import type { SemanticArtifactRef } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { semanticArtifactId } from './ids.js';
import type { RegisteredOperationSemantics } from './registry.js';
import { createPackRegistry, isOperationRuntime } from './registry.js';

const artifact: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.mock.registry'),
	version: '0.1.0',
};

const RUNTIME_MEMBERS = [
	'writeIntentJournal',
	'begin',
	'setLockTimeout',
	'acquireLocks',
	'observeContext',
	'observeOperation',
	'checkGuard',
	'executeOperation',
	'writeCompletionJournal',
	'commit',
	'rollback',
	'writeObservedJournal',
	'isLockTimeout',
] as const;

function completeRuntime(): Record<string, unknown> {
	return Object.fromEntries(RUNTIME_MEMBERS.map((name) => [name, vi.fn()]));
}

describe('isOperationRuntime', () => {
	it('recognizes a pack declaring every runtime member', () => {
		expect(
			isOperationRuntime(
				completeRuntime() as unknown as RegisteredOperationSemantics,
			),
		).toBe(true);
	});

	it.each([
		'checkout',
		'release',
	])('refuses a pack still declaring the retired %s member', (retired) => {
		// Core owns acquisition and release now. A pack declaring either was
		// built against a contract that no longer holds: core would never call
		// it, and the pack would believe it manages a connection nobody hands it.
		const legacy = { ...completeRuntime(), [retired]: vi.fn() };

		expect(
			isOperationRuntime(legacy as unknown as RegisteredOperationSemantics),
		).toBe(false);
	});

	it.each(RUNTIME_MEMBERS)('refuses a pack missing %s', (missing) => {
		const partial = completeRuntime();
		delete partial[missing];

		expect(
			isOperationRuntime(partial as unknown as RegisteredOperationSemantics),
		).toBe(false);
	});
});

describe('PackRegistry execution coordinator compatibility', () => {
	it.each([
		'checkout',
		'release',
	])('refuses a legacy coordinator declaring %s', (retired) => {
		const coordinator = {
			transactionDomain: 'mock',
			begin: vi.fn(),
			setLockTimeout: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			isLockTimeout: vi.fn(),
			[retired]: vi.fn(),
		};

		expect(() =>
			createPackRegistry([
				{
					rules: [],
					operationSemantics: [],
					issuer: { artifact, execute: vi.fn() },
					executionCoordinator: coordinator as never,
					transactionDomain: 'mock',
				},
			]),
		).toThrow(retired);
	});
});
