import type { NormalizedManagedStep } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { validateNormalizedManagedStepManifest } from './validation.js';

const root = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'public',
	kind: 'table' as const,
	name: 'orders',
};

function step(
	overrides: Partial<NormalizedManagedStep> = {},
): NormalizedManagedStep {
	return {
		stepKey: 'step:orders',
		order: 0,
		segmentId: 'segment:orders',
		dependencyOrder: [],
		closure: {
			root,
			members: [
				{
					plannedClaimKey: 'step:orders:member',
					address: {
						...root,
						kind: 'column',
						name: 'account_id',
						parent: {
							engine: root.engine,
							database: root.database,
							schema: root.schema,
							kind: root.kind,
							name: root.name,
						},
					},
				},
			],
		},
		claimKind: 'retire-intent',
		plannedClaimKeys: ['step:orders:root'],
		statementBundle: { statements: [] },
		classification: 'removal',
		requiresVacancy: false,
		expectedDeclaration: {
			value: { nested: { stable: true } },
			digest: 'declaration',
		},
		expectedCatalogueIdentity: {
			engine: 'postgresql',
			format: 1,
			value: { oid: '42' },
		},
		selection: { kind: 'optional-action', selector: 'table:orders' },
		replayPolicy: 'fresh-live-only',
		...overrides,
	};
}

function addressedStep(
	overrides: Partial<NormalizedManagedStep> = {},
): NormalizedManagedStep {
	const { closure: _closure, ...base } = step();
	return { ...base, address: root, ...overrides } as NormalizedManagedStep;
}

describe('validated managed-step manifests', () => {
	it('S04: clones and deep-freezes every authority-bearing node', () => {
		const source = step();
		const result = validateNormalizedManagedStepManifest([source]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const validated = result.manifest.steps[0]!;
		expect(validated).not.toBe(source);
		expect(Object.isFrozen(validated.closure)).toBe(true);
		expect(Object.isFrozen(validated.closure?.root)).toBe(true);
		expect(Object.isFrozen(validated.closure?.members)).toBe(true);
		expect(Object.isFrozen(validated.closure?.members[0]?.address)).toBe(true);
		expect(Object.isFrozen(validated.closure?.members[0]?.address.parent)).toBe(
			true,
		);
		expect(Object.isFrozen(validated.expectedDeclaration?.value)).toBe(true);
		expect(Object.isFrozen(validated.expectedCatalogueIdentity?.value)).toBe(
			true,
		);
		expect(Object.isFrozen(validated.selection)).toBe(true);
		expect(() => {
			(validated.closure!.members[0]!.address as { name: string }).name =
				'attacker';
		}).toThrow(TypeError);
		expect(validated.closure?.members[0]?.address.name).toBe('account_id');
		expect(() => {
			(source.closure!.members[0]!.address as { name: string }).name =
				'source-change';
		}).not.toThrow();
		expect(validated.closure?.members[0]?.address.name).toBe('account_id');
	});

	it('S04 deep-freezes parsed adoption lifecycle shape and root address', () => {
		const result = validateNormalizedManagedStepManifest([
			addressedStep({
				claimKind: 'adopt-intent',
				classification: 'non-destructive',
				statementBundle: { statements: [] },
				replayPolicy: 'recorded',
				selection: { kind: 'adoption', selector: 'table:orders' },
				lifecycle: {
					kind: 'adoption',
					shape: { name: 'orders', nested: { column: 'id' } } as never,
				},
			}),
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const validated = result.manifest.steps[0]!;
		expect(Object.isFrozen(validated.address)).toBe(true);
		expect(Object.isFrozen(validated.lifecycle)).toBe(true);
		expect(
			Object.isFrozen(
				(validated.lifecycle as unknown as { shape: object }).shape,
			),
		).toBe(true);
		expect(() => {
			(
				validated.lifecycle as unknown as {
					shape: { nested: { column: string } };
				}
			).shape.nested.column = 'attacker';
		}).toThrow(TypeError);
	});

	it.each([
		[
			'adoption',
			addressedStep({
				claimKind: 'intent',
				classification: 'non-destructive',
				replayPolicy: 'recorded',
				lifecycle: { kind: 'adoption', shape: { name: 'orders' } as never },
				selection: { kind: 'adoption', selector: 'table:orders' },
			}),
		],
		[
			'readdress',
			addressedStep({
				claimKind: 'intent',
				classification: 'paired-readdress',
				replayPolicy: 'recorded',
				lifecycle: {
					kind: 'readdress',
					declaration: {
						from: { name: 'orders' },
						to: { name: 'orders_next' },
					},
				},
				selection: { kind: 'readdress', selector: 'table:orders' },
			}),
		],
		[
			'replacement',
			step({
				selection: { kind: 'replacement', selector: 'table:orders' },
				claimKind: 'intent',
			}),
		],
		['removal', step({ claimKind: 'intent' })],
	] as const)('refuses invalid %s lifecycle coupling', (kind, invalid) => {
		const result = validateNormalizedManagedStepManifest([invalid]);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.detail).toContain(kind);
	});

	it('P01: validates dependency order through the first-pass key map', () => {
		const first = step({
			stepKey: 'first',
			order: 0,
			plannedClaimKeys: ['first:root'],
		});
		const second = step({
			stepKey: 'second',
			order: 1,
			plannedClaimKeys: ['second:root'],
			dependencyOrder: ['first'],
		});
		expect(validateNormalizedManagedStepManifest([first, second]).ok).toBe(
			true,
		);
		expect(
			validateNormalizedManagedStepManifest([
				first,
				{ ...second, dependencyOrder: ['missing'] },
			]),
		).toMatchObject({
			ok: false,
			detail: expect.stringContaining('missing dependency'),
		});
	});
});
