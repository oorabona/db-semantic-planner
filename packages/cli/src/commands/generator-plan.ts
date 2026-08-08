/**
 * The schema-differ producer used by the no-argument apply command.
 *
 * This deliberately lives beside `apply`, rather than in the transition
 * planner: generated removals have a different replay contract.  The emitted
 * document is nevertheless persisted in the same journal and digest domain so
 * that it is inspectable before an operator makes a fresh live-state decision.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
	classifyGeneratedMutation,
	comparePgsqlDatabaseSchema,
	createPgsqlAdapter,
	createPgTransitionLessor,
	createPgTransitionRunPersister,
	generateMigrationSQL,
	readPgCatalogueIdentity,
	type SchemaDiff,
} from '@dbsp/adapter-pgsql';
import type { InProcessProvenPlan } from '@dbsp/core';
import { acquireTransitionLease, transitionPlanDigest } from '@dbsp/core';
import type {
	CatalogueIdentity,
	LedgerPayload,
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
	readonly statements: readonly string[];
}

/** Extra persisted material is digest-covered; the regular applier never executes it. */
export type GeneratorDurablePlan = InProcessProvenPlan & {
	readonly generator: GeneratorPlanMaterial;
};

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function adoptionDeclaration(table: TableIR): LedgerPayload {
	// The live differ is the shape comparator. Persist the exact authored table
	// shape, rather than a boolean that could later be reinterpreted.
	const value = JSON.parse(
		JSON.stringify({ kind: 'table', name: table.name, shape: table }),
	) as LedgerPayload['value'];
	return { value, digest: digest(value) };
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

function assessment(): PlanAssessment {
	return {
		decision: 'applicable',
		assurance: 'established',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [],
	};
}

function asDurableGeneratorPlan(
	material: GeneratorPlanMaterial,
): GeneratorDurablePlan {
	// This is intentionally an empty transition operation graph.  It is an audit
	// carrier for a generator run, not an attempt to teach the transition planner
	// how to map a DROP.  `apply <run-id>` rejects this replayability class before
	// its normal serialized-plan adoption boundary.
	return {
		observations: [],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps: [],
		postconditions: [],
		generator: material,
	} as unknown as GeneratorDurablePlan;
}

function render(material: GeneratorPlanMaterial, planDigest: string): string {
	const destructive = material.changes.filter(
		(change) => change.classification !== 'non-destructive',
	);
	return [
		'-- dbsp schema-differ generator plan; this run is reviewable and is not replayable by id.',
		...material.changes.map(
			(change) => `-- ${change.classification}: ${change.details}`,
		),
		...material.statements.map((statement) => `${statement};`),
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
			(table) => table.adopt === true || table.replace === true,
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
						diff.changes.some((change) => change.table === table.name),
				)
				.map((table) => table.name),
		);
		const replacementTables = new Set(
			[...loaded.model.tables.values()]
				.filter((table) => table.replace === true)
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
					!adoptionMismatches.has(change.table) &&
					!replacementTables.has(change.table),
			),
		};
		const material: GeneratorPlanMaterial = {
			kind: 'schema-differ-generator',
			changes: [
				...executableDiff.changes.map((change) => ({
					kind: change.kind,
					table: change.table,
					...(change.column ? { column: change.column } : {}),
					classification: classifyGeneratedMutation(change.kind),
					details: change.details,
					statements: generateMigrationSQL(
						{ ...executableDiff, changes: [change] },
						{ includeDestructive: true, schemaName: schema },
					),
					...(change.kind === 'readdress_table' && change.meta?.readdress
						? {
								readdress: change.meta.readdress as TableReaddressDeclaration,
							}
						: {}),
				})),
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
							!diff.changes.some((change) => change.table === table.name),
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
							catalogueIdentity: adoptionIdentities.get(table.name)!,
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
			statements: generateMigrationSQL(executableDiff, {
				includeDestructive: true,
				schemaName: schema,
			}),
		};
		const plan = asDurableGeneratorPlan(material);
		const planDigest = transitionPlanDigest(plan);
		const run: TransitionRunMetadata = {
			runId: `dbsp-generator-${randomUUID()}`,
			planDigest,
			targetContextDigest: digest({ database: await databaseId(pool), schema }),
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
				await createPgTransitionRunPersister(lease.session).persist(run, plan);
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
			plan,
			sql: render(material, planDigest),
		};
	} finally {
		await pool.end();
	}
}
