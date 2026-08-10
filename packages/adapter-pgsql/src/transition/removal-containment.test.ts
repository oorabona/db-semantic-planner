import {
	type LedgerAddress,
	ledgerAddressKey,
	sameLedgerAddress,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	classifyRemovalEffectsClosure,
	readPgRemovalEffectsClosure,
	removalClosureDigest,
	reservationsForRemovalClosure,
} from './removal-containment.js';

const root: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'db',
	schema: 'public',
	kind: 'table',
	name: 'orders',
};
const child: LedgerAddress = {
	...root,
	kind: 'column',
	name: 'obsolete',
	parent: root,
};
const dependent: LedgerAddress = {
	...root,
	kind: 'table',
	name: 'order_events',
};

describe('removal effects closure', () => {
	it('uses one key-order-insensitive identity for parents and ownership keys', () => {
		const persistedParent = {
			database: 'db',
			catalogueIdentity: {
				value: { oid: '42', source: 'catalogue' },
				format: 1,
				engine: 'postgresql',
			},
			name: 'orders',
			kind: 'table',
			schema: 'public',
			engine: 'postgresql',
		};
		const localParent = {
			engine: 'postgresql',
			database: 'db',
			schema: 'public',
			kind: 'table',
			name: 'orders',
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { source: 'catalogue', oid: '42' },
			},
		};
		const persisted = {
			...root,
			kind: 'column',
			name: 'id',
			parent: persistedParent,
		};
		const local = {
			...root,
			kind: 'column',
			name: 'id',
			parent: localParent,
		};

		expect(sameLedgerAddress(persisted, local)).toBe(true);
		expect(ledgerAddressKey(persisted)).toBe(ledgerAddressKey(local));
		expect(
			sameLedgerAddress(
				{ ...root, kind: 'column', name: 'id' },
				{ ...root, kind: 'column', name: 'id', parent: null as never },
			),
		).toBe(true);
	});

	it('accounts contained children and reserves the root plus every managed dependent', () => {
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [{ address: child }, { address: dependent }],
			isManaged: (address) => address.name === dependent.name,
		});
		expect(closure.kind).toBe('all-contained-or-managed');
		if (closure.kind !== 'all-contained-or-managed') return;
		expect(closure.managedDependents).toEqual([dependent]);
		expect(
			reservationsForRemovalClosure({
				closure,
				executionId: 'run',
				rootClaimId: 'claim',
				homeLedger: { scope: 'schema', schema: 'public' },
			}).map((reservation) => reservation.address),
		).toEqual([root, dependent]);
	});

	it('refuses the whole removal when an unmanaged cascade escapes containment', () => {
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [{ address: dependent }],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('reaches-unmanaged');
	});

	it('keeps a persisted closure digest reflexive across JSON load', () => {
		const effects = [
			{ address: child },
			{ address: dependent, internalOwned: true },
		] as const;
		const loaded = JSON.parse(JSON.stringify(effects)) as typeof effects;
		expect(removalClosureDigest(root, loaded)).toBe(
			removalClosureDigest(root, effects),
		);
	});

	it('parent-accounts extension members without per-member reservations', () => {
		const extension = {
			...root,
			kind: 'extension',
			name: 'hstore',
		} as LedgerAddress;
		const closure = classifyRemovalEffectsClosure({
			root: extension,
			effects: [
				{
					address: { ...root, kind: 'undeclarable', name: 'hstore_type' },
					extensionMember: true,
				},
			],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('all-contained-or-managed');
	});

	it('accounts a root-owned internal row type without treating it as an unmanaged escape', () => {
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [
				{
					address: { ...root, kind: 'undeclarable', name: 'orders' },
					internalOwned: true,
				},
			],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('all-contained-or-managed');
	});

	it('marks a child of a user-schema internal artifact before consultation', () => {
		const rowType = {
			...root,
			kind: 'undeclarable',
			name: 'orders',
		} as LedgerAddress;
		const arrayType = {
			...root,
			kind: 'undeclarable',
			name: '_orders',
			parent: rowType,
		} as LedgerAddress;
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [
				{ address: rowType, internalOwned: true },
				{ address: arrayType },
			],
			isManaged: () => {
				throw new Error('internal artifacts must not reach isManaged');
			},
		});
		expect(closure).toMatchObject({
			kind: 'all-contained-or-managed',
			effects: [
				{ address: rowType, internalOwned: true },
				{ address: arrayType, internalOwned: true },
			],
		});
	});

	it('marks every system-schema resident before consultation', () => {
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: (['pg_toast', 'pg_catalog', 'information_schema'] as const).map(
				(schema) => ({
					address: {
						...root,
						schema,
						kind: 'undeclarable',
						name: `${schema}_artifact`,
					} as LedgerAddress,
				}),
			),
			isManaged: () => {
				throw new Error('system residents must not reach isManaged');
			},
		});
		expect(closure).toMatchObject({
			kind: 'all-contained-or-managed',
			effects: [
				{ internalOwned: true },
				{ internalOwned: true },
				{ internalOwned: true },
			],
		});
	});

	it('still refuses an independent dependent reached through a root-owned row type', () => {
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [
				{
					address: { ...root, kind: 'undeclarable', name: 'orders' },
					internalOwned: true,
				},
				{
					address: {
						...root,
						kind: 'undeclarable',
						name: 'uses_orders_row_type',
					},
				},
			],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('reaches-unmanaged');
	});

	it('maps recorded internal catalogue fixture rows to root-owned containment', async () => {
		let calls = 0;
		const queries: string[] = [];
		const closure = await readPgRemovalEffectsClosure({
			executor: {
				query: async (sql) => {
					calls += 1;
					queries.push(sql);
					return calls === 1
						? { rows: [{ oid: '42' }] }
						: {
								rows: [
									{
										kind: 'undeclarable',
										name: 'orders',
										schema: 'public',
										internal_owned: true,
									},
								],
							};
				},
			},
			root,
			isManaged: async () => false,
		});
		expect(closure.kind).toBe('all-contained-or-managed');
		// The fixture routes the generated closure SQL through the executor. The
		// real PostgreSQL syntax/type check remains the E2E orchestrator battery.
		expect(queries[1]).toContain(
			"('pg_attrdef'::regclass, 'attribute_default')",
		);
		expect(queries[1]).toContain(
			"catalogue_class.class_key = 'attribute_default' AS attribute_default",
		);
		expect(queries[1]).toContain(
			'parent_relation.oid::text = COALESCE(attribute.attrelid::text',
		);
	});

	it('does not derive a pg_toast ledger lookup for a system-resident toast or its index', async () => {
		const rootWithLedger = {
			...root,
			schema: 'unit_with_ledger',
			name: 'managed_parent',
		};
		const ownershipLookups: LedgerAddress[] = [];
		let calls = 0;
		const closure = await readPgRemovalEffectsClosure({
			executor: {
				query: async () => {
					calls += 1;
					return calls === 1
						? { rows: [{ oid: '42' }] }
						: {
								rows: [
									{
										kind: 'table',
										name: 'pg_toast_42',
										schema: 'pg_toast',
									},
									{
										// The TOAST relation's own index is not directly OID-proven.
										// Its system schema and internal parent must both keep it out
										// of the ledger consultation.
										kind: 'index',
										name: 'pg_toast_42_index',
										schema: 'pg_toast',
										parent_oid: '44',
										parent_name: 'pg_toast_42',
										parent_schema: 'pg_toast',
									},
									{
										kind: 'table',
										name: 'managed_child',
										schema: 'unit_with_ledger',
									},
								],
							};
				},
			},
			root: rootWithLedger,
			isManaged: async (address) => {
				ownershipLookups.push(address);
				return address.name === 'managed_child';
			},
		});
		expect(closure.kind).toBe('all-contained-or-managed');
		expect(ownershipLookups).toEqual([
			{ ...rootWithLedger, kind: 'table', name: 'managed_child' },
		]);
	});

	it('accounts a reviewed replacement array sibling through its type element OID', async () => {
		let calls = 0;
		const queries: string[] = [];
		const ownershipLookups: LedgerAddress[] = [];
		const replacement = { ...root, name: 'replace_me' };
		const closure = await readPgRemovalEffectsClosure({
			executor: {
				query: async (sql) => {
					calls += 1;
					queries.push(sql);
					return calls === 1
						? { rows: [{ oid: '43' }] }
						: {
								rows: [
									{
										kind: 'undeclarable',
										name: '_replace_me',
										schema: 'public',
										internal_owned: true,
									},
								],
							};
				},
			},
			root: replacement,
			isManaged: async (address) => {
				ownershipLookups.push(address);
				return false;
			},
		});
		expect(closure.kind).toBe('all-contained-or-managed');
		expect(ownershipLookups).toEqual([]);
		expect(queries[1]).toContain('type.typelem = c.refobjid');
	});

	it('derives a table attribute parent from the live root OID, not the ledger key', async () => {
		const calls: (readonly unknown[] | undefined)[] = [];
		const closure = await readPgRemovalEffectsClosure({
			executor: {
				query: async (_sql, params) => {
					calls.push(params);
					return calls.length === 1
						? {
								rows: [{ oid: '42' }],
							}
						: {
								rows: [
									{
										kind: 'column',
										name: 'id',
										schema: 'public',
										parent_oid: '42',
									},
								],
							};
				},
			},
			root,
			isManaged: async () => false,
		});
		expect(calls[1]).toEqual(['42', 'pg_class', true, null, false]);
		expect(closure).toMatchObject({
			kind: 'all-contained-or-managed',
			effects: [{ address: { kind: 'column', name: 'id', parent: root } }],
		});
	});

	it('refuses an unhandled catalogue class as undecidable before management lookup', async () => {
		let calls = 0;
		const closure = await readPgRemovalEffectsClosure({
			executor: {
				query: async () => {
					calls += 1;
					return calls === 1
						? { rows: [{ oid: '42' }] }
						: {
								rows: [
									{
										unhandled_class: 'pg_proc',
										object_id: '22630',
									},
								],
							};
				},
			},
			root,
			isManaged: async () => {
				throw new Error('unhandled catalogue classes must not reach isManaged');
			},
		});
		expect(closure).toEqual({
			kind: 'undecidable',
			reason: 'undecidable: unhandled catalogue class pg_proc for 22630',
		});
	});

	it('SC-51 consults management only for non-internal cascade dependents', async () => {
		let calls = 0;
		const ownershipLookups: LedgerAddress[] = [];
		const closure = await readPgRemovalEffectsClosure({
			executor: {
				query: async () => {
					calls += 1;
					return calls === 1
						? { rows: [{ oid: '42' }] }
						: {
								// Captured from PG 18 after CREATE TABLE managed_parent
								// (id serial PRIMARY KEY, obsolete text, payload text) and
								// CREATE INDEX managed_parent_payload_idx ON managed_parent
								// (payload). Both pg_attrdef edges are internal to id.
								rows: [
									{
										kind: 'column',
										name: 'id',
										schema: 'public',
										parent_oid: '42',
									},
									{
										kind: 'column',
										name: 'payload',
										schema: 'public',
										parent_oid: '42',
										catalogue_class: 'pg_class',
										dependency_type: 'i',
									},
									{
										kind: 'constraint',
										name: 'orders_pkey',
										schema: 'public',
										parent_oid: '42',
										parent_name: 'orders',
										parent_schema: 'public',
										catalogue_class: 'pg_constraint',
										dependency_type: 'a',
									},
									{
										kind: 'index',
										name: 'orders_pkey',
										schema: 'public',
										parent_oid: '42',
										parent_name: 'orders',
										parent_schema: 'public',
										catalogue_class: 'pg_class',
										dependency_type: 'i',
									},
									// The `a` edge for a column default is projected as this
									// relation parent, even though the sequence has no own parent.
									{
										kind: 'sequence',
										name: 'orders_id_seq',
										schema: 'public',
										parent_oid: '42',
										parent_name: 'orders',
										parent_schema: 'public',
									},
									{
										kind: 'undeclarable',
										name: 'pg_attrdef:77',
										schema: 'public',
										parent_oid: '42',
										parent_name: 'orders',
										parent_schema: 'public',
										catalogue_class: 'pg_attrdef',
										dependency_type: 'n',
										attribute_default: true,
										default_column_name: 'id',
										internal_owned: true,
									},
									{
										kind: 'undeclarable',
										name: 'pg_attrdef:77',
										schema: 'public',
										parent_oid: '42',
										parent_name: 'orders',
										parent_schema: 'public',
										catalogue_class: 'pg_attrdef',
										dependency_type: 'a',
										attribute_default: true,
										default_column_name: 'id',
										internal_owned: true,
									},
									{
										kind: 'undeclarable',
										name: 'orders',
										schema: 'public',
										internal_owned: true,
									},
									{
										// The implicit array type depends internally on the
										// table row type, so it must never reach isManaged.
										kind: 'undeclarable',
										name: '_orders',
										schema: 'public',
										catalogue_class: 'pg_type',
										dependency_type: 'i',
										internal_owned: true,
									},
									{
										kind: 'table',
										name: 'pg_toast_42',
										schema: 'pg_toast',
									},
									{
										kind: 'index',
										name: 'pg_toast_42_index',
										schema: 'pg_toast',
										parent_oid: '44',
										parent_name: 'pg_toast_42',
										parent_schema: 'pg_toast',
									},
									{
										kind: 'table',
										name: 'managed_child',
										schema: 'public',
									},
									{
										kind: 'sequence',
										name: 'managed_child_id_seq',
										schema: 'public',
										parent_oid: '43',
										parent_name: 'managed_child',
										parent_schema: 'public',
									},
								],
							};
				},
			},
			root,
			isManaged: async (address) => {
				ownershipLookups.push(address);
				return address.name === 'managed_child';
			},
		});
		expect(closure.kind).toBe('all-contained-or-managed');
		if (closure.kind !== 'all-contained-or-managed') return;
		expect(
			closure.effects.map((effect) => ({
				kind: effect.address.kind,
				name: effect.address.name,
				parent: effect.address.parent?.name,
				internalOwned: effect.internalOwned ?? false,
			})),
		).toEqual([
			{ kind: 'column', name: 'id', parent: 'orders', internalOwned: false },
			{
				kind: 'column',
				name: 'payload',
				parent: 'orders',
				internalOwned: false,
			},
			{
				kind: 'constraint',
				name: 'orders_pkey',
				parent: 'orders',
				internalOwned: false,
			},
			{
				kind: 'index',
				name: 'orders_pkey',
				parent: 'orders',
				internalOwned: false,
			},
			{
				kind: 'sequence',
				name: 'orders_id_seq',
				parent: 'orders',
				internalOwned: false,
			},
			{
				kind: 'undeclarable',
				name: 'pg_attrdef:77',
				parent: 'id',
				internalOwned: true,
			},
			{
				kind: 'undeclarable',
				name: 'pg_attrdef:77',
				parent: 'id',
				internalOwned: true,
			},
			{
				kind: 'undeclarable',
				name: 'orders',
				parent: undefined,
				internalOwned: true,
			},
			{
				kind: 'undeclarable',
				name: '_orders',
				parent: undefined,
				internalOwned: true,
			},
			{
				kind: 'table',
				name: 'pg_toast_42',
				parent: undefined,
				internalOwned: true,
			},
			{
				kind: 'index',
				name: 'pg_toast_42_index',
				parent: 'pg_toast_42',
				internalOwned: true,
			},
			{
				kind: 'table',
				name: 'managed_child',
				parent: undefined,
				internalOwned: false,
			},
			{
				kind: 'sequence',
				name: 'managed_child_id_seq',
				parent: 'managed_child',
				internalOwned: false,
			},
		]);
		expect(closure.managedDependents).toEqual([
			{ ...root, kind: 'table', name: 'managed_child' },
		]);
		expect(ownershipLookups).toEqual([
			{ ...root, kind: 'table', name: 'managed_child' },
		]);
	});

	for (const [kind, catalogueClass] of [
		['index', 'pg_class'],
		['sequence', 'pg_class'],
		['enum', 'pg_type'],
		['constraint', 'pg_constraint'],
		['extension', 'pg_extension'],
		['column', 'pg_class'],
	] as const)
		it(`seeds ${kind} roots with ${catalogueClass}`, async () => {
			const calls: (readonly unknown[] | undefined)[] = [];
			const columnRoot = {
				...root,
				kind,
				name: `${kind}_root`,
				...(kind === 'column' ? { parent: root } : {}),
			};
			const closure = await readPgRemovalEffectsClosure({
				executor: {
					query: async (_sql, params) => {
						calls.push(params);
						return calls.length === 1
							? {
									rows: [
										{
											...(kind === 'column'
												? { parent_oid: '43', name: columnRoot.name }
												: { oid: '43' }),
										},
									],
								}
							: { rows: [] };
					},
				},
				root: columnRoot,
				isManaged: async () => false,
			});
			expect(calls[1]).toEqual([
				'43',
				catalogueClass,
				false,
				kind === 'column' ? columnRoot.name : null,
				kind === 'column',
			]);
			expect(closure.kind).toBe('all-contained-or-managed');
		});
});
