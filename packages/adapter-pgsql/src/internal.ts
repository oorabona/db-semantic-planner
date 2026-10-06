/**
 * Published `@dbsp/adapter-pgsql/internal` export for the DBSP-managed facade
 * and adapter tests. It is unsupported for external integrations: in-process
 * callers are trusted by declaration, and this export is not a security
 * boundary. Supported integrations use the public managed execution/recovery
 * facades.
 */

// Compiler
export {
	type BatchValuesJoinDecision,
	type CompiledResult,
	type CompilerOptions,
	compilePlan,
	isBatchValuesJoinDecision,
	isJoinDecision,
	isPrecompiledJoinDecision,
	type JoinDecision,
	PlanCompiler,
	type PlanDecision,
	type PrecompiledJoinDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
export {
	type GenerateDDLOptions,
	generateDDL,
} from './ddl/ddl-generator.js';
export {
	type ComparePgDatabaseSchemaOptions,
	type ComparePgDeclaredAdoptionSchemaInput,
	comparePgDatabaseSchema,
	comparePgDeclaredAdoptionSchema,
	modelForDeclaredAdoption,
	type PgAdoptionComparisonExecutor,
} from './ddl/live-diff.js';
export {
	createPgDeclaredAdoptionStep,
	createPgDeclaredSequenceAdoptionStep,
	pgDeclaredAdoptionDeclaration,
	pgDeclaredSequenceAdoptionDeclaration,
} from './ddl/managed-step-manifest.js';
export {
	generateDownSQL,
	generateMigrationSQL,
	type MigrationSQLOptions,
} from './ddl/migration-sql.js';
export {
	type CompareSchemataOptions,
	collectReferencedKeyRemovalConflicts,
	compareSchemata,
} from './ddl/schema-diff.js';
export type {
	PgApplicationStepTx,
	PgConvergeApplicationStep,
	PgConvergeAssertStep,
	PgConvergeOnceStep,
} from './transition/application-step.js';
export {
	type ConvergePgBaseOptions,
	type ConvergePgCheckOptions,
	type ConvergePgOptions,
	convergePg,
	type PgConvergeCheckResult,
	type PgConvergeInitializationFailure,
	type PgConvergePlannedStep,
	type PgConvergeRefusalChange,
	PgConvergeRefusalError,
	type PgConvergeResult,
} from './transition/converge.js';
export {
	executeGeneratorPlan,
	type GeneratorExecutionResult,
} from './transition/generator-execution.js';
export {
	appendPgLedgerClaim,
	appendPgLedgerClaimGroup,
	appendPgLedgerProgress,
	appendPgLedgerRelease,
	appendPgLedgerResolution,
	appendPgLedgerResolutionGroup,
	classifyPgLedgerPhysicalShape,
	createPgLedgerShapeAllowance,
	type PgLedgerPhysicalShapeOutcome,
	type PgLedgerShapeAllowance,
	readPgLedgerReservationsForPair,
} from './transition/ledger.js';
export {
	type ApplyPgTransitionRunOptions,
	applyPgTransitionRun,
	type PgLiveSchemaReader,
	type PgTransitionPlanResult,
	type PgTransitionRunApplyResult,
	PgTransitionRunPersistenceIndeterminateError,
	type PlanPgTransitionRunOptions,
	planPgTransitionRun,
} from './transition/lifecycle.js';
export {
	appendPgOutcomeResolution,
	executePgDestructiveOutcome,
	lockPgJournalRun,
	openPgOutcomeClaim,
	openPgOutcomeClaimGroup,
	PgCommitAcknowledgementAmbiguousError,
	recoverPgAdmittedReaddressPair,
	recoverPgOutcomeClaim,
	resolvePgDestructiveOutcome,
	resolvePgOutcomeClaimGroup,
} from './transition/outcome-protocol.js';
export {
	createPostLockAdmissionEvidence,
	isPostLockAdmissionEvidence,
	type PostLockAdmissionEvidence,
} from './transition/post-lock-admission-evidence.js';
