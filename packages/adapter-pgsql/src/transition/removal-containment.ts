import type {
	ContainmentClosureDestructiveOutcome,
	LedgerAddress,
	LedgerClaimKind,
	LedgerHome,
	LedgerReservationRow,
} from '@dbsp/types';
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
			readonly effects: readonly PgRemovalEffectAddress[];
			readonly managedDependents: readonly LedgerAddress[];
	  }
	| {
			readonly kind: 'reaches-unmanaged';
			readonly effects: readonly PgRemovalEffectAddress[];
			readonly unmanaged: LedgerAddress;
	  }
	| { readonly kind: 'undecidable'; readonly reason: string };

function sameAddress(left: LedgerAddress, right: LedgerAddress): boolean {
	return (
		left.scope === right.scope &&
		left.engine === right.engine &&
		left.database === right.database &&
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.name === right.name &&
		JSON.stringify(left.parent ?? null) === JSON.stringify(right.parent ?? null)
	);
}

function within(root: LedgerAddress, candidate: LedgerAddress): boolean {
	for (let parent = candidate.parent; parent; parent = parent.parent) {
		if (sameAddress(root, { ...parent, scope: root.scope })) return true;
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
				effects: input.effects,
				unmanaged: effect.address,
			};
		if (within(input.root, effect.address)) continue;
		if (!input.isManaged(effect.address))
			return {
				kind: 'reaches-unmanaged',
				effects: input.effects,
				unmanaged: effect.address,
			};
		managedDependents.push(effect.address);
	}
	return {
		kind: 'all-contained-or-managed',
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
	return input.closure.managedDependents.map((address) => ({
		address,
		claimKind: input.claimKind ?? 'retire-intent',
		executionId: input.executionId,
		rootClaimId: input.rootClaimId,
		homeLedger: input.homeLedger,
	}));
}

function oidFromAddress(address: LedgerAddress): string | undefined {
	const value = address.catalogueIdentity?.value;
	return value && typeof value === 'object' && !Array.isArray(value)
		? typeof (value as Record<string, unknown>).oid === 'string'
			? (value as Record<string, string>).oid
			: undefined
		: undefined;
}

function addressFromRow(
	root: LedgerAddress,
	row: Record<string, unknown>,
): PgRemovalEffectAddress | undefined {
	const kind = typeof row.kind === 'string' ? row.kind : undefined;
	const name = typeof row.name === 'string' ? row.name : undefined;
	if (!kind || !name) return undefined;
	const schema = typeof row.schema === 'string' ? row.schema : root.schema;
	const parentName =
		typeof row.parent_name === 'string' ? row.parent_name : undefined;
	return {
		address: {
			scope: root.scope,
			engine: root.engine,
			database: root.database,
			...(schema ? { schema } : {}),
			...(parentName
				? { parent: { ...root, name: parentName, kind: 'table' } }
				: {}),
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
		// Internal pg_depend edges are implementation artifacts (for example a
		// table's implicit row type), not independently manageable cascade
		// targets. Add the root relation's declared attributes because PostgreSQL
		// does not represent their disappearance as dependency edges.
		const cascades = await input.executor.query(
			`WITH RECURSIVE cascade(classid, objid, objsubid) AS (` +
				`SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d WHERE d.refobjid = $1::oid AND d.deptype IN ('n', 'a') ` +
				`UNION SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d JOIN cascade c ON d.refobjid = c.objid WHERE d.deptype IN ('n', 'a')` +
				`), removal_effects(classid, objid, objsubid) AS (` +
				`SELECT classid, objid, objsubid FROM cascade ` +
				`UNION SELECT 'pg_class'::regclass, attribute.attrelid, attribute.attnum FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = $1::oid AND attribute.attnum > 0 AND NOT attribute.attisdropped` +
				`) SELECT CASE WHEN c.classid = 'pg_class'::regclass AND c.objsubid <> 0 THEN 'column' WHEN c.classid = 'pg_class'::regclass THEN CASE relation.relkind WHEN 'i' THEN 'index' WHEN 'S' THEN 'sequence' ELSE 'table' END WHEN c.classid = 'pg_constraint'::regclass THEN 'constraint' WHEN c.classid = 'pg_type'::regclass THEN CASE WHEN type.typtype = 'e' THEN 'enum' ELSE 'undeclarable' END ELSE 'undeclarable' END AS kind, namespace.nspname AS schema, COALESCE(attribute.attname, constraint_row.conname, type.typname, relation.relname, c.objid::text) AS name, parent_relation.relname AS parent_name, EXISTS (SELECT 1 FROM pg_catalog.pg_depend extension_member WHERE extension_member.classid = c.classid AND extension_member.objid = c.objid AND extension_member.refclassid = 'pg_extension'::regclass AND extension_member.deptype = 'e') AS extension_member FROM removal_effects c LEFT JOIN pg_catalog.pg_class relation ON c.classid = 'pg_class'::regclass AND relation.oid = c.objid LEFT JOIN pg_catalog.pg_constraint constraint_row ON c.classid = 'pg_constraint'::regclass AND constraint_row.oid = c.objid LEFT JOIN pg_catalog.pg_type type ON c.classid = 'pg_type'::regclass AND type.oid = c.objid LEFT JOIN pg_catalog.pg_attribute attribute ON c.classid = 'pg_class'::regclass AND c.objsubid <> 0 AND attribute.attrelid = c.objid AND attribute.attnum = c.objsubid LEFT JOIN pg_catalog.pg_class parent_relation ON parent_relation.oid = COALESCE(constraint_row.conrelid, attribute.attrelid) LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid = COALESCE(relation.relnamespace, type.typnamespace, parent_relation.relnamespace) ORDER BY kind, schema, parent_name, name`,
			[oid],
		);
		const effects: PgRemovalEffectAddress[] = [];
		for (const row of cascades.rows) {
			const effect = addressFromRow(input.root, row);
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
				JSON.stringify(effect.address),
				await input.isManaged(effect.address),
			);
		}
		return classifyRemovalEffectsClosure({
			root: input.root,
			effects,
			isManaged: (address) => ownership.get(JSON.stringify(address)) === true,
		});
	} catch (error) {
		return {
			kind: 'undecidable',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
