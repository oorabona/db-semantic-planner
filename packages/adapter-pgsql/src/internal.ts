/**
 * Package-internal ledger primitives used by adapter tests and the managed
 * facade. They are intentionally absent from the documented adapter entry
 * point; supported integrations use managed execution/recovery facades.
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
	openPgOutcomeClaim,
	openPgOutcomeClaimGroup,
	recoverPgOutcomeClaim,
	resolvePgDestructiveOutcome,
	resolvePgOutcomeClaimGroup,
	runPgNonTransactionalOutcome,
	runPgTransactionalOutcome,
} from './transition/outcome-protocol.js';
export { executePgTableReaddress } from './transition/readdress.js';
