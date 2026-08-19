import { createHash } from 'node:crypto';
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
	/** Physical pg_depend identity retained for the reviewed closure digest. */
	readonly physicalIdentity?: {
		readonly classId?: string;
		readonly objectId?: string;
		readonly objectSubId?: string;
		readonly parentClassId?: string;
		readonly parentObjectId?: string;
		readonly parentObjectSubId?: string;
		readonly dependencyType?: string;
	};
	/** Extension members are accounted by their adopted extension parent only. */
	readonly extensionMember?: boolean;
	/**
	 * An `i` dependency to an artifact owned by the referenced relation (row
	 * type, its array type, toast relation, index, or constraint). It remains
	 * cascade evidence, but is accounted by that relation rather than requiring
	 * a separate ledger ownership lookup.
	 */
	readonly internalOwned?: boolean;
}

/**
 * Only a positive catalogue-parent ownership proof makes an effect internal.
 * A system schema is a location, not dbsp ownership evidence: a user object
 * planted there remains a management candidate and therefore fails closed.
 */
function markInternalOwnership(
	effects: readonly PgRemovalEffectAddress[],
): readonly PgRemovalEffectAddress[] {
	const exactChildren = new Map<string, Set<number>>();
	const relationChildren = new Map<string, Set<number>>();
	for (const [index, effect] of effects.entries())
		for (const parent of parentAddresses(effect.address)) {
			addIndexedChild(exactChildren, ledgerAddressKey(parent), index);
			addIndexedChild(relationChildren, relationKey(parent), index);
		}
	const internal = new Set<number>();
	const queue: number[] = [];
	for (const [index, effect] of effects.entries())
		if (effect.internalOwned === true) {
			internal.add(index);
			queue.push(index);
		}
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const effect = effects[queue[cursor]!];
		if (!effect) continue;
		const children = new Set([
			...(exactChildren.get(ledgerAddressKey(effect.address)) ?? []),
			...(relationChildren.get(relationKey(effect.address)) ?? []),
		]);
		for (const child of children)
			if (!internal.has(child)) {
				internal.add(child);
				queue.push(child);
			}
	}
	return effects.map((effect, index) =>
		internal.has(index) ? { ...effect, internalOwned: true } : effect,
	);
}

function addIndexedChild(
	index: Map<string, Set<number>>,
	key: string,
	child: number,
): void {
	const children = index.get(key) ?? new Set<number>();
	children.add(child);
	index.set(key, children);
}

function* parentAddresses(address: LedgerAddress): Iterable<LedgerAddress> {
	for (let parent = address.parent; parent; parent = parent.parent)
		yield { ...parent, scope: address.scope } as LedgerAddress;
}

function relationKey(address: LedgerAddress): string {
	return JSON.stringify([
		address.scope,
		address.engine,
		address.database,
		address.schema ?? null,
		address.kind,
		address.name,
	]);
}

/**
 * OID-proven implementation artifacts are cascade evidence, never ledger
 * ownership candidates. Keeping this partition separate makes it impossible
 * for the ownership callback to receive an internal artifact.
 */
function managementCandidates(
	root: LedgerAddress,
	effects: readonly PgRemovalEffectAddress[],
): readonly PgRemovalEffectAddress[] {
	return effects.filter(
		(effect) =>
			!(effect.extensionMember && root.kind === 'extension') &&
			!effect.internalOwned,
	);
}

/**
 * Ask the ledger only about external cascade roots. An artifact whose parent
 * is another candidate will be resolved once that parent is shown contained or
 * managed; querying it first is both redundant and capable of crossing into a
 * system-owned implementation detail.
 */
function managementRoots(
	root: LedgerAddress,
	effects: readonly PgRemovalEffectAddress[],
): readonly PgRemovalEffectAddress[] {
	const external = managementCandidates(root, effects).filter(
		(effect) => !within(root, effect.address),
	);
	const externalKeys = new Set(
		external.map((effect) => ledgerAddressKey(effect.address)),
	);
	return external.filter(
		(effect) =>
			![...parentAddresses(effect.address)].some((parent) =>
				externalKeys.has(ledgerAddressKey(parent)),
			),
	);
}

export type PgRemovalEffectsClosure =
	| {
			readonly kind: 'all-contained-or-managed';
			readonly root: LedgerAddress;
			readonly effects: readonly PgRemovalEffectAddress[];
			readonly managedDependents: readonly LedgerAddress[];
			/** Exact, canonical cascade set admitted under the ledger locks. */
			readonly closureDigest: string;
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
 * A reservation is meaningful only for the exact CASCADE set that was read.
 * Keep the identity independent of PostgreSQL's catalogue row ordering.
 */
export const REMOVAL_CLOSURE_DIGEST_VERSION = 'v2';

type RemovalClosureClassification =
	| 'contained'
	| 'managed'
	| 'internal-owned'
	| 'extension-member'
	| 'unresolved';

function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object')
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(',')}}`;
	return JSON.stringify(value);
}

export function removalClosureDigest(
	root: LedgerAddress,
	effects: readonly PgRemovalEffectAddress[],
	classifications?: readonly RemovalClosureClassification[],
): string {
	const records = effects
		.map((effect, index) =>
			canonicalJson({
				address: ledgerAddressKey(effect.address),
				physicalIdentity: effect.physicalIdentity ?? null,
				extensionMember: effect.extensionMember === true,
				internalOwned: effect.internalOwned === true,
				classification: classifications?.[index] ?? 'unresolved',
			}),
		)
		.sort();
	const digest = createHash('sha256')
		.update(`${REMOVAL_CLOSURE_DIGEST_VERSION}\n`)
		.update(
			canonicalJson({
				address: ledgerAddressKey(root),
				catalogueIdentity: root.catalogueIdentity ?? null,
			}),
		)
		.update('\n')
		.update(records.join('\n'))
		.digest('hex');
	return `${REMOVAL_CLOSURE_DIGEST_VERSION}:${digest}`;
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
	const effects = markInternalOwnership(input.effects);
	const managedDependents: LedgerAddress[] = [];
	const candidateIndexes = effects
		.map((effect, index) => ({ effect, index }))
		.filter(
			({ effect }) =>
				!(effect.extensionMember && input.root.kind === 'extension') &&
				!effect.internalOwned,
		);
	for (const { effect } of candidateIndexes)
		if (!DECLARABLE_REMOVAL_KINDS.has(effect.address.kind))
			return {
				kind: 'reaches-unmanaged',
				root: input.root,
				effects,
				unmanaged: effect.address,
			};

	// Index each ancestor relation once. The queue below resolves containment in
	// one traversal, regardless of catalogue output order.
	const byAddress = new Map<string, number[]>();
	for (const { effect, index } of candidateIndexes) {
		const key = ledgerAddressKey(effect.address);
		const entries = byAddress.get(key) ?? [];
		entries.push(index);
		byAddress.set(key, entries);
	}
	const children = new Map<number, Set<number>>();
	for (const { effect, index } of candidateIndexes)
		for (const parent of parentAddresses(effect.address))
			for (const parentIndex of byAddress.get(ledgerAddressKey(parent)) ?? [])
				if (parentIndex !== index) {
					const entries = children.get(parentIndex) ?? new Set<number>();
					entries.add(index);
					children.set(parentIndex, entries);
				}
	const resolution: RemovalClosureClassification[] = effects.map((effect) =>
		effect.internalOwned
			? 'internal-owned'
			: effect.extensionMember && input.root.kind === 'extension'
				? 'extension-member'
				: 'unresolved',
	);
	const resolved = new Set<number>();
	const queue: number[] = [];
	for (const { effect, index } of candidateIndexes)
		if (within(input.root, effect.address)) {
			resolved.add(index);
			resolution[index] = 'contained';
			queue.push(index);
		}
	for (const root of managementRoots(input.root, effects)) {
		const key = ledgerAddressKey(root.address);
		for (const index of byAddress.get(key) ?? []) {
			if (resolved.has(index) || !input.isManaged(root.address)) continue;
			resolved.add(index);
			resolution[index] = 'managed';
			managedDependents.push(root.address);
			queue.push(index);
		}
	}
	for (let cursor = 0; cursor < queue.length; cursor += 1)
		for (const child of children.get(queue[cursor]!) ?? [])
			if (!resolved.has(child)) {
				resolved.add(child);
				resolution[child] = 'contained';
				queue.push(child);
			}
	const unmanaged = candidateIndexes.find(({ index }) => !resolved.has(index));
	if (unmanaged)
		return {
			kind: 'reaches-unmanaged',
			root: input.root,
			effects,
			unmanaged: unmanaged.effect.address,
		};
	return {
		kind: 'all-contained-or-managed',
		root: input.root,
		effects,
		managedDependents,
		closureDigest: removalClosureDigest(input.root, effects, resolution),
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
	const parentName =
		typeof row.parent_name === 'string' ? row.parent_name : undefined;
	const parentSchema =
		typeof row.parent_schema === 'string' ? row.parent_schema : schema;
	// A column name is meaningful only with its durable parent address.  Never
	// manufacture that parent from pg_class.relname: a same-named table in a
	// different scope must not acquire a reservation for this effect. The root
	// address is a ledger key and need not itself carry a catalogue identity;
	// rootOid is read from the live root instead.
	const parent =
		kind === 'column' || kind === 'constraint' || kind === 'index'
			? parentOid && rootOid === parentOid && root.kind === 'table'
				? root
				: parentOid &&
						root.parent &&
						oidFromAddress({ ...root.parent, scope: root.scope }) === parentOid
					? ({ ...root.parent, scope: root.scope } as LedgerAddress)
					: undefined
			: undefined;
	const addressedParent =
		parent ??
		(parentOid && parentName
			? ({
					scope: root.scope,
					engine: root.engine,
					database: root.database,
					...(parentSchema ? { schema: parentSchema } : {}),
					kind: 'table',
					name: parentName,
				} as LedgerAddress)
			: undefined);
	const attributeDefaultParent =
		row.attribute_default === true &&
		addressedParent &&
		typeof row.default_column_name === 'string'
			? ({
					...addressedParent,
					kind: 'column',
					name: row.default_column_name,
					parent: addressedParent,
				} as LedgerAddress)
			: undefined;
	const addressParent = attributeDefaultParent ?? addressedParent;
	if (
		(kind === 'column' || kind === 'constraint' || kind === 'index') &&
		!addressedParent
	)
		return undefined;
	return {
		address: {
			scope: root.scope,
			engine: root.engine,
			database: root.database,
			...(schema ? { schema } : {}),
			...(addressParent ? { parent: addressParent } : {}),
			kind,
			name,
		},
		physicalIdentity: {
			...(typeof row.class_id === 'string' ? { classId: row.class_id } : {}),
			...(typeof row.object_id === 'string' ? { objectId: row.object_id } : {}),
			...(typeof row.object_subid === 'string'
				? { objectSubId: row.object_subid }
				: {}),
			...(typeof row.parent_class_id === 'string'
				? { parentClassId: row.parent_class_id }
				: {}),
			...(typeof row.parent_object_id === 'string'
				? { parentObjectId: row.parent_object_id }
				: {}),
			...(typeof row.parent_object_subid === 'string'
				? { parentObjectSubId: row.parent_object_subid }
				: {}),
			...(typeof row.dependency_type === 'string'
				? { dependencyType: row.dependency_type }
				: {}),
		},
		extensionMember: row.extension_member === true,
		internalOwned: row.internal_owned === true,
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
		if (!live || !oid)
			return {
				kind: 'undecidable',
				reason: 'removal root is absent or has no readable catalogue identity',
			};
		const observedRoot: LedgerAddress = {
			...input.root,
			...(live.catalogueIdentity
				? { catalogueIdentity: live.catalogueIdentity }
				: {}),
		};
		const rootClass = rootCatalogueClass(observedRoot);
		if (!rootClass)
			return {
				kind: 'undecidable',
				reason: `removal root ${input.root.kind} has no supported catalogue class`,
			};
		// Internal pg_depend edges include a table's implicit row type. They are
		// still cascade edges: excluding them hides functions and composites that
		// PostgreSQL will drop through that type. Attributes are not dependency
		// rows, so add them only for a relation root that actually owns attributes.
		const relationRoot = observedRoot.kind === 'table';
		const columnRoot = observedRoot.kind === 'column';
		const cascades = await input.executor.query(
			`WITH RECURSIVE catalogue_classes(classid, class_key) AS (VALUES ('pg_class'::regclass, 'relation'), ('pg_constraint'::regclass, 'constraint'), ('pg_type'::regclass, 'type'), ('pg_attrdef'::regclass, 'attribute_default'), ('pg_extension'::regclass, 'extension')), cascade(classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype) AS (` +
				`SELECT d.classid, d.objid, d.objsubid, d.refclassid, d.refobjid, d.refobjsubid, d.deptype FROM pg_catalog.pg_depend d WHERE d.refclassid = $2::regclass AND d.refobjid = $1::oid AND (NOT $5::boolean OR d.refobjsubid = (SELECT attribute.attnum FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid = $1::oid AND attribute.attname = $4::text AND attribute.attnum > 0 AND NOT attribute.attisdropped)) AND d.deptype IN ('n', 'a', 'e', 'i') ` +
				`UNION SELECT d.classid, d.objid, d.objsubid, d.refclassid, d.refobjid, d.refobjsubid, d.deptype FROM pg_catalog.pg_depend d JOIN cascade c ON d.refclassid = c.classid AND d.refobjid = c.objid WHERE d.deptype IN ('n', 'a', 'e', 'i')` +
				`), removal_effects(classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype) AS (` +
				`SELECT classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype FROM cascade ` +
				`UNION SELECT 'pg_class'::regclass, attribute.attrelid, attribute.attnum, NULL::oid, NULL::oid, NULL::int4, NULL::"char" FROM pg_catalog.pg_attribute attribute WHERE $3::boolean AND attribute.attrelid = $1::oid AND attribute.attnum > 0 AND NOT attribute.attisdropped` +
				`) SELECT CASE WHEN catalogue_class.class_key = 'relation' AND c.objsubid <> 0 THEN 'column' WHEN catalogue_class.class_key = 'relation' THEN CASE relation.relkind WHEN 'i' THEN 'index' WHEN 'I' THEN 'index' WHEN 'S' THEN 'sequence' ELSE 'table' END WHEN catalogue_class.class_key = 'constraint' THEN 'constraint' WHEN catalogue_class.class_key = 'type' THEN CASE WHEN type.typtype = 'e' THEN 'enum' ELSE 'undeclarable' END WHEN catalogue_class.class_key = 'attribute_default' THEN 'undeclarable' WHEN catalogue_class.class_key = 'extension' THEN 'extension' ELSE 'undeclarable' END AS kind, namespace.nspname AS schema, CASE WHEN catalogue_class.class_key = 'attribute_default' THEN 'pg_attrdef:' || c.objid::text ELSE COALESCE(attribute.attname::text, constraint_row.conname::text, type.typname::text, relation.relname::text, extension.extname::text, c.objid::text) END AS name, default_attribute.attname::text AS default_column_name, COALESCE(attribute.attrelid::text, default_item.adrelid::text, constraint_row.conrelid::text, index_definition.indrelid::text, CASE WHEN c.deptype IN ('a', 'i') AND c.refclassid = (SELECT classid FROM catalogue_classes WHERE class_key = 'relation') THEN c.refobjid::text END) AS parent_oid, parent_relation.relname::text AS parent_name, parent_namespace.nspname::text AS parent_schema, c.classid::text AS class_id, c.objid::text AS object_id, c.objsubid::text AS object_subid, c.refclassid::text AS parent_class_id, c.refobjid::text AS parent_object_id, c.refobjsubid::text AS parent_object_subid, c.classid::regclass::text AS catalogue_class, c.deptype::text AS dependency_type, catalogue_class.class_key = 'attribute_default' AS attribute_default, CASE WHEN catalogue_class.classid IS NULL THEN c.classid::regclass::text END AS unhandled_class, EXISTS (SELECT 1 FROM pg_catalog.pg_depend extension_member WHERE extension_member.classid = c.classid AND extension_member.objid = c.objid AND extension_member.refclassid = (SELECT classid FROM catalogue_classes WHERE class_key = 'extension') AND extension_member.deptype = 'e') AS extension_member, catalogue_class.class_key = 'attribute_default' OR (c.deptype = 'i' AND (type.typrelid = c.refobjid OR type.typelem = c.refobjid OR index_definition.indrelid = c.refobjid OR constraint_row.conrelid = c.refobjid OR EXISTS (SELECT 1 FROM pg_catalog.pg_class internal_parent WHERE internal_parent.oid = c.refobjid AND internal_parent.reltoastrelid = c.objid))) AS internal_owned FROM removal_effects c LEFT JOIN catalogue_classes catalogue_class ON catalogue_class.classid = c.classid LEFT JOIN pg_catalog.pg_class relation ON catalogue_class.class_key = 'relation' AND relation.oid = c.objid LEFT JOIN pg_catalog.pg_index index_definition ON catalogue_class.class_key = 'relation' AND index_definition.indexrelid = c.objid LEFT JOIN pg_catalog.pg_constraint constraint_row ON catalogue_class.class_key = 'constraint' AND constraint_row.oid = c.objid LEFT JOIN pg_catalog.pg_attrdef default_item ON catalogue_class.class_key = 'attribute_default' AND default_item.oid = c.objid LEFT JOIN pg_catalog.pg_attribute attribute ON catalogue_class.class_key = 'relation' AND c.objsubid <> 0 AND attribute.attrelid = c.objid AND attribute.attnum = c.objsubid LEFT JOIN pg_catalog.pg_attribute default_attribute ON default_attribute.attrelid = default_item.adrelid AND default_attribute.attnum = default_item.adnum LEFT JOIN pg_catalog.pg_class parent_relation ON parent_relation.oid::text = COALESCE(attribute.attrelid::text, default_item.adrelid::text, constraint_row.conrelid::text, index_definition.indrelid::text, CASE WHEN c.deptype IN ('a', 'i') AND c.refclassid = (SELECT classid FROM catalogue_classes WHERE class_key = 'relation') THEN c.refobjid::text END) LEFT JOIN pg_catalog.pg_namespace parent_namespace ON parent_namespace.oid = parent_relation.relnamespace LEFT JOIN pg_catalog.pg_type type ON catalogue_class.class_key = 'type' AND type.oid = c.objid LEFT JOIN pg_catalog.pg_extension extension ON catalogue_class.class_key = 'extension' AND extension.oid = c.objid LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid = COALESCE(relation.relnamespace, type.typnamespace, parent_relation.relnamespace) ORDER BY kind, schema, parent_oid, name`,
			[
				oid,
				rootClass,
				relationRoot,
				columnRoot ? observedRoot.name : null,
				columnRoot,
			],
		);
		const effects: PgRemovalEffectAddress[] = [];
		for (const row of cascades.rows) {
			const unhandledClass =
				typeof row.unhandled_class === 'string'
					? row.unhandled_class
					: undefined;
			if (unhandledClass)
				return {
					kind: 'undecidable',
					reason: `undecidable: unhandled catalogue class ${unhandledClass} for ${typeof row.object_id === 'string' ? row.object_id : '<unknown>'}`,
				};
			const effect = addressFromRow(observedRoot, oid, row);
			if (!effect)
				return {
					kind: 'undecidable',
					reason: 'PostgreSQL removal containment row is malformed',
				};
			effects.push(effect);
		}
		const markedEffects = markInternalOwnership(effects);
		const ownership = await readManagementOwnership(
			observedRoot,
			markedEffects,
			input.isManaged,
		);
		return classifyRemovalEffectsClosure({
			root: observedRoot,
			effects: markedEffects,
			isManaged: (address) => ownership.get(ledgerAddressKey(address)) === true,
		});
	} catch (error) {
		return {
			kind: 'undecidable',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

async function readManagementOwnership(
	root: LedgerAddress,
	effects: readonly PgRemovalEffectAddress[],
	isManaged: (address: LedgerAddress) => Promise<boolean>,
): Promise<Map<string, boolean>> {
	const candidates = new Map<string, LedgerAddress>();
	for (const effect of managementRoots(root, effects))
		candidates.set(ledgerAddressKey(effect.address), effect.address);
	const entries = [...candidates.entries()];
	const ownership = new Map<string, boolean>();
	let next = 0;
	// Ownership reads can be expensive while destructive locks are held. Bound
	// independent pool work instead of serializing a large external closure.
	await Promise.all(
		Array.from({ length: Math.min(8, entries.length) }, async () => {
			while (next < entries.length) {
				const entry = entries[next];
				next += 1;
				if (!entry) continue;
				ownership.set(entry[0], await isManaged(entry[1]));
			}
		}),
	);
	return ownership;
}
