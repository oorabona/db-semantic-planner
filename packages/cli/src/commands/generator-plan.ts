/**
 * The schema-differ producer used by the no-argument apply command.
 *
 * This deliberately lives beside `apply`, rather than in the transition
 * planner: generated removals have a different replay contract.  The emitted
 * document is nevertheless persisted in the same journal and digest domain so
 * that it is inspectable before an operator makes a fresh live-state decision.
 */
import { randomUUID } from 'node:crypto';
import {
	assertDeclarableChangeKind,
	classifyGeneratedMutation,
	comparePgsqlDatabaseSchema,
	createPgsqlAdapter,
	createPgsqlGeneratedManagedStep,
	createPgTransitionLessor,
	createPgTransitionRunPersister,
	generatedPostconditionForChange,
	generateMigrationSQL,
	readPgCatalogueIdentity,
	renderPgTableReaddressStatements,
	type SchemaDiff,
} from '@dbsp/adapter-pgsql';
import type { InProcessProvenPlan } from '@dbsp/core';
import {
	acquireTransitionLease,
	canonicalJson,
	canonicalJsonDigest,
	transitionPlanDigest,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import type {
	CatalogueIdentity,
	LedgerAddress,
	LedgerPayload,
	NormalizedManagedStep,
	PlanAssessment,
	TableIR,
	TableReaddressDeclaration,
	TransitionRunMetadata,
} from '@dbsp/types';
import type { Pool } from 'pg';
import { createDbConnection } from '../utils/db-utils.js';
import { loadSchema } from '../utils/schema-loader.js';
import type { PlanResult } from './plan.js';

export interface GeneratorPlanMaterial {
	readonly kind: 'schema-differ-generator';
	/** Digest-covered execution context captured with the reviewed generator run. */
	readonly planningSchema?: string;
	/** Diagnostic provenance only. Execution reads plan.steps, never this list. */
	readonly changes: readonly {
		readonly kind: string;
		readonly table: string;
		readonly column?: string;
		readonly classification: ReturnType<typeof classifyGeneratedMutation>;
		readonly details: string;
		/** Exact SQL attributed to this change for its token-gated claim. */
		readonly statements: readonly string[];
		/** Present only for the paired table re-addressing executor. */
		readonly readdress?: TableReaddressDeclaration;
		/** Present only for a reviewed declaration to adopt an existing table. */
		readonly adoption?: {
			readonly declaration: LedgerPayload;
			readonly shape: TableIR;
			/** Physical identity observed with the reviewed live shape. */
			readonly catalogueIdentity: CatalogueIdentity;
		};
		/** A digest-covered replacement is executed only when --replace names it. */
		readonly replacement?: {
			readonly retireStatements: readonly string[];
			readonly createStatements: readonly string[];
		};
	}[];
}

/** Extra persisted material is digest-covered; the regular applier never executes it. */
export type GeneratorDurablePlan = InProcessProvenPlan & {
	readonly generator: GeneratorPlanMaterial;
};

function adoptionDeclaration(table: TableIR): LedgerPayload {
	// The live differ is the shape comparator. Persist the exact authored table
	// shape, rather than a boolean that could later be reinterpreted.
	const value = JSON.parse(
		canonicalJson({ kind: 'table', name: table.name, shape: table }),
	) as LedgerPayload['value'];
	return { value, digest: canonicalJsonDigest(value) };
}

function replacementStatements(table: TableIR, schema: string) {
	const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
	const createDiff: SchemaDiff = {
		changes: [
			{
				kind: 'create_table',
				table: table.name,
				destructive: false,
				details: `Create table "${table.name}"`,
				meta: { table },
			},
		],
		hasDestructive: false,
		summary: {
			tables: { added: 1, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
	return {
		retireStatements: [`DROP TABLE ${quote(schema)}.${quote(table.name)}`],
		createStatements: generateMigrationSQL(createDiff, {
			includeDestructive: true,
			schemaName: schema,
		}),
	};
}

/** The paired executor sends only SQL that the persisted root step carries. */
function readdressStatements(
	database: string,
	schema: string,
	declaration: TableReaddressDeclaration,
): readonly string[] {
	const endpoint = (
		value: TableReaddressDeclaration['from'],
	): LedgerAddress => ({
		scope: 'schema',
		engine: 'postgresql',
		database: value.database ?? database,
		schema: value.schema ?? schema,
		kind: value.kind ?? 'table',
		name: value.name,
	});
	return renderPgTableReaddressStatements(
		endpoint(declaration.from),
		endpoint(declaration.to),
	);
}

function lifecycleStep(input: {
	readonly stepKey: string;
	readonly order: number;
	readonly database: string;
	readonly schema: string;
	readonly table: string;
	readonly classification: ReturnType<typeof classifyGeneratedMutation>;
	readonly statements?: readonly string[];
	readonly selection?: NormalizedManagedStep['selection'];
	readonly lifecycle?: NormalizedManagedStep['lifecycle'];
	readonly expectedDeclaration?: LedgerPayload;
	readonly expectedCatalogueIdentity?: CatalogueIdentity;
	readonly requiresVacancy?: boolean;
	readonly claimKind?: NormalizedManagedStep['claimKind'];
}): NormalizedManagedStep {
	// Lifecycle-only table work has no SchemaChange, but it must pass the same
	// sole declarable boundary as ordinary diff-produced manifest steps.
	assertDeclarableChangeKind('create_table');
	const address = {
		scope: 'schema' as const,
		engine: 'postgresql',
		database: input.database,
		schema: input.schema,
		kind: 'table' as const,
		name: input.table,
	};
	return {
		stepKey: input.stepKey,
		order: input.order,
		segmentId: `generator-segment-${input.order}`,
		// Dependencies are assigned once the complete manifest exists.  A numeric
		// order is not itself a step key: replacement emits two differently named
		// steps at adjacent orders.
		dependencyOrder: [],
		address,
		claimKind:
			input.claimKind ??
			(input.classification === 'removal'
				? 'retire-intent'
				: input.classification === 'paired-readdress'
					? 'readdress-intent'
					: 'intent'),
		plannedClaimKeys: [`${input.stepKey}:root`],
		statementBundle: {
			statements: (input.statements ?? []).map((sql, ordinal) => ({
				ordinal,
				sql,
			})),
		},
		classification: input.classification,
		requiresVacancy: input.requiresVacancy ?? false,
		...(input.expectedDeclaration === undefined
			? {}
			: { expectedDeclaration: input.expectedDeclaration }),
		...(input.expectedCatalogueIdentity === undefined
			? {}
			: { expectedCatalogueIdentity: input.expectedCatalogueIdentity }),
		...(input.selection === undefined ? {} : { selection: input.selection }),
		...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
		replayPolicy:
			input.classification === 'removal' ? 'fresh-live-only' : 'recorded',
	};
}

/**
 * The differ is deliberately sequential: each emitted step follows the exact
 * previously emitted step, including both halves of a reviewed replacement.
 * Assign the graph from concrete keys only after every lifecycle expansion.
 */
export function linearizeGeneratedManagedStepDependencies(
	steps: readonly NormalizedManagedStep[],
): readonly NormalizedManagedStep[] {
	const linearized: NormalizedManagedStep[] = [];
	for (const step of steps) {
		const previous = linearized.at(-1);
		linearized.push({
			...step,
			dependencyOrder: previous === undefined ? [] : [previous.stepKey],
		});
	}
	return linearized;
}

/**
 * A durable manifest is an execution boundary, so lifecycle exclusivity is
 * checked again after deserialization instead of trusting its producer.
 */
export function persistedLifecycleDirectiveError(
	steps: readonly NormalizedManagedStep[],
): string | undefined {
	const directivesByTable = new Map<string, Set<string>>();
	for (const step of steps) {
		const directive = step.selection?.kind;
		if (
			directive !== 'adoption' &&
			directive !== 'replacement' &&
			directive !== 'readdress'
		)
			continue;
		const address = step.address ?? step.closure?.root;
		if (address?.kind !== 'table') continue;
		const key = [
			address.engine,
			address.database,
			address.schema ?? '',
			address.name,
		].join('\u0000');
		const directives = directivesByTable.get(key) ?? new Set<string>();
		directives.add(directive);
		directivesByTable.set(key, directives);
		if (directives.size > 1)
			return `persisted lifecycle for ${address.name} cannot set ${[...directives].sort().join(' and ')} together`;
	}
	return undefined;
}

function declaredLifecycleDirectiveError(table: TableIR): string | undefined {
	const directives = [
		table.adopt === true ? 'adopt' : undefined,
		table.replace === true ? 'replace' : undefined,
		table.readdress === undefined ? undefined : 'readdress',
	].filter((directive): directive is string => directive !== undefined);
	return directives.length > 1
		? `declared lifecycle for ${table.name} cannot set ${directives.join(' and ')} together`
		: undefined;
}

function assessment(): PlanAssessment {
	return {
		decision: 'applicable',
		assurance: 'established',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [],
	};
}

/** `SchemaChange.table` is overloaded for non-table resources; never use it alone. */
function changeTargetsDeclaredTable(
	change: SchemaDiff['changes'][number],
	table: string,
): boolean {
	if (change.table !== table) return false;
	return !new Set([
		'create_extension',
		'drop_extension',
		'create_enum',
		'drop_enum',
		'alter_enum_add_value',
		'create_sequence',
		'drop_sequence',
		'alter_sequence',
	]).has(change.kind);
}

function requiredAdoptionIdentity(
	identities: ReadonlyMap<string, CatalogueIdentity>,
	table: string,
): CatalogueIdentity {
	const identity = identities.get(table);
	if (!identity)
		throw new Error(`declared adoption for ${table} has no live identity`);
	return identity;
}

function asDurableGeneratorPlan(
	material: GeneratorPlanMaterial,
	steps: readonly NormalizedManagedStep[],
): GeneratorDurablePlan {
	const validation = validateNormalizedManagedStepManifest(steps);
	if (!validation.ok)
		throw new Error(
			`generator planning refuses invalid managed-step manifest: ${validation.detail}`,
		);
	return {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		// Persist exactly the canonical manifest that the digest covers. The brand
		// itself is in-memory only; its normalized step payload is durable JSON.
		steps: validation.manifest.steps,
		postconditions: [],
		generator: material,
	} as unknown as GeneratorDurablePlan;
}

function render(
	plan: { readonly steps: readonly NormalizedManagedStep[] },
	planDigest: string,
): string {
	const destructive = plan.steps.filter(
		(step) => step.classification !== 'non-destructive',
	);
	return [
		'-- dbsp schema-differ generator plan; apply by id executes this exact normalized manifest unless a removal requires fresh live planning.',
		...plan.steps.flatMap((step) => [
			`-- ${step.classification}: ${step.stepKey}`,
			...step.statementBundle.statements.map((statement) =>
				statement.sql.endsWith(';') ? statement.sql : `${statement.sql};`,
			),
		]),
		...(destructive.length === 0
			? []
			: [
					`-- destructive acceptance required: --accept destructive-plan-accepted:${planDigest}`,
				]),
	].join('\n');
}

async function databaseId(pool: Pool): Promise<string> {
	const result = await pool.query('SELECT current_database() AS database_id');
	const value = result.rows[0]?.database_id;
	if (typeof value !== 'string' || value.length === 0)
		throw new Error(
			'schema-differ generator could not read current database identity',
		);
	return value;
}

/**
 * Produce and (unless previewing) persist the differ's full mutation set.
 * Every change is classified before it can reach the rendered statement list.
 */
export async function runGeneratorPlan(input: {
	readonly db: string;
	readonly schemaFile: string;
	readonly schema?: string;
	readonly dryRun?: boolean;
}): Promise<PlanResult> {
	const loaded = await loadSchema(input.schemaFile);
	const { pool } = await createDbConnection(input.db);
	try {
		const schema = input.schema ?? 'public';
		const diff = await comparePgsqlDatabaseSchema(
			createPgsqlAdapter(pool),
			loaded.model,
			{
				schema,
				// `apply --schema` owns one schema. Extensions are database-scoped,
				// so an extension not declared by this schema must not become a
				// schema-plan removal merely because it is installed in the database.
				ignoreUnmanagedExtensions: true,
				...(loaded.dbCasing ? { dbCasing: loaded.dbCasing } : {}),
			},
		);
		const declaredLifecycleWork = [...loaded.model.tables.values()].some(
			(table) =>
				table.adopt === true ||
				table.replace === true ||
				table.readdress !== undefined,
		);
		const lifecycleError = [...loaded.model.tables.values()]
			.map(declaredLifecycleDirectiveError)
			.find((detail) => detail !== undefined);
		if (lifecycleError) throw new Error(lifecycleError);
		const readdressRefusal = diff.changes.find(
			(change) =>
				change.kind === 'readdress_table' &&
				(change.meta?.readdressAssessment === 'source-missing' ||
					change.meta?.readdressAssessment === 'target-occupied'),
		);
		if (readdressRefusal)
			throw new Error(
				`generator planning refuses ${readdressRefusal.details}; no re-address manifest was created`,
			);
		if (diff.changes.length === 0 && !declaredLifecycleWork) {
			return {
				compareKind: 'no-drift',
				proveKind: 'no-drift',
				assessment: {
					...assessment(),
					decision: 'inapplicable',
					lifecycle: 'completed',
				},
				persisted: false,
				runId: null,
				planDigest: null,
			};
		}
		const adoptionMismatches = new Set(
			[...loaded.model.tables.values()]
				.filter(
					(table) =>
						table.adopt === true &&
						diff.changes.some((change) =>
							changeTargetsDeclaredTable(change, table.name),
						),
				)
				.map((table) => table.name),
		);
		const database = await databaseId(pool);
		const adoptionIdentities = new Map<string, CatalogueIdentity>();
		for (const table of loaded.model.tables.values()) {
			if (table.adopt !== true || adoptionMismatches.has(table.name)) continue;
			const live = await readPgCatalogueIdentity(pool, {
				engine: 'postgresql',
				database,
				schema: input.schema ?? 'public',
				kind: 'table',
				name: table.name,
			});
			if (!live?.catalogueIdentity)
				throw new Error(
					`declared adoption for ${table.name} refuses absent live identity`,
				);
			adoptionIdentities.set(table.name, live.catalogueIdentity);
		}
		// A declared lifecycle request owns every change at that address. Adoption
		// is a refusal rather than a mutation; replacement is its own reviewed
		// retire-and-create protocol. Keep unrelated drift intact.
		const executableDiff: SchemaDiff = {
			...diff,
			changes: diff.changes.filter(
				(change) =>
					![...loaded.model.tables.values()].some(
						(table) =>
							(table.adopt === true || table.replace === true) &&
							changeTargetsDeclaredTable(change, table.name),
					),
			),
		};
		const ordinaryChanges = executableDiff.changes.map((change) => ({
			kind: change.kind,
			table: change.table,
			...(change.column ? { column: change.column } : {}),
			classification: classifyGeneratedMutation(change.kind, change),
			details: change.details,
			statements:
				change.kind === 'readdress_table' && change.meta?.readdress
					? readdressStatements(
							database,
							schema,
							change.meta.readdress as TableReaddressDeclaration,
						)
					: generateMigrationSQL(
							{ ...executableDiff, changes: [change] },
							{ includeDestructive: true, schemaName: schema },
						),
			...(change.kind === 'readdress_table' && change.meta?.readdress
				? { readdress: change.meta.readdress as TableReaddressDeclaration }
				: {}),
		}));
		const material: GeneratorPlanMaterial = {
			kind: 'schema-differ-generator',
			planningSchema: schema,
			changes: [
				...ordinaryChanges,
				...[...loaded.model.tables.values()]
					.filter((table) => adoptionMismatches.has(table.name))
					.map((table) => ({
						kind: 'adoption_refused',
						table: table.name,
						classification: 'non-destructive' as const,
						details: `Refuse adoption of table "${table.name}": live shape does not match declaration`,
						statements: [],
					})),
				// `comparePgsqlDatabaseSchema` has just compared each side through
				// the established live canonicalisation path. An adopted table is
				// admitted only when that comparison has no remaining change for it.
				...[...loaded.model.tables.values()]
					.filter(
						(table) =>
							table.adopt === true &&
							!diff.changes.some((change) =>
								changeTargetsDeclaredTable(change, table.name),
							),
					)
					.map((table) => ({
						kind: 'adopt_table',
						table: table.name,
						classification: 'non-destructive' as const,
						details: `Adopt existing table "${table.name}" after live shape match`,
						statements: [],
						adoption: {
							declaration: adoptionDeclaration(table),
							shape: table,
							catalogueIdentity: requiredAdoptionIdentity(
								adoptionIdentities,
								table.name,
							),
						},
					})),
				...[...loaded.model.tables.values()]
					.filter((table) => table.replace === true)
					.map((table) => ({
						kind: 'replace_table',
						table: table.name,
						classification: 'removal' as const,
						details: `Replace table "${table.name}" by reviewed retirement then creation`,
						statements: [],
						replacement: replacementStatements(table, schema),
					})),
			],
		};
		// A foreign-key alteration is a replacement, not a removal that happens to
		// recreate something afterwards. Keep its two addresses/claim keys visible
		// in the durable manifest and let dependency linearisation order retirement
		// before the target vacancy claim.
		const ordinaryStepSources: Array<{
			step: NormalizedManagedStep;
			change: SchemaDiff['changes'][number];
		}> = [];
		for (const [changeIndex, change] of executableDiff.changes.entries()) {
			const generated = ordinaryChanges[changeIndex];
			if (!generated)
				throw new Error(
					'generator planning lost a generated statement bundle during lifecycle expansion',
				);
			const order = ordinaryStepSources.length;
			if (change.kind === 'alter_foreign_key') {
				const oldFk = change.meta?.oldFk;
				if (!oldFk || typeof oldFk !== 'object' || Array.isArray(oldFk))
					throw new Error(
						'generator planning refuses alter_foreign_key: missing typed old foreign key',
					);
				const [retireStatement, ...createStatements] = generated.statements;
				if (!retireStatement || createStatements.length === 0)
					throw new Error(
						'generator planning refuses alter_foreign_key: expected DROP then ADD bundle',
					);
				ordinaryStepSources.push({
					change,
					step: createPgsqlGeneratedManagedStep({
						change: {
							...change,
							kind: 'drop_foreign_key',
							destructive: true,
							meta: { fk: oldFk },
						},
						database,
						schema,
						stepKey: `generator:${order}:alter-foreign-key-retire`,
						order,
						dependencyOrder: [],
						statements: [retireStatement],
					}),
				});
				ordinaryStepSources.push({
					change,
					step: createPgsqlGeneratedManagedStep({
						change: { ...change, kind: 'add_foreign_key', destructive: false },
						database,
						schema,
						stepKey: `generator:${order + 1}:alter-foreign-key-create`,
						order: order + 1,
						dependencyOrder: [],
						statements: createStatements,
					}),
				});
				continue;
			}
			ordinaryStepSources.push({
				change,
				step: createPgsqlGeneratedManagedStep({
					change,
					database,
					schema,
					stepKey: `generator:${order}`,
					order,
					dependencyOrder: [],
					statements: generated.statements,
				}),
			});
		}
		const ordinarySteps = ordinaryStepSources.map(({ step }) => step);
		const lifecycleSteps: NormalizedManagedStep[] = [];
		for (const change of material.changes.slice(ordinaryChanges.length)) {
			const base = {
				order: ordinarySteps.length + lifecycleSteps.length,
				database,
				schema,
				table: change.table,
			};
			if (change.kind === 'replace_table' && change.replacement) {
				const replacementTable = [...loaded.model.tables.values()].find(
					(table) => table.name === change.table,
				);
				const replacementPostcondition = generatedPostconditionForChange({
					change: {
						kind: 'create_table',
						table: change.table,
						destructive: false,
						details: `Create replacement table "${change.table}"`,
						meta: { table: replacementTable },
					},
					schema,
				});
				if (replacementPostcondition === undefined)
					throw new Error(
						`generator planning refuses replacement ${change.table}: missing table postcondition`,
					);
				const selector = {
					kind: 'replacement' as const,
					selector: `table:${change.table}`,
				};
				lifecycleSteps.push(
					lifecycleStep({
						...base,
						stepKey: `generator:${base.order}:replacement-retire`,
						classification: 'removal',
						statements: change.replacement.retireStatements,
						selection: selector,
					}),
				);
				lifecycleSteps.push(
					lifecycleStep({
						...base,
						order: base.order + 1,
						stepKey: `generator:${base.order}:replacement-create`,
						classification: 'non-destructive',
						statements: change.replacement.createStatements,
						selection: selector,
						requiresVacancy: true,
						expectedDeclaration: replacementPostcondition,
					}),
				);
				continue;
			}
			if (change.kind === 'adopt_table' && change.adoption) {
				lifecycleSteps.push(
					lifecycleStep({
						...base,
						stepKey: `generator:${base.order}:adoption`,
						classification: 'non-destructive',
						selection: { kind: 'adoption', selector: `table:${change.table}` },
						expectedDeclaration: change.adoption.declaration,
						expectedCatalogueIdentity: change.adoption.catalogueIdentity,
						claimKind: 'adopt-intent',
						lifecycle: { kind: 'adoption', shape: change.adoption.shape },
					}),
				);
				continue;
			}
			lifecycleSteps.push(
				lifecycleStep({
					...base,
					stepKey: `generator:${base.order}`,
					classification: change.classification,
					...(change.kind === 'adoption_refused'
						? { lifecycle: { kind: 'adoption-refused' as const } }
						: {}),
				}),
			);
		}
		for (const { step, change } of ordinaryStepSources) {
			if (step.address?.kind !== 'table') continue;
			if (change?.kind !== 'readdress_table' || !change.meta?.readdress)
				continue;
			Object.assign(step as object, {
				claimKind: 'readdress-intent',
				selection: {
					kind: 'readdress',
					selector: `table:${step.address.name}`,
				},
				lifecycle: {
					kind: 'readdress',
					declaration: change.meta.readdress as TableReaddressDeclaration,
				},
			});
		}
		const steps = linearizeGeneratedManagedStepDependencies([
			...ordinarySteps,
			...lifecycleSteps,
		]);
		const plan = asDurableGeneratorPlan(material, steps);
		const planDigest = transitionPlanDigest(
			plan as unknown as InProcessProvenPlan,
		);
		const run: TransitionRunMetadata = {
			runId: `dbsp-generator-${randomUUID()}`,
			planDigest,
			targetContextDigest: canonicalJsonDigest({
				database: await databaseId(pool),
				schema,
			}),
			databaseId: await databaseId(pool),
			coreVersion: 'schema-differ-generator-v1',
			startedAt: new Date().toISOString(),
			replayability: material.changes.some(
				(change) => change.classification === 'removal',
			)
				? 'non-replayable-generator-removal'
				: 'replayable',
		};
		if (!input.dryRun) {
			const lease = await acquireTransitionLease(
				createPgTransitionLessor(pool),
			);
			try {
				await createPgTransitionRunPersister(lease.session).persist(
					run,
					plan as unknown as InProcessProvenPlan,
				);
			} finally {
				await lease.release();
			}
		}
		return {
			compareKind: 'transitions',
			proveKind: 'proven',
			assessment: assessment(),
			persisted: !input.dryRun,
			runId: input.dryRun ? null : run.runId,
			planDigest,
			plan: plan as unknown as InProcessProvenPlan,
			sql: render({ steps }, planDigest),
		};
	} finally {
		await pool.end();
	}
}
