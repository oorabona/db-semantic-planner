import type {
	ContainmentClosureDestructiveOutcome,
	LedgerAddress,
	LedgerClaimKind,
	LedgerHome,
	LedgerReservationRow,
} from '@dbsp/types';
import { ledgerAddressKey, sameLedgerAddress } from '@dbsp/types';
import { readPgCatalogueIdentity } from './catalogue-identity.js';

type Queryable = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
};

const DECLARABLE_REMOVAL_KINDS = new Set([
	'table',
	'column',
	'index',
	'constraint',
	'enum',
	'extension',
	'sequence',
]);

export interface PgRemovalEffectAddress {
	readonly address: LedgerAddress;
	/** Extension members are accounted by their adopted extension parent only. */
	readonly extensionMember?: boolean;
}

export type PgRemovalEffectsClosure =
	| {
			readonly kind: 'all-contained-or-managed';
			readonly root: LedgerAddress;
			readonly effects: readonly PgRemovalEffectAddress[];
			readonly managedDependents: readonly LedgerAddress[];
	  }
	| {
			readonly kind: 'reaches-unmanaged';
			readonly root: LedgerAddress;
			readonly effects: readonly PgRemovalEffectAddress[];
			readonly unmanaged: LedgerAddress;
	  }
	| { readonly kind: 'undecidable'; readonly reason: string };

function within(root: LedgerAddress, candidate: LedgerAddress): boolean {
	for (let parent = candidate.parent; parent; parent = parent.parent) {
		if (sameLedgerAddress(root, { ...parent, scope: root.scope })) return true;
	}
	return false;
}

/**
 * Classifies a fully enumerated cascade. Non-declarable dependent kinds refuse
 * before SQL; adopted-extension members are the sole parent-accounted carveout.
 */
export function classifyRemovalEffectsClosure(input: {
	readonly root: LedgerAddress;
	readonly effects: readonly PgRemovalEffectAddress[];
	readonly isManaged: (address: LedgerAddress) => boolean;
}): PgRemovalEffectsClosure {
	const managedDependents: LedgerAddress[] = [];
	for (const effect of input.effects) {
		if (effect.extensionMember && input.root.kind === 'extension') continue;
		if (!DECLARABLE_REMOVAL_KINDS.has(effect.address.kind))
			return {
				kind: 'reaches-unmanaged',
				root: input.root,
				effects: input.effects,
				unmanaged: effect.address,
			};
		if (within(input.root, effect.address)) continue;
		if (!input.isManaged(effect.address))
			return {
				kind: 'reaches-unmanaged',
				root: input.root,
				effects: input.effects,
				unmanaged: effect.address,
			};
		managedDependents.push(effect.address);
	}
	return {
		kind: 'all-contained-or-managed',
		root: input.root,
		effects: input.effects,
		managedDependents,
	};
}

/** Map closure results directly into the core authority's closed vocabulary. */
export function containmentAuthorityOutcome(
	closure: PgRemovalEffectsClosure,
): ContainmentClosureDestructiveOutcome {
	return closure.kind;
}

export function reservationsForRemovalClosure(input: {
	readonly closure: Extract<
		PgRemovalEffectsClosure,
		{ readonly kind: 'all-contained-or-managed' }
	>;
	readonly executionId: string;
	readonly rootClaimId: string;
	readonly claimKind?: LedgerClaimKind;
	readonly homeLedger: LedgerHome;
}): readonly LedgerReservationRow[] {
	const addresses = [
		input.closure.root,
		...input.closure.managedDependents,
	].filter(
		(address, index, all) =>
			all.findIndex((candidate) => sameLedgerAddress(candidate, address)) ===
			index,
	);
	return addresses.map((address) => ({
		address,
		claimKind: input.claimKind ?? 'retire-intent',
		executionId: input.executionId,
		rootClaimId: input.rootClaimId,
		homeLedger: input.homeLedger,
	}));
}

/**
 * PostgreSQL relation-backed addresses carry their object OID, while a column
 * carries its owning relation in `parentOid`. Both are valid pg_depend roots;
 * anything else remains unreadable evidence.
 */
function oidFromAddress(address: LedgerAddress): string | undefined {
	const value = address.catalogueIdentity?.value;
	const field = address.kind === 'column' ? 'parentOid' : 'oid';
	return value && typeof value === 'object' && !Array.isArray(value)
		? typeof (value as Record<string, unknown>)[field] === 'string'
			? (value as Record<string, string>)[field]
			: undefined
		: undefined;
}

/** pg_depend is keyed by the catalogue relation of the object being removed. */
function rootCatalogueClass(address: LedgerAddress): string | undefined {
	switch (address.kind) {
		case 'table':
		case 'index':
		case 'sequence':
		case 'column':
			return 'pg_class';
		case 'enum':
			return 'pg_type';
		case 'constraint':
			return 'pg_constraint';
		case 'extension':
			return 'pg_extension';
		default:
			return undefined;
	}
}

function addressFromRow(
	root: LedgerAddress,
	rootOid: string,
	row: Record<string, unknown>,
): PgRemovalEffectAddress | undefined {
	const kind = typeof row.kind === 'string' ? row.kind : undefined;
	const name = typeof row.name === 'string' ? row.name : undefined;
	if (!kind || !name) return undefined;
	const schema = typeof row.schema === 'string' ? row.schema : root.schema;
	const parentOid =
		typeof row.parent_oid === 'string' ? row.parent_oid : undefined;
	// A column name is meaningful only with its durable parent address.  Never
	// manufacture that parent from pg_class.relname: a same-named table in a
	// different scope must not acquire a reservation for this effect. The root
	// address is a ledger key and need not itself carry a catalogue identity;
	// rootOid is read from the live root instead.
	const parent =
		kind === 'column'
			? parentOid && rootOid === parentOid && root.kind === 'table'
				? root
				: parentOid &&
						root.parent &&
						oidFromAddress({ ...root.parent, scope: root.scope }) === parentOid
					? ({ ...root.parent, scope: root.scope } as LedgerAddress)
					: undefined
			: undefined;
	if (kind === 'column' && !parent) return undefined;
	return {
		address: {
			scope: root.scope,
			engine: root.engine,
			database: root.database,
			...(schema ? { schema } : {}),
			...(parent ? { parent } : {}),
			kind,
			name,
		},
		extensionMember: row.extension_member === true,
	};
}

/**
 * Enumerates PostgreSQL's dependency cascade before any destructive DDL. The
 * caller supplies ledger ownership; an unreadable catalogue is never evidence.
 */
export async function readPgRemovalEffectsClosure(input: {
	readonly executor: Queryable;
	readonly root: LedgerAddress;
	readonly isManaged: (address: LedgerAddress) => Promise<boolean>;
}): Promise<PgRemovalEffectsClosure> {
	try {
		const live = await readPgCatalogueIdentity(input.executor, input.root);
		const oid = live ? oidFromAddress(live as LedgerAddress) : undefined;
		if (!oid)
			return {
				kind: 'undecidable',
				reason: 'removal root is absent or has no readable catalogue identity',
			};
		const rootClass = rootCatalogueClass(input.root);
		if (!rootClass)
			return {
				kind: 'undecidable',
				reason: `removal root ${input.root.kind} has no supported catalogue class`,
			};
		// Internal pg_depend edges are implementation artifacts (for example a
		// table's implicit row type), not independently manageable cascade
		// targets. Add the root relation's declared attributes because PostgreSQL
		// does not represent their disappearance as dependency edges.
		const cascades = await input.executor.query(
			`WITH RECURSIVE cascade(classid, objid, objsubid) AS (` +
				`SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d WHERE d.refclassid = $2::regclass AND d.refobjid = $1::oid AND d.deptype IN ('n', 'a', 'e') ` +
				`UNION SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d JOIN cascade c ON d.refclassid = c.classid AND d.refobjid = c.objid WHERE d.deptype IN ('n', 'a', 'e')` +
				`), removal_effects(classid, objid, objsubid) AS (` +
				`SELECT classid, objid, objsubid FROM cascade ` +
				`UNION SELECT 'pg_class'::regclass, attribute.attrelid, attribute.attnum FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = $1::oid AND attribute.attnum > 0 AND NOT attribute.attisdropped` +
				`) SELECT CASE WHEN c.classid = 'pg_class'::regclass AND c.objsubid <> 0 THEN 'column' WHEN c.classid = 'pg_class'::regclass THEN CASE relation.relkind WHEN 'i' THEN 'index' WHEN 'I' THEN 'index' WHEN 'S' THEN 'sequence' ELSE 'table' END WHEN c.classid = 'pg_constraint'::regclass THEN 'constraint' WHEN c.classid = 'pg_type'::regclass THEN CASE WHEN type.typtype = 'e' THEN 'enum' ELSE 'undeclarable' END WHEN c.classid = 'pg_extension'::regclass THEN 'extension' ELSE 'undeclarable' END AS kind, namespace.nspname AS schema, COALESCE(attribute.attname::text, constraint_row.conname::text, type.typname::text, relation.relname::text, extension.extname::text, c.objid::text) AS name, COALESCE(attribute.attrelid::text, constraint_row.conrelid::text) AS parent_oid, EXISTS (SELECT 1 FROM pg_catalog.pg_depend extension_member WHERE extension_member.classid = c.classid AND extension_member.objid = c.objid AND extension_member.refclassid = 'pg_extension'::regclass AND extension_member.deptype = 'e') AS extension_member FROM removal_effects c LEFT JOIN pg_catalog.pg_class relation ON c.classid = 'pg_class'::regclass AND relation.oid = c.objid LEFT JOIN pg_catalog.pg_constraint constraint_row ON c.classid = 'pg_constraint'::regclass AND constraint_row.oid = c.objid LEFT JOIN pg_catalog.pg_type type ON c.classid = 'pg_type'::regclass AND type.oid = c.objid LEFT JOIN pg_catalog.pg_extension extension ON c.classid = 'pg_extension'::regclass AND extension.oid = c.objid LEFT JOIN pg_catalog.pg_attribute attribute ON c.classid = 'pg_class'::regclass AND c.objsubid <> 0 AND attribute.attrelid = c.objid AND attribute.attnum = c.objsubid LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid = COALESCE(relation.relnamespace, type.typnamespace) ORDER BY kind, schema, parent_oid, name`,
			[oid, rootClass],
		);
		const effects: PgRemovalEffectAddress[] = [];
		for (const row of cascades.rows) {
			const effect = addressFromRow(input.root, oid, row);
			if (!effect)
				return {
					kind: 'undecidable',
					reason: 'PostgreSQL removal containment row is malformed',
				};
			effects.push(effect);
		}
		const ownership = new Map<string, boolean>();
		for (const effect of effects) {
			if (effect.extensionMember && input.root.kind === 'extension') continue;
			if (within(input.root, effect.address)) continue;
			ownership.set(
				ledgerAddressKey(effect.address),
				await input.isManaged(effect.address),
			);
		}
		return classifyRemovalEffectsClosure({
			root: input.root,
			effects,
			isManaged: (address) => ownership.get(ledgerAddressKey(address)) === true,
		});
	} catch (error) {
		return {
			kind: 'undecidable',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
