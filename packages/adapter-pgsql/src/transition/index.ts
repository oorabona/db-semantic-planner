export {
	type PgCatalogueIdentityQueryable,
	readPgCatalogueIdentity,
} from './catalogue-identity.js';
export {
	ADD_CHECK_RULE_ID,
	ALTER_AUTHORITY_OBSERVATION,
	ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND,
	ALTER_TABLE_ADD_CHECK_OPERATION_KIND,
	ALTER_TYPE_ADD_VALUE_OPERATION_KIND,
	ALTER_TYPE_AUTHORITY_OBSERVATION,
	ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	CHECK_CONSTRAINT_ABSENT_OBSERVATION,
	CHECK_ROWS_SATISFY_GUARD,
	COLUMN_EXISTS_OBSERVATION,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_RULE_ID,
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_RESERVATION_TABLE,
	DBSP_LOGICAL_IDENTITY_TABLE,
	DBSP_META_SCHEMA,
	DBSP_TRANSITION_AUTHORIZATION_TABLE,
	DBSP_TRANSITION_JOURNAL_TABLE,
	DBSP_TRANSITION_RUN_PLAN_TABLE,
	DBSP_TRANSITION_RUN_TABLE,
	ENGINE_VERSION_OBSERVATION,
	ENUM_ADD_VALUE_RULE_ID,
	ENUM_LABEL_VISIBLE_OBSERVATION,
	ENUM_TYPE_EXISTS_OBSERVATION,
	INDEX_ABSENT_OBSERVATION,
	LOGICAL_IDENTITY_ADOPTION_RULE_ID,
	LOGICAL_IDENTITY_CARRIER_OBSERVATION,
	MANUAL_SQL_OPERATION_KIND,
	NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD,
	NO_NULLS_GUARD,
	PG_DEPARSE_ARTIFACT,
	PG_INTROSPECTION_ARTIFACT,
	PG_OPERATION_PACK_ARTIFACT,
	PG_RULE_PACK_ARTIFACT,
	SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION,
	SET_NOT_NULL_RULE_ID,
	TABLE_CHECK_CONSTRAINTS_OBSERVATION,
	TABLE_INDEXES_OBSERVATION,
} from './constants.js';
export {
	createPgExecutionContract,
	evaluatePgExecutionContract,
	forcePgUtf8Session,
	PgExecutionContractDerivationError,
	pgTargetIdentityMismatch,
	preparePgExecutionSession,
	preparePgRecoveryAdmission,
	readPgExecutionTargetFromClient,
	validatePgExecutionContractDerivation,
} from './execution-contract.js';
export {
	INDEX_INCLUDE_CAPABILITY,
	INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
} from './index-feature-capabilities.js';
export {
	appendCompletionJournal,
	appendIntentJournal,
	appendObservedJournal,
	appendTransitionAuthorization,
	createPgTransitionRunPersister,
	ensureTransitionJournal,
	readTransitionJournal,
	renderCreateDbspMetaSchemaSql,
	renderCreateTransitionAuthorizationTableSql,
	renderCreateTransitionJournalTableSql,
	renderCreateTransitionRunPlanTableSql,
	renderCreateTransitionRunTableSql,
	type TransitionJournalQueryable,
} from './journal.js';
export {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerProgress,
	appendPgLedgerResolution,
	ensureDbspMetaLedger,
	ensurePgLedger,
	ensurePgLedgerStorageVersion,
	PG_LEDGER_MIN_SERVER_VERSION_NUM,
	PG_LEDGER_SHAPE_VERSION,
	type PgLedgerLockResult,
	PgLedgerStorageUnsupportedError,
	type PgLedgerTarget,
	recordPgLedgerIdentity,
	renderCreateLedgerEventTableSql,
	renderCreateLedgerIdentityTableSql,
	renderCreateLedgerImmutabilityFunctionSql,
	renderCreateLedgerImmutabilityTriggerSql,
	renderCreateLedgerMarkerTableSql,
	renderCreateLedgerReservationTableSql,
	renderCreateLedgerTerminalMemberIndexSql,
	writePgLedgerShapeMarker,
} from './ledger.js';
export {
	acquirePgTransitionClient,
	createPgTransitionLessor,
	type PgTransitionClientLease,
	type PgTransitionRunLockResult,
	withPgTransitionRunLock,
} from './lessor.js';
// The …FromClient helpers stay internal: the supported entry points acquire and
// release their own lease, so a caller never has to hold one to read context.
export {
	createPgObservationIssuer,
	executePgObservationFromLessor,
	readPgObservationContextFromLessor,
} from './observation-issuer.js';
export {
	type AlterColumnSetNotNullPayload,
	createAlterColumnSetNotNullOperationRuntime,
	renderAlterColumnSetNotNullSql,
	renderNoNullsCheckSql,
	renderSetNotNullLockSql,
} from './operations/alter-column-set-not-null.js';
export {
	type AlterTableAddCheckPayload,
	type CheckSet,
	createAlterTableAddCheckOperationRuntime,
	renderAddCheckLockSql,
	renderAlterTableAddCheckSql,
	renderCheckRowsSatisfySql,
} from './operations/alter-table-add-check.js';
export {
	type AlterTypeAddValuePayload,
	createAlterTypeAddValueOperationRuntime,
	renderAlterTypeAddValueSql,
} from './operations/alter-type-add-value.js';
export {
	type AttachLogicalIdentityPayload,
	createAttachLogicalIdentityOperationRuntime,
	renderAttachLogicalIdentityLockSql,
	renderCreateLogicalIdentityIndexesSql,
	renderCreateLogicalIdentitySideTableSql,
	renderInsertLogicalIdentitySql,
} from './operations/attach-logical-identity.js';
export {
	type CreateUniqueIndexConcurrentlyPayload,
	createCreateUniqueIndexConcurrentlyOperationRuntime,
	type IndexSet,
	renderCreateUniqueIndexConcurrentlySql,
	renderDropIndexConcurrentlySql,
} from './operations/create-unique-index-concurrently.js';
export {
	createManualSqlOperationRuntime,
	type ManualSqlPayload,
	normalizeManualSqlPayload,
} from './operations/manual-sql.js';
export {
	createPgTransitionPack,
	type PgTransitionPackOptions,
} from './pack.js';
export {
	assembleReinitializePreflightScopeReports,
	classifyPgLedgerMarker,
	type PgReinitializePreflightOptions,
	type PgReinitializePreflightPool,
	type ReinitializePreflightCheckpoint,
	type ReinitializePreflightObserver,
	runPgReinitializePreflight,
	selectReinitializeAdoptionCandidates,
} from './reinitialize-preflight.js';
export {
	type AddCheckMatch,
	type AddCheckRuleOptions,
	createAddCheckRule,
} from './rules/add-check.js';
export {
	createLogicalIdentityAdoptionRule,
	type IdentityAdoptionAsserter,
	type LogicalIdentityAdoptionMatch,
	type LogicalIdentityAdoptionRuleOptions,
} from './rules/adopt-logical-identity.js';
export {
	type CreateUniqueIndexConcurrentlyMatch,
	type CreateUniqueIndexConcurrentlyRuleOptions,
	createCreateUniqueIndexConcurrentlyRule,
} from './rules/create-unique-index-concurrently.js';
export {
	createEnumAddValueRule,
	type EnumAddValueMatch,
	type EnumAddValueRuleOptions,
} from './rules/enum-add-value.js';
export {
	createSetNotNullRule,
	type SetNotNullMatch,
	type SetNotNullRuleOptions,
} from './rules/set-not-null.js';
