/**
 * Published `@dbsp/adapter-pgsql/internal` export for the DBSP-managed facade
 * and adapter tests. It is unsupported for external integrations: in-process
 * callers are trusted by declaration, and this export is not a security
 * boundary. Supported integrations use the public managed execution/recovery
 * facades.
 */
export {
	appendPgLedgerClaim,
	appendPgLedgerClaimGroup,
	appendPgLedgerProgress,
	appendPgLedgerRelease,
	appendPgLedgerResolution,
	appendPgLedgerResolutionGroup,
	classifyPgLedgerPhysicalShape,
	type PgLedgerPhysicalShapeOutcome,
	readPgLedgerReservationsForPair,
} from './transition/ledger.js';
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
