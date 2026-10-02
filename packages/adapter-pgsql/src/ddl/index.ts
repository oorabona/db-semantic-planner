/**
 * DDL Generation Module - Main exports
 *
 * @module ddl
 */

export {
	canGenerateCreateIndex,
	generateCreateIndex,
} from './ddl-generator.js';
export {
	classifyGeneratedMutation,
	type GeneratedMutationClassification,
	isGeneratedMutationDestructive,
	refusesRecordedPlanRemoval,
} from './destructive-classification.js';
export {
	type GeneratedIdentityObservation,
	type GeneratedPostconditionObservation,
	type GeneratedPostconditionReadBack,
	type GeneratedStructuralObservation,
	readGeneratedPostcondition,
	readGeneratedPostconditionReadBack,
} from './generated-postcondition-reader.js';
export {
	assertGeneratedPostconditionSession,
	decodeGeneratedPostcondition,
	decodeGeneratedPostconditionPayload,
	type GeneratedPostconditionBindingAddress,
	GeneratedPostconditionBindingResolutionError,
	GeneratedPostconditionProofInFlightError,
	GeneratedPostconditionReplanRequiredError,
	type GeneratedPostconditionSession,
	GeneratedPostconditionSessionDeactivatedError,
	GeneratedPostconditionWorkInFlightError,
	toGeneratedPostconditionBindingAddress,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedIdentityPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
	withGeneratedPostconditionSession,
} from './generated-postcondition-verifier.js';
export {
	AutoIncrementTransitionUnsupportedError,
	assertCreateIndexesSupported,
	assertCreateIndexSupported,
	type IndexCapabilityContext,
	IndexFeatureUnsupportedError,
	type IndexRenderSpec,
	renderCreateIndex,
} from './index-render.js';
export {
	type AddedEnumValue,
	assertNoRepeatedExpressionSurfaceDrift,
	CheckConstraintNewEnumValueError,
	ExpressionKeyedIndexPredicateCanonicalizationUnsupportedError,
	IndexPredicateCanonicalizationError,
	NonConvergentSchemaDiffError,
	type NonConvergentSchemaDiffSurface,
	PartialIndexPredicateNewEnumValueError,
	RawIndexPredicateFallbackError,
} from './live-diff.js';
export {
	assertDeclarableChangeKind,
	createPgGeneratedManagedStep,
	type GeneratedPostcondition,
	generatedPostconditionDigest,
	generatedPostconditionForChange,
} from './managed-step-manifest.js';
export {
	type ComparePgDatabaseSchemaOptions,
	type CompareSchemataOptions,
	comparePgDatabaseSchema,
	compareSchemata,
	type GenerateDDLOptions,
	generateDDL,
	generateDownSQL,
	generateMigrationSQL,
	type MigrationSQLOptions,
	PgPhysicalModelSchemaMismatchError,
	type PgSchemaDiff,
} from './public-api.js';
export {
	type ChangeKind,
	type DiffSummary,
	ExpressionCanonicalizationUnavailableError,
	type ReferencedKeyKind,
	type ReferencedKeyRemovalConflict,
	ReferencedKeyRemovalError,
	type SchemaChange,
	type SchemaDiff,
} from './schema-diff.js';
export { mapColumnType, mapOnDeleteAction } from './type-mapping.js';
