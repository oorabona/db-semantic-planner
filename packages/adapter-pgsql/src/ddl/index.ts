/**
 * DDL Generation Module - Main exports
 *
 * @module ddl
 */

export {
	canGenerateCreateIndex,
	type GenerateDDLOptions,
	generateCreateIndex,
	generateDDL,
} from './ddl-generator.js';
export {
	classifyGeneratedMutation,
	type GeneratedMutationClassification,
	isGeneratedMutationDestructive,
	refusesRecordedPlanRemoval,
} from './destructive-classification.js';
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
	verifyGeneratedCheckPostcondition,
	verifyGeneratedColumnPostcondition,
	verifyGeneratedConstraintPostcondition,
	verifyGeneratedEnumPostcondition,
	verifyGeneratedExtensionPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedSequencePostcondition,
	verifyGeneratedTablePostcondition,
	withGeneratedPostconditionSession,
} from './generated-postcondition-verifier.js';
export {
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
	type ComparePgsqlDatabaseSchemaOptions,
	comparePgsqlDatabaseSchema,
	ExpressionKeyedIndexPredicateCanonicalizationUnsupportedError,
	IndexPredicateCanonicalizationError,
	NonConvergentSchemaDiffError,
	type NonConvergentSchemaDiffSurface,
	PartialIndexPredicateNewEnumValueError,
	RawIndexPredicateFallbackError,
} from './live-diff.js';
export {
	assertDeclarableChangeKind,
	createPgsqlGeneratedManagedStep,
	type GeneratedPostcondition,
	generatedPostconditionDigest,
	generatedPostconditionForChange,
} from './managed-step-manifest.js';
export {
	generateDownSQL,
	generateMigrationSQL,
	type MigrationSQLOptions,
} from './migration-sql.js';
export {
	type ChangeKind,
	type CompareSchemataOptions,
	compareSchemata,
	type DiffSummary,
	ExpressionCanonicalizationUnavailableError,
	type SchemaChange,
	type SchemaDiff,
} from './schema-diff.js';
export { mapColumnType, mapOnDeleteAction } from './type-mapping.js';
