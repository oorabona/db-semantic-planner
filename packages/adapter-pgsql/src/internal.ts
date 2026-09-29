/**
 * Published `@dbsp/adapter-pgsql/internal` export for the DBSP-managed facade
 * and adapter tests. It is unsupported for external integrations: in-process
 * callers are trusted by declaration, and this export is not a security
 * boundary. Supported integrations use the public managed execution/recovery
 * facades.
 */

export {
	type ComparePgsqlDeclaredAdoptionSchemaInput,
	comparePgsqlDeclaredAdoptionSchema,
	modelForDeclaredAdoption,
	type PgsqlAdoptionComparisonExecutor,
} from './ddl/live-diff.js';
export {
	createPgsqlDeclaredAdoptionStep,
	createPgsqlDeclaredSequenceAdoptionStep,
	pgsqlDeclaredAdoptionDeclaration,
	pgsqlDeclaredSequenceAdoptionDeclaration,
} from './ddl/managed-step-manifest.js';
export { collectReferencedKeyRemovalConflicts } from './ddl/schema-diff.js';
export {
	type ConvergePgCheckOptions,
	type ConvergePgOptions,
	convergePg,
	type PgConvergeCheckResult,
	type PgConvergePlannedStep,
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
