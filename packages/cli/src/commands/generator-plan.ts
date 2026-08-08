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
} from '@dbsp/adapter-pgsql';
import type { InProcessProvenPlan } from '@dbsp/core';
import { acquireTransitionLease, transitionPlanDigest } from '@dbsp/core';
import type {
	PlanAssessment,
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
				...(loaded.dbCasing ? { dbCasing: loaded.dbCasing } : {}),
			},
		);
		if (diff.changes.length === 0) {
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
		const material: GeneratorPlanMaterial = {
			kind: 'schema-differ-generator',
			changes: diff.changes.map((change) => ({
				kind: change.kind,
				table: change.table,
				...(change.column ? { column: change.column } : {}),
				classification: classifyGeneratedMutation(change.kind),
				details: change.details,
				statements: generateMigrationSQL(
					{ ...diff, changes: [change] },
					{ includeDestructive: true, schemaName: schema },
				),
				...(change.kind === 'readdress_table' && change.meta?.readdress
					? {
							readdress: change.meta.readdress as TableReaddressDeclaration,
						}
					: {}),
			})),
			statements: generateMigrationSQL(diff, {
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
