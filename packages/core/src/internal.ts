/**
 * Package-internal managed-outcome authority. This subpath exists solely for
 * the PostgreSQL adapter and CLI orchestration; it is not part of the
 * documented @dbsp/core API.
 */
export {
	type AdmittedDestructiveOutcomeClaim,
	admitDestructiveOutcomeClaim,
	attachDestructiveAuthorityPermit,
	decideDestructiveDecision,
	isDestructiveAuthorityPermit,
} from './transition/destructive-authority.js';
export {
	admitOutcomeClaim,
	claimIdForToken,
	consumeClaimToken,
	mintClaimToken,
} from './transition/outcome-protocol.js';
