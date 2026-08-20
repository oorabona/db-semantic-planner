/** Live-only executor for the no-argument schema-differ plan. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	compareSchemata,
	createPgsqlAdapter,
	dbTypesEqual,
	executePgAdmittedOperation,
	executePgDeclaredAdoption,
	executePgPersistedTableReaddress,
	type PgLockedRun,
	type PgOutcomeCheckpointObserver,
	preflightPgDeclaredAdoption,
	readPgCatalogueIdentity,
	readPgLedgerAddressChain,
	readPgLedgerScopeCurrency,
	readPgRemovalEffectsClosure,
} from '@dbsp/adapter-pgsql';
import {
	outcomeClaimEventId,
	outcomeClaimId,
	projectLedgerChain,
	type ValidatedManagedStepManifest,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { decideDestructiveDecision } from '@dbsp/core/internal';
import type {
	CascadeCoveredOutcomeClaimPlan,
	ContainmentClosureDestructiveOutcome,
	DestructiveAuthorityEvidence,
	LedgerAddress,
	LedgerChainMember,
	LedgerClaimKind,
	LedgerHome,
	LedgerPayload,
	ModelIR,
	NormalizedManagedStep,
	ScopedApprovalSet,
	TableIR,
} from '@dbsp/types';
import { ledgerAddressKey } from '@dbsp/types';
import type { Pool } from 'pg';

function managedSteps(manifest: ValidatedManagedStepManifest) {
	return manifest.steps;
}

/**
 * A reviewed replacement selector is canonicalized as `table:<name>`, while
 * the CLI has always accepted the unqualified table name as a shorthand. Keep
 * the comparison at the reviewed manifest boundary so every subsequent
 * authority decision sees the same selected set.
 */
function matchesReviewedReplacementSelector(
	reviewed: string,
	provided: string,
): boolean {
	return (
		provided === reviewed ||
		(reviewed.startsWith('table:') &&
			provided === reviewed.slice('table:'.length))
	);
}

export type GeneratorExecutionResult =
	| { readonly outcome: 'completed' }
	| {
			readonly outcome: 'partially-applied';
			readonly detail: string;
			readonly completedStepKeys: readonly string[];
			readonly notStartedStepKeys: readonly string[];
	  }
	| { readonly outcome: 'selection-incomplete'; readonly detail: string }
	| { readonly outcome: 'adoption-refused'; readonly detail: string }
	| { readonly outcome: 'readdress-unsupported'; readonly detail: string }
	| { readonly outcome: 'readdress-refused'; readonly detail: string }
	| {
			readonly outcome: 'destructive-authority-refused';
			readonly detail: string;
			/** The exact live authority that remained withheld at admission. */
			readonly refusal?: { readonly withheldAuthority: string };
	  }
	| { readonly outcome: 'prior-step-events-refusal'; readonly detail: string }
	| {
			readonly outcome: 'recovery-required';
			readonly claimId: string;
			readonly detail: string;
	  }
	| { readonly outcome: 'transport-ambiguous'; readonly detail: string }
	| { readonly outcome: 'execution-failed'; readonly detail: string };

function modelForAdoption(table: TableIR): ModelIR {
	const tables = new Map([[table.name, table]]);
	const relations = new Map();
	return {
		tables,
		relations,
		getTable: (name) => tables.get(name),
		getRelation: (name) => relations.get(name),
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

/** Adoption uses the established schema differ; it has no bespoke comparator. */
async function adoptionShapeMatches(
	pool: Pool,
	schema: string,
	shape: TableIR,
): Promise<boolean> {
	const live = await createPgsqlAdapter(pool).introspect({ schema });
	const diff = compareSchemata(modelForAdoption(shape), live);
	return !diff.changes.some((change) => change.table === shape.name);
}

const SYSTEM_LEDGER_SCHEMAS = new Set([
	'pg_toast',
	'pg_catalog',
	'information_schema',
]);

/** Preserves the candidate that made ledger-home evidence impossible. */
class SystemSchemaLedgerHomeError extends Error {
	readonly address: LedgerAddress;

	constructor(address: LedgerAddress) {
		super(
			`SystemSchemaLedgerHomeError: ledger home is unavailable for system schema ${address.schema}: ${ledgerAddressKey(address)}`,
		);
		this.name = 'SystemSchemaLedgerHomeError';
		this.address = address;
	}
}

function home(address: LedgerAddress): LedgerHome {
	if (
		address.scope !== 'database' &&
		address.schema &&
		SYSTEM_LEDGER_SCHEMAS.has(address.schema)
	)
		throw new SystemSchemaLedgerHomeError(address);
	return address.scope === 'database'
		? ({ scope: 'database' } as const)
		: address.schema
			? ({ scope: 'schema', schema: address.schema } as const)
			: (() => {
					throw new Error(
						`schema-scoped generated address ${address.name} has no schema ledger`,
					);
				})();
}

function acceptance(planDigest: string, approval: ScopedApprovalSet) {
	return approval.approvals.some(
		(grant) => grant.class === `destructive-plan-accepted:${planDigest}`,
	) === true
		? 'destructive-plan-accepted'
		: 'absent';
}

/**
 * Preserve the authority axis in the public generated-removal result.  The
 * interpreter still makes the decision; this is presentation metadata for a
 * refusal that has already been reached under the admission lock.
 */
function withheldDestructiveAuthority(
	evidence: DestructiveAuthorityEvidence,
): string | undefined {
	if (
		evidence.declaration !== 'requires-removal' &&
		evidence.declaration !== 'requires-lossy-change' &&
		evidence.declaration !== 'replacement-requested-by-plan'
	)
		return 'destructive declaration authority';
	if (evidence.ownership !== 'managed-by-me')
		return 'destructive ownership authority';
	if (evidence.catalogueIdentity !== 'matches-recorded')
		return 'destructive catalogue identity authority';
	if (evidence.operatorAcceptance !== 'destructive-plan-accepted')
		return 'destructive operator acceptance authority';
	if (
		evidence.containment !== undefined &&
		evidence.containment !== 'all-contained-or-managed'
	)
		return 'destructive containment authority';
	if (evidence.ledgerLineage !== 'matches-database')
		return 'destructive ledger lineage authority';
	return undefined;
}

/** Admission can reject policy/currency before invoking the live callback. */
function withheldDestructiveAuthorityFromReason(
	reason: string,
): string | undefined {
	if (reason.includes('operator acceptance'))
		return 'destructive operator acceptance authority';
	if (reason.includes('ledger lineage'))
		return 'destructive ledger lineage authority';
	return undefined;
}

async function databaseId(pool: Pool): Promise<string> {
	const result = await pool.query('SELECT current_database() AS database_id');
	const database = result.rows[0]?.database_id;
	if (typeof database !== 'string' || database.length === 0)
		throw new Error(
			'schema-differ generator could not read current database identity',
		);
	return database;
}

type LedgerQueryable = Parameters<typeof readPgLedgerAddressChain>[0];

async function managed(
	executor: LedgerQueryable,
	address: LedgerAddress,
): Promise<boolean> {
	// Let a ledger read failure reach readPgRemovalEffectsClosure's catch so it
	// remains an undecidable closure with its PostgreSQL reason, rather than
	// misclassifying unreadable ownership as an unmanaged dependent.
	const chain = await readPgLedgerAddressChain(
		executor,
		home(address),
		address,
	);
	const projection = projectLedgerChain(chain);
	return (
		projection.kind === 'projected-ledger-chain' &&
		projection.stableState === 'managed'
	);
}

/**
 * A generator document is re-evaluated against live state on every delivery.
 * Once a creation claim has already reached its managed terminal state, its
 * address being present is evidence of that earlier delivery, not permission to
 * send its fixed bundle again. An unmanaged occupant still follows the normal
 * vacancy refusal path.
 */
async function alreadyAppliedCreation(
	executor: LedgerQueryable,
	address: LedgerAddress,
): Promise<boolean> {
	const live = await readPgCatalogueIdentity(executor, address);
	if (!live?.catalogueIdentity) return false;
	const chain = await readPgLedgerAddressChain(
		executor,
		home(address),
		address,
	);
	const projection = projectLedgerChain(chain);
	const recorded = chain.terminalMember?.catalogueIdentity;
	return (
		projection.kind === 'projected-ledger-chain' &&
		projection.stableState === 'managed' &&
		recorded !== undefined &&
		isDeepStrictEqual(recorded, live.catalogueIdentity)
	);
}

function observed(address: LedgerAddress): LedgerPayload {
	return {
		value: { kind: address.kind, name: address.name },
		digest: `generator:${address.kind}:${address.name}`,
	};
}

function normalizedDefinition(value: string): string {
	return value
		.replaceAll('"', '')
		.replace(/\s+/gu, ' ')
		.replace(/;$/u, '')
		.trim()
		.toLowerCase();
}

function generatedPayload(value: unknown): LedgerPayload {
	return {
		value: value as LedgerPayload['value'],
		digest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
	};
}

type GeneratedColumnPostcondition = {
	readonly name: string;
	readonly type?: string;
	readonly nullable?: boolean;
	readonly hasDefault?: boolean;
	readonly default?: string;
	readonly collation?: string | null;
	readonly identity?: 'always' | 'byDefault' | null;
};

type GeneratedPostcondition =
	| {
			readonly kind: 'table';
			readonly columns: readonly GeneratedColumnPostcondition[];
	  }
	| { readonly kind: 'column'; readonly column: GeneratedColumnPostcondition }
	| {
			readonly kind: 'constraint';
			readonly constraint:
				| { readonly type: 'p' | 'u'; readonly columns: readonly string[] }
				| {
						readonly type: 'f';
						readonly columns: readonly string[];
						readonly references: {
							readonly schema?: string;
							readonly table: string;
							readonly columns: readonly string[];
						};
						readonly onDelete: string;
						readonly onUpdate: string;
						readonly deferred: boolean;
						readonly notValid: boolean;
				  }
				| {
						readonly type: 'c';
						readonly definition: string;
						readonly notValid: boolean;
				  };
	  }
	| { readonly kind: 'index'; readonly definition: string }
	| { readonly kind: 'enum'; readonly labels: readonly string[] }
	| {
			readonly kind: 'sequence';
			readonly startValue?: string;
			readonly incrementBy?: string;
			readonly minValue?: string;
			readonly maxValue?: string;
			readonly cycle?: boolean;
	  }
	| { readonly kind: 'extension'; readonly version?: string }
	| { readonly kind: 'absent' }
	| { readonly kind: 'exempt'; readonly reason: string };

function textList(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function foreignKeyAction(code: unknown): string | undefined {
	switch (code) {
		case 'a':
			return 'NO ACTION';
		case 'r':
			return 'RESTRICT';
		case 'c':
			return 'CASCADE';
		case 'n':
			return 'SET NULL';
		case 'd':
			return 'SET DEFAULT';
		default:
			return undefined;
	}
}

function generatedPostcondition(
	step: NormalizedManagedStep,
	address: LedgerAddress,
): GeneratedPostcondition {
	const value = step.expectedDeclaration?.value;
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(
			`generated ${address.kind} step ${step.stepKey} has no structural postcondition`,
		);
	const postcondition = value as GeneratedPostcondition;
	return postcondition;
}

/**
 * Generated DDL has no operation runtime to supply an observation. Read the
 * precise catalogue fields it changes; a same-named object is never enough to
 * write an `observed` terminal.
 */
export async function readGeneratedPostcondition(
	executor: LedgerQueryable,
	step: NormalizedManagedStep,
	address: LedgerAddress,
): Promise<LedgerPayload> {
	const parent = address.parent?.name;
	if (address.kind === 'column' && parent && address.schema) {
		const postcondition = generatedPostcondition(step, address);
		if (postcondition.kind !== 'column')
			throw new Error(
				`generated column ${address.name} has a non-column structural postcondition`,
			);
		const expected = postcondition.column;
		if (expected.name !== address.name)
			throw new Error(
				`generated column ${address.name} structural postcondition names another column`,
			);
		const row = (
			await executor.query(
				`SELECT pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type, attribute.attnotnull AS is_not_null, pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default, collation.collname AS collation_name, attribute.attidentity AS identity_kind FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_catalog.pg_attrdef default_value ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum LEFT JOIN pg_catalog.pg_collation collation ON collation.oid = attribute.attcollation WHERE namespace.nspname = $1 AND relation.relname = $2 AND attribute.attname = $3 AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
				[address.schema, parent, address.name],
			)
		).rows[0];
		if (!row) throw new Error(`generated column ${address.name} is absent`);
		const type = String(row.column_type ?? '');
		const nullable =
			row.is_not_null === true
				? false
				: row.is_not_null === false
					? true
					: undefined;
		const actualDefault =
			row.column_default == null ? undefined : String(row.column_default);
		const actualCollation =
			row.collation_name == null ? null : String(row.collation_name);
		const actualIdentity =
			row.identity_kind === 'a'
				? 'always'
				: row.identity_kind === 'd'
					? 'byDefault'
					: null;
		if (expected.type !== undefined && !dbTypesEqual(type, expected.type))
			throw new Error(
				`generated column ${address.name} type postcondition differs`,
			);
		if (expected.nullable !== undefined && nullable !== expected.nullable)
			throw new Error(
				`generated column ${address.name} nullability postcondition differs`,
			);
		if (
			expected.hasDefault === true &&
			(actualDefault === undefined ||
				expected.default === undefined ||
				actualDefault !== expected.default)
		)
			throw new Error(
				`generated column ${address.name} default postcondition differs`,
			);
		if (expected.hasDefault === false && actualDefault !== undefined)
			throw new Error(
				`generated column ${address.name} default postcondition differs`,
			);
		if (
			expected.collation !== undefined &&
			actualCollation !== expected.collation
		)
			throw new Error(
				`generated column ${address.name} collation postcondition differs`,
			);
		if (expected.identity !== undefined && actualIdentity !== expected.identity)
			throw new Error(
				`generated column ${address.name} identity postcondition differs`,
			);
		return generatedPayload({
			kind: 'column',
			type,
			nullable,
			default: actualDefault,
		});
	}
	if (address.kind === 'constraint' && parent && address.schema) {
		const postcondition = generatedPostcondition(step, address);
		if (postcondition.kind !== 'constraint')
			throw new Error(
				`generated constraint ${address.name} has a non-constraint structural postcondition`,
			);
		const expected = postcondition.constraint;
		const row = (
			await executor.query(
				`SELECT constraint_item.contype AS constraint_type, pg_catalog.pg_get_constraintdef(constraint_item.oid, true) AS constraint_definition, ARRAY(SELECT attribute.attname::text FROM unnest(constraint_item.conkey) WITH ORDINALITY AS key_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_item.conrelid AND attribute.attnum = key_column.attnum ORDER BY key_column.position) AS key_columns, referenced_namespace.nspname AS referenced_schema, referenced_relation.relname AS referenced_table, ARRAY(SELECT attribute.attname::text FROM unnest(constraint_item.confkey) WITH ORDINALITY AS key_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_item.confrelid AND attribute.attnum = key_column.attnum ORDER BY key_column.position) AS referenced_columns, constraint_item.confdeltype AS on_delete, constraint_item.confupdtype AS on_update, constraint_item.condeferrable AS is_deferrable, constraint_item.condeferred AS is_deferred, constraint_item.convalidated AS is_validated FROM pg_catalog.pg_constraint constraint_item JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_catalog.pg_class referenced_relation ON referenced_relation.oid = constraint_item.confrelid LEFT JOIN pg_catalog.pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND constraint_item.conname = $3`,
				[address.schema, parent, address.name],
			)
		).rows[0];
		if (!row) throw new Error(`generated constraint ${address.name} is absent`);
		const definition = String(row.constraint_definition ?? '');
		if (String(row.constraint_type) !== expected.type)
			throw new Error(
				`generated constraint ${address.name} postcondition differs`,
			);
		if (
			(expected.type === 'p' || expected.type === 'u') &&
			JSON.stringify(textList(row.key_columns)) !==
				JSON.stringify(expected.columns)
		)
			throw new Error(
				`generated constraint ${address.name} postcondition differs`,
			);
		if (expected.type === 'c') {
			if (
				normalizedDefinition(definition) !==
					normalizedDefinition(expected.definition) ||
				(row.is_validated === true) === expected.notValid
			)
				throw new Error(
					`generated constraint ${address.name} postcondition differs`,
				);
		}
		if (expected.type === 'f') {
			if (
				JSON.stringify(textList(row.key_columns)) !==
					JSON.stringify(expected.columns) ||
				String(row.referenced_table ?? '') !== expected.references.table ||
				(expected.references.schema !== undefined &&
					String(row.referenced_schema ?? '') !== expected.references.schema) ||
				JSON.stringify(textList(row.referenced_columns)) !==
					JSON.stringify(expected.references.columns) ||
				foreignKeyAction(row.on_delete) !== expected.onDelete ||
				foreignKeyAction(row.on_update) !== expected.onUpdate ||
				(row.is_deferrable === true && row.is_deferred === true) !==
					expected.deferred ||
				(row.is_validated === true) === expected.notValid
			)
				throw new Error(
					`generated constraint ${address.name} postcondition differs`,
				);
		}
		return generatedPayload({
			kind: 'constraint',
			type: String(row.constraint_type ?? ''),
			definition,
		});
	}
	if (address.kind === 'index' && parent && address.schema) {
		const postcondition = generatedPostcondition(step, address);
		if (postcondition.kind !== 'index')
			throw new Error(
				`generated index ${address.name} has a non-index structural postcondition`,
			);
		const row = (
			await executor.query(
				`SELECT index_relation.relname AS index_name, index_meta.indisunique AS is_unique, pg_catalog.pg_get_indexdef(index_meta.indexrelid, 0, true) AS index_definition FROM pg_catalog.pg_index index_meta JOIN pg_catalog.pg_class relation ON relation.oid = index_meta.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_meta.indexrelid WHERE namespace.nspname = $1 AND relation.relname = $2 AND index_relation.relname = $3`,
				[address.schema, parent, address.name],
			)
		).rows[0];
		if (!row) throw new Error(`generated index ${address.name} is absent`);
		const definition = String(row.index_definition ?? '');
		if (
			normalizedDefinition(definition) !==
			normalizedDefinition(postcondition.definition)
		)
			throw new Error(`generated index ${address.name} postcondition differs`);
		return generatedPayload({
			kind: 'index',
			unique: row.is_unique === true,
			definition,
		});
	}
	if (address.kind === 'table' && address.schema) {
		const postcondition = generatedPostcondition(step, address);
		if (postcondition.kind !== 'table')
			throw new Error(
				`generated table ${address.name} has a non-table structural postcondition`,
			);
		const rows = (
			await executor.query(
				`SELECT attribute.attname AS column_name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type, attribute.attnotnull AS is_not_null, pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_catalog.pg_attrdef default_value ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum WHERE namespace.nspname = $1 AND relation.relname = $2 AND attribute.attnum > 0 AND NOT attribute.attisdropped ORDER BY attribute.attnum`,
				[address.schema, address.name],
			)
		).rows;
		const expected = postcondition.columns;
		if (expected.length === 0 || rows.length !== expected.length)
			throw new Error(
				`generated table ${address.name} column postcondition differs: expected ${JSON.stringify(expected)}, live ${JSON.stringify(rows)}`,
			);
		for (const specification of expected) {
			const actual = rows.find((row) => row.column_name === specification.name);
			if (
				!actual ||
				(specification.type !== undefined &&
					!dbTypesEqual(
						String(actual.column_type ?? ''),
						specification.type,
					)) ||
				(specification.nullable !== undefined &&
					(actual.is_not_null !== true) !== specification.nullable) ||
				(specification.hasDefault === true &&
					(specification.default === undefined ||
						actual.column_default == null ||
						String(actual.column_default) !== specification.default)) ||
				(specification.hasDefault === false && actual.column_default != null)
			)
				throw new Error(
					`generated table ${address.name} column postcondition differs: expected ${JSON.stringify(specification)}, live ${JSON.stringify(actual)}`,
				);
		}
		return generatedPayload({
			kind: 'table',
			columns: rows.map((row) => ({
				name: String(row.column_name),
				type: String(row.column_type),
				nullable: row.is_not_null !== true,
				default:
					row.column_default == null ? undefined : String(row.column_default),
			})),
		});
	}
	if (address.kind === 'enum' && address.schema) {
		const postcondition = generatedPostcondition(step, address);
		if (postcondition.kind !== 'enum')
			throw new Error(
				`generated enum ${address.name} has a non-enum structural postcondition`,
			);
		const rows = (
			await executor.query(
				`SELECT enum_label.enumlabel AS label FROM pg_catalog.pg_type type JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace JOIN pg_catalog.pg_enum enum_label ON enum_label.enumtypid = type.oid WHERE namespace.nspname = $1 AND type.typname = $2 ORDER BY enum_label.enumsortorder`,
				[address.schema, address.name],
			)
		).rows;
		const labels = rows.map((row) => String(row.label));
		if (JSON.stringify(labels) !== JSON.stringify(postcondition.labels))
			throw new Error(`generated enum ${address.name} postcondition differs`);
		return generatedPayload({ kind: 'enum', labels });
	}
	if (address.kind === 'sequence' && address.schema) {
		const postcondition = generatedPostcondition(step, address);
		if (postcondition.kind !== 'sequence')
			throw new Error(
				`generated sequence ${address.name} has a non-sequence structural postcondition`,
			);
		const row = (
			await executor.query(
				`SELECT sequence.start_value::text AS start_value, sequence.increment_by::text AS increment_by, sequence.min_value::text AS min_value, sequence.max_value::text AS max_value, sequence.cache_size::text AS cache_size, sequence.cycle AS cycle FROM pg_catalog.pg_sequences sequence WHERE sequence.schemaname = $1 AND sequence.sequencename = $2`,
				[address.schema, address.name],
			)
		).rows[0];
		if (!row) throw new Error(`generated sequence ${address.name} is absent`);
		const actual = {
			startValue: String(row.start_value),
			incrementBy: String(row.increment_by),
			minValue: String(row.min_value),
			maxValue: String(row.max_value),
			cycle: row.cycle === true,
		};
		for (const key of [
			'startValue',
			'incrementBy',
			'minValue',
			'maxValue',
			'cycle',
		] as const)
			if (
				postcondition[key] !== undefined &&
				postcondition[key] !== actual[key]
			)
				throw new Error(
					`generated sequence ${address.name} postcondition differs`,
				);
		return generatedPayload({ kind: 'sequence', ...row });
	}
	if (address.kind === 'extension') {
		const postcondition = generatedPostcondition(step, address);
		if (postcondition.kind !== 'extension')
			throw new Error(
				`generated extension ${address.name} has a non-extension structural postcondition`,
			);
		const row = (
			await executor.query(
				`SELECT extension.extversion AS version FROM pg_catalog.pg_extension extension WHERE extension.extname = $1`,
				[address.name],
			)
		).rows[0];
		if (!row)
			throw new Error(
				`generated extension ${address.name} version postcondition differs`,
			);
		if (
			postcondition.version !== undefined &&
			String(row.version) !== postcondition.version
		)
			throw new Error(
				`generated extension ${address.name} version postcondition differs`,
			);
		return generatedPayload({
			kind: 'extension',
			version: String(row.version),
		});
	}
	throw new Error(`generated ${address.kind} has no declarable read-back`);
}

function containedBy(root: LedgerAddress, candidate: LedgerAddress): boolean {
	for (let parent = candidate.parent; parent; parent = parent.parent) {
		if (
			parent.engine === root.engine &&
			parent.database === root.database &&
			parent.schema === root.schema &&
			parent.kind === root.kind &&
			parent.name === root.name
		)
			return true;
	}
	return false;
}

async function destructiveEvidence(input: {
	readonly executor: LedgerQueryable;
	readonly address: LedgerAddress;
	readonly classification: import('@dbsp/types').ManagedStepClassification;
	readonly selection?: NormalizedManagedStep['selection'];
	readonly planDigest: string;
	readonly approval: ScopedApprovalSet;
}): Promise<{
	readonly evidence: DestructiveAuthorityEvidence;
	readonly containment?: Awaited<
		ReturnType<typeof readPgRemovalEffectsClosure>
	>;
}> {
	const { executor, address } = input;
	let ownership: DestructiveAuthorityEvidence['ownership'] = 'uncomputable';
	let catalogueIdentity: DestructiveAuthorityEvidence['catalogueIdentity'] =
		'catalogue-unavailable';
	let ledgerLineage: DestructiveAuthorityEvidence['ledgerLineage'] =
		'unreadable';
	try {
		const chain = await readPgLedgerAddressChain(
			executor,
			home(address),
			address,
		);
		const projection = projectLedgerChain(chain);
		ownership =
			projection.kind === 'projected-ledger-chain'
				? projection.stableState === 'managed'
					? 'managed-by-me'
					: projection.stableState === 'unknown'
						? 'unknown'
						: 'blocked'
				: 'uncomputable';
		const live = await readPgCatalogueIdentity(executor, address);
		const recorded = chain.terminalMember?.catalogueIdentity;
		catalogueIdentity = !live
			? 'object-absent'
			: recorded === undefined
				? 'differs'
				: isDeepStrictEqual(live.catalogueIdentity, recorded)
					? 'matches-recorded'
					: 'differs';
		const currency = await readPgLedgerScopeCurrency(executor, home(address));
		ledgerLineage =
			currency.kind === 'current' ? 'matches-database' : 'differs';
	} catch {
		// The authority table intentionally turns every unreadable live fact into a refusal.
	}
	let containment:
		| Awaited<ReturnType<typeof readPgRemovalEffectsClosure>>
		| undefined;
	let containmentOutcome: ContainmentClosureDestructiveOutcome | undefined;
	if (input.classification === 'removal') {
		containment = await readPgRemovalEffectsClosure({
			executor,
			root: address,
			isManaged: (candidate) => managed(executor, candidate),
		});
		containmentOutcome = containment.kind;
	}
	return {
		evidence: {
			declaration:
				input.classification === 'removal'
					? input.selection?.kind === 'replacement'
						? 'replacement-requested-by-plan'
						: 'requires-removal'
					: 'requires-lossy-change',
			...(input.selection?.kind === 'replacement'
				? { replacementAddress: address }
				: {}),
			ownership,
			catalogueIdentity,
			operatorAcceptance: acceptance(input.planDigest, input.approval),
			...(containmentOutcome === undefined
				? {}
				: { containment: containmentOutcome }),
			...(containment?.kind === 'reaches-unmanaged'
				? { containmentUnmanaged: containment.unmanaged }
				: {}),
			...(containment?.kind === 'undecidable'
				? { containmentReason: containment.reason }
				: {}),
			ledgerLineage,
		},
		...(containment === undefined ? {} : { containment }),
	};
}

/**
 * Closure discovery is needed before the group can be reserved. It deliberately
 * does not decide destructive authority; the locked admission callback does.
 */
async function removalContainment(
	executor: LedgerQueryable,
	address: LedgerAddress,
): Promise<Awaited<ReturnType<typeof readPgRemovalEffectsClosure>>> {
	return readPgRemovalEffectsClosure({
		executor,
		root: address,
		isManaged: (candidate) => managed(executor, candidate),
	});
}

/**
 * Executes the in-memory, just-presented generator material.  It never reads
 * a generator run back by id: that persisted row remains review-only.
 */
export async function executeGeneratorPlan(input: {
	readonly pool: Pool;
	/** Bound by apply after validating the persisted durable manifest. */
	readonly manifest?: ValidatedManagedStepManifest;
	/** @deprecated Compatibility shim for direct fixtures; it is validated before use. */
	readonly plan?: { readonly steps: readonly unknown[] };
	readonly planDigest: string;
	readonly schema: string;
	/** Preserve scopes and trust roots until admission; never reduce to classes. */
	readonly approval?: ScopedApprovalSet;
	/** Durable witness minted while apply holds this run's journal lock. */
	readonly run: PgLockedRun;
	/** Appends the run-to-attempt mapping before any ledger claim may be opened. */
	readonly recordAttempt: (executionId: string) => Promise<void>;
	/** Test-only admitted-path observation; absent from every CLI invocation. */
	readonly observer?: PgOutcomeCheckpointObserver;
	/** @deprecated Compatibility shim for old direct fixtures. */
	readonly accepts?: readonly string[];
	readonly replaces?: readonly string[];
	readonly runId: string;
}): Promise<GeneratorExecutionResult> {
	const validation = input.manifest
		? { ok: true as const, manifest: input.manifest }
		: validateNormalizedManagedStepManifest(
				(input.plan?.steps as readonly NormalizedManagedStep[]) ?? [],
			);
	if (!validation.ok)
		return { outcome: 'execution-failed', detail: validation.detail };
	const manifest = validation.manifest;
	const approval: ScopedApprovalSet = input.approval ?? {
		approvals: (input.accepts ?? []).map((value) => ({ class: value })),
	};
	const completedStepKeys: string[] = [];
	let destructiveRefusal: { readonly withheldAuthority: string } | undefined;
	let destructiveClosureReplanRequired = false;
	const partial = (detail: string): GeneratorExecutionResult =>
		completedStepKeys.length === 0
			? { outcome: 'execution-failed', detail }
			: {
					outcome: 'partially-applied',
					detail,
					completedStepKeys,
					notStartedStepKeys: managedSteps(manifest)
						.filter((step) => !completedStepKeys.includes(step.stepKey))
						.map((step) => step.stepKey),
				};
	try {
		const database = await databaseId(input.pool);
		// The attempt id is random, journaled before any step, and is the namespace
		// claims bind to. Reconciliation discovers it from the journal.
		const executionId = `dbsp.generator.execution.${randomUUID()}`;
		await input.recordAttempt(executionId);
		const steps = managedSteps(manifest);
		for (const step of steps) {
			if (step.lifecycle?.kind === 'adoption-refused')
				return {
					outcome: 'adoption-refused',
					detail: `declared adoption for ${step.address?.name ?? step.stepKey} refuses live shape mismatch`,
				};
			const lifecycle = step.lifecycle;
			if (lifecycle?.kind !== 'adoption') continue;
			const address = step.address;
			if (
				!address ||
				!step.expectedDeclaration ||
				!step.expectedCatalogueIdentity
			)
				return {
					outcome: 'execution-failed',
					detail: `adoption step ${step.stepKey} has incomplete normalized material`,
				};
			const preflight = await preflightPgDeclaredAdoption({
				executor: input.pool,
				home: home(address),
				address,
				declaration: step.expectedDeclaration,
				expectedCatalogueIdentity: step.expectedCatalogueIdentity,
				shapeMatches: () =>
					adoptionShapeMatches(input.pool, input.schema, lifecycle.shape),
			});
			if (preflight.outcome !== 'ready' && preflight.outcome !== 'no-op')
				return preflight.outcome === 'adoption-refused'
					? { outcome: 'adoption-refused', detail: preflight.detail }
					: { outcome: 'execution-failed', detail: preflight.detail };
		}
		const replacementSelectors = steps
			.filter((step) => step.selection?.kind === 'replacement')
			.map((step) => step.selection?.selector)
			.filter((selector): selector is string => selector !== undefined);
		if (replacementSelectors.length > 0 && !input.replaces?.length)
			return {
				outcome: 'destructive-authority-refused',
				detail:
					'replacement requires a named --replace selector from the reviewed plan',
				refusal: { withheldAuthority: 'destructive declaration authority' },
			};
		for (const selector of input.replaces ?? [])
			if (
				!replacementSelectors.some((reviewed) =>
					matchesReviewedReplacementSelector(reviewed, selector),
				)
			)
				return {
					outcome: 'destructive-authority-refused',
					detail: `replacement ${selector} was not requested by the reviewed plan`,
					refusal: { withheldAuthority: 'destructive declaration authority' },
				};
		if (
			replacementSelectors.some(
				(reviewed) =>
					!input.replaces?.some((provided) =>
						matchesReviewedReplacementSelector(reviewed, provided),
					),
			)
		)
			return {
				outcome: 'selection-incomplete',
				detail:
					'replacement selection does not cover every reviewed replacement',
			};
		for (const step of steps) {
			if (step.lifecycle?.kind === 'adoption-refused') continue;
			if (step.lifecycle?.kind === 'adoption') {
				const lifecycle = step.lifecycle;
				const address = step.address;
				if (
					!address ||
					!step.expectedDeclaration ||
					!step.expectedCatalogueIdentity
				)
					return {
						outcome: 'execution-failed',
						detail: `adoption step ${step.stepKey} has incomplete normalized material`,
					};
				const adopted = await executePgDeclaredAdoption({
					executor: input.pool,
					run: input.run,
					manifest,
					recomputedPlanDigest: input.planDigest,
					approval,
					executionId,
					step,
					home: home(address),
					address,
					declaration: step.expectedDeclaration,
					expectedCatalogueIdentity: step.expectedCatalogueIdentity,
					shapeMatches: () =>
						adoptionShapeMatches(input.pool, input.schema, lifecycle.shape),
					...(input.observer === undefined ? {} : { observer: input.observer }),
				});
				if (adopted.outcome === 'completed' || adopted.outcome === 'no-op') {
					completedStepKeys.push(step.stepKey);
					continue;
				}
				if (adopted.outcome === 'adoption-refused')
					return { outcome: 'adoption-refused', detail: adopted.detail };
				if (adopted.outcome === 'recovery-required') return adopted;
				if (adopted.outcome === 'transport-ambiguous') return adopted;
				return { outcome: 'execution-failed', detail: adopted.detail };
			}
			if (step.lifecycle?.kind === 'readdress') {
				const result = await executePgPersistedTableReaddress({
					executor: input.pool,
					run: input.run,
					manifest,
					recomputedPlanDigest: input.planDigest,
					approval,
					executionId,
					step,
					database,
					targetSchema: input.schema,
					...(input.observer === undefined ? {} : { observer: input.observer }),
				});
				if (result.outcome === 'completed' || result.outcome === 'no-op') {
					completedStepKeys.push(step.stepKey);
					continue;
				}
				return result;
			}
			if (step.statementBundle.statements.length === 0) {
				completedStepKeys.push(step.stepKey);
				continue;
			}
			const address = step.address ?? step.closure?.root;
			if (!address)
				return {
					outcome: 'execution-failed',
					detail: `managed step ${step.stepKey} has no address`,
				};
			const plannedClaimKey = step.plannedClaimKeys[0];
			if (!plannedClaimKey)
				return {
					outcome: 'execution-failed',
					detail: `managed step ${step.stepKey} has no planned claim key`,
				};
			if (
				step.classification === 'non-destructive' &&
				step.requiresVacancy &&
				(await alreadyAppliedCreation(input.pool, address))
			) {
				completedStepKeys.push(step.stepKey);
				continue;
			}
			const claimKind: LedgerClaimKind = step.claimKind;
			const rootClaimId = outcomeClaimId(executionId, plannedClaimKey, address);
			const claim = {
				claimId: rootClaimId,
				claimSpecies: 'sql-bearing' as const,
				executionId,
				plannedClaimKey,
				claimGroupId: rootClaimId,
				rootClaimId,
				address,
				claimKind,
				statementBundle: step.statementBundle,
				requiresVacancy: step.requiresVacancy,
			};
			const baseReservation = {
				address,
				claimKind,
				executionId,
				rootClaimId: claim.claimId,
				homeLedger: home(address),
			};
			if (step.classification === 'non-destructive') {
				const result = await executePgAdmittedOperation(input.pool, {
					run: input.run,
					approval,
					manifest,
					recomputedPlanDigest: input.planDigest,
					operation: {
						kind: 'single-outcome',
						request: {
							plan: claim,
							reservations: [baseReservation],
							resolution: {
								eventId: outcomeClaimEventId(claim.claimId, 'observed'),
								eventKind: 'observed',
							},
							// Transactional DDL is visible only on the admitted session until
							// its terminal ledger fact commits with it.
							readBack: async (session) =>
								readGeneratedPostcondition(session, step, address),
							recordCatalogueIdentity: true,
							...(input.observer === undefined
								? {}
								: { observer: input.observer }),
							vacancy: async (executor: LedgerQueryable) =>
								(await readPgCatalogueIdentity(executor, address))
									? {
											kind: 'occupied',
											reason: `creation claim ${claim.claimId} refuses occupied live address ${address.name}`,
										}
									: { kind: 'vacant' },
						},
					},
				});
				if (result.kind === 'outcome-recovery-required')
					return {
						outcome: 'recovery-required',
						claimId: result.claimId,
						detail: `claim ${result.claimId} remains open and requires recovery: ${result.reason}`,
					};
				if (result.kind === 'outcome-transport-ambiguous')
					return { outcome: 'transport-ambiguous', detail: result.reason };
				if ('reason' in result) return partial(result.reason);
				completedStepKeys.push(step.stepKey);
				continue;
			}
			const containment =
				step.classification === 'removal'
					? await removalContainment(input.pool, address)
					: undefined;
			const closureMembers = new Map<
				string,
				{
					readonly address: LedgerAddress;
					readonly plannedClaimKey: string;
				}
			>();
			// A normalized closure is digest-covered execution material.  Its
			// members must receive their own claims and terminal `absent` facts;
			// PostgreSQL's single DROP statement does not make those ledger facts
			// optional.  The live closure remains the authority-time cascade guard
			// and supplements legacy root-only manifests.
			for (const member of step.closure?.members ?? []) {
				closureMembers.set(ledgerAddressKey(member.address), {
					address: member.address,
					plannedClaimKey: member.plannedClaimKey,
				});
			}
			if (containment?.kind === 'all-contained-or-managed') {
				for (const effect of containment.effects) {
					if (effect.internalOwned) continue;
					if (!containedBy(address, effect.address)) continue;
					if (!(await managed(input.pool, effect.address))) continue;
					const key = ledgerAddressKey(effect.address);
					if (closureMembers.has(key)) continue;
					closureMembers.set(key, {
						address: effect.address,
						plannedClaimKey: `closure:${effect.address.kind}:${effect.address.name}`,
					});
				}
			}
			const containedClaims: Array<{
				readonly plan: CascadeCoveredOutcomeClaimPlan & {
					readonly plannedClaimKey: string;
				};
				readonly reservation: typeof baseReservation;
			}> = [];
			for (const member of closureMembers.values()) {
				const effect = member.address;
				const childClaimId = outcomeClaimId(
					executionId,
					plannedClaimKey,
					effect,
					member.plannedClaimKey,
				);
				const childReservation = {
					...baseReservation,
					address: effect as typeof address,
					rootClaimId: claim.claimId,
				};
				containedClaims.push({
					plan: {
						...claim,
						claimId: childClaimId,
						claimSpecies: 'cascade-covered',
						address: effect as typeof address,
						plannedClaimKey: member.plannedClaimKey,
						// Each member contributes only its terminal absence fact; SQL is
						// exclusively carried by the destructive root manifest claim.
						statementBundle: { statements: [] },
					},
					reservation: childReservation,
				});
			}
			const admitRequest = {
				plan: claim,
				reservations: [baseReservation],
				members: containedClaims.map(({ plan, reservation }) => ({
					plan,
					reservations: [reservation],
				})),
				destructiveDecision: async (executor: LedgerQueryable) => {
					const lockedAuthority = await destructiveEvidence({
						executor,
						address,
						classification: step.classification,
						selection: step.selection,
						planDigest: input.planDigest,
						approval,
					});
					if (
						step.classification === 'removal' &&
						(containment?.kind !== 'all-contained-or-managed' ||
							lockedAuthority.containment?.kind !==
								'all-contained-or-managed' ||
							containment.closureDigest !==
								lockedAuthority.containment.closureDigest)
					) {
						destructiveClosureReplanRequired = true;
						const decision = decideDestructiveDecision(
							{ kind: 'removal', address },
							{ ...lockedAuthority.evidence, containment: 'undecidable' },
						);
						if (decision.kind === 'destructive-decision-refused')
							destructiveRefusal = {
								withheldAuthority:
									withheldDestructiveAuthority({
										...lockedAuthority.evidence,
										containment: 'undecidable',
									}) ?? 'destructive containment authority',
							};
						return decision;
					}
					const decision = decideDestructiveDecision(
						{
							kind:
								step.classification === 'removal'
									? 'removal'
									: 'data-destructive',
							address,
							...(step.classification === 'removal' &&
							lockedAuthority.containment?.kind === 'all-contained-or-managed'
								? { closureDigest: lockedAuthority.containment.closureDigest }
								: {}),
						},
						lockedAuthority.evidence,
					);
					if (decision.kind === 'destructive-decision-refused')
						destructiveRefusal = {
							withheldAuthority:
								withheldDestructiveAuthority(lockedAuthority.evidence) ??
								'destructive authority',
						};
					return decision;
				},
				...(input.observer === undefined ? {} : { observer: input.observer }),
			};
			const executed = (await executePgAdmittedOperation(input.pool, {
				run: input.run,
				approval,
				manifest,
				recomputedPlanDigest: input.planDigest,
				operation: {
					kind: 'destructive-outcome',
					request: admitRequest,
					readBackAndResolve: async (session) => {
						const live = await readPgCatalogueIdentity(session, address);
						const survivors: LedgerAddress[] =
							step.classification === 'removal' && live ? [address] : [];
						const childLives = await Promise.all(
							containedClaims.map(async (child) => ({
								child,
								live: await readPgCatalogueIdentity(
									session,
									child.plan.address,
								),
							})),
						);
						for (const { child, live: childLive } of childLives)
							if (childLive) survivors.push(child.plan.address);
						if (survivors.length > 0) {
							const survivorNames = survivors.map(
								(survivor) =>
									`${survivor.kind} ${survivor.schema ?? '<database>'}.${survivor.name}`,
							);
							const survivorObservation = {
								value: { survivors: survivorNames },
								digest: createHash('sha256')
									.update(JSON.stringify(survivorNames))
									.digest('hex'),
							};
							return {
								rootClaimId: claim.claimId,
								members: [
									{
										target: home(address),
										member: {
											eventId: outcomeClaimEventId(
												claim.claimId,
												'indeterminate',
											),
											executionId,
											plannedClaimKey: claim.plannedClaimKey,
											claimGroupId: claim.claimGroupId,
											rootClaimId: claim.rootClaimId,
											address,
											eventKind: 'indeterminate' as const,
											observed: survivorObservation,
										},
									},
									...containedClaims.map((child) => ({
										target: home(child.plan.address),
										member: {
											eventId: outcomeClaimEventId(
												child.plan.claimId,
												'indeterminate',
											),
											executionId,
											plannedClaimKey: child.plan.plannedClaimKey,
											claimGroupId: claim.claimId,
											rootClaimId: claim.claimId,
											address: child.plan.address,
											eventKind: 'indeterminate' as const,
											observed: survivorObservation,
										},
									})),
								],
								reservations: [
									baseReservation,
									...containedClaims.map(({ reservation }) => reservation),
								],
							};
						}
						const terminals: Array<{
							readonly target: LedgerHome;
							readonly member: Omit<
								LedgerChainMember,
								'controller' | 'recordedAt'
							>;
						}> = [
							{
								target: home(address),
								member: {
									eventId: outcomeClaimEventId(
										claim.claimId,
										step.classification === 'removal' ? 'absent' : 'observed',
									),
									executionId,
									plannedClaimKey: claim.plannedClaimKey,
									claimGroupId: claim.claimGroupId,
									rootClaimId: claim.rootClaimId,
									address,
									eventKind:
										step.classification === 'removal' ? 'absent' : 'observed',
									// The append protocol reads this address's terminal on its
									// pinned transaction session after the post-DDL read-back.
									...(live?.catalogueIdentity
										? { catalogueIdentity: live.catalogueIdentity }
										: {}),
									...(step.classification === 'removal'
										? {}
										: { observed: observed(address) }),
								},
							},
						];
						for (const child of containedClaims) {
							terminals.push({
								target: home(child.plan.address),
								member: {
									eventId: outcomeClaimEventId(child.plan.claimId, 'absent'),
									executionId,
									plannedClaimKey: child.plan.plannedClaimKey,
									claimGroupId: claim.claimId,
									rootClaimId: claim.claimId,
									address: child.plan.address,
									eventKind: 'absent' as const,
									predecessor: child.plan.claimId,
								},
							});
						}
						return {
							rootClaimId: claim.claimId,
							members: terminals,
							reservations: [
								baseReservation,
								...containedClaims.map(({ reservation }) => reservation),
							],
						};
					},
				},
			})) as
				| { readonly kind: 'executed-destructive-outcome' }
				| { readonly kind: 'outcome-protocol-refused'; readonly reason: string }
				| { readonly kind: 'outcome-protocol-pending'; readonly reason: string }
				| {
						readonly kind: 'outcome-transport-ambiguous';
						readonly reason: string;
				  }
				| {
						readonly kind: 'outcome-recovery-required';
						readonly claimId: string;
						readonly reason: string;
				  };
			if (executed.kind === 'outcome-recovery-required')
				return {
					outcome: 'recovery-required',
					claimId: executed.claimId,
					detail: `claim ${executed.claimId} remains open and requires recovery: ${executed.reason}`,
				};
			if (executed.kind === 'outcome-transport-ambiguous')
				return { outcome: 'transport-ambiguous', detail: executed.reason };
			if (executed.kind === 'outcome-protocol-pending')
				return partial(
					`destructive claim ${claim.claimId} remains pending after executing: ${executed.reason}`,
				);
			if (executed.kind !== 'executed-destructive-outcome')
				return {
					outcome: 'destructive-authority-refused',
					detail: destructiveClosureReplanRequired
						? `${executed.reason}; destructive closure changed under lock; replan required`
						: executed.reason,
					...(destructiveRefusal === undefined &&
					withheldDestructiveAuthorityFromReason(executed.reason) === undefined
						? {}
						: {
								refusal: destructiveRefusal ?? {
									withheldAuthority:
										withheldDestructiveAuthorityFromReason(executed.reason) ??
										'destructive authority',
								},
							}),
				};
			completedStepKeys.push(step.stepKey);
		}
		return { outcome: 'completed' };
	} catch (error) {
		return partial(error instanceof Error ? error.message : String(error));
	}
}
