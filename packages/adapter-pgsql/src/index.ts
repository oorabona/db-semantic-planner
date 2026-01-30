/**
 * @dbsp/adapter-pgsql
 *
 * Native PostgreSQL adapter using tree-to-tree transformation:
 * PlanReport → PostgreSQL AST → SQL (via pgsql-deparser)
 */

// AST Comparison functions are lazy-loaded in tests only
// AST Helpers
export {
	andExpr,
	// Expressions
	binaryExpr,
	booleanConstNode,
	coalesce,
	// Column/table refs
	columnRef,
	columnRefStar,
	columnTarget,
	countDistinct,
	countStar,
	type DeleteOptions,
	deleteStmt,
	eqExpr,
	floatNode,
	// Functions
	funcCall,
	gtExpr,
	gteExpr,
	type InsertOptions,
	ilikeExpr,
	innerJoin,
	insertStmt,
	integerNode,
	// Joins
	joinExpr,
	leftJoin,
	likeExpr,
	ltExpr,
	lteExpr,
	neExpr,
	notExpr,
	nullConstNode,
	orExpr,
	rangeVar,
	resTarget,
	// Types
	type SelectOptions,
	// Statements
	selectStmt,
	// Sort
	sortBy,
	starTarget,
	// Basic nodes
	stringNode,
	// Type casts
	typeCast,
	type UpdateOptions,
	updateStmt,
} from './ast-helpers.js';
// Compiler
export {
	type CompiledResult,
	type CompilerOptions,
	compilePlan,
	PlanCompiler,
	type PlanDecision,
	type SimplifiedPlanReport,
} from './compiler.js';
// DDL Generation
export {
	type GenerateDDLOptions,
	generateDDL,
	mapColumnType,
	mapOnDeleteAction,
} from './ddl/index.js';
// EXPLAIN support
export {
	buildExplain,
	buildExplainAnalyzeJson,
	buildExplainPlan,
	buildExplainVerbose,
	type ExplainFormat,
	type ExplainOptions,
	type ExplainPlan,
	getRowEstimates,
	getTotalExecutionTime,
	parseExplainJson,
} from './explain/index.js';
// Handler Registry
export {
	ALL_OPERATORS,
	COLLECTION_OPERATORS,
	// Operator constants
	COMPARISON_OPERATORS,
	// Types
	type CompilerContext,
	type CompilerState,
	clearHandlers,
	// State factory
	createCompilerState,
	// Dispatcher
	createWhereDispatcher,
	type Decision,
	type ExpressionHandler,
	getExpressionHandler,
	getIncludeHandler,
	getRegisteredOperators,
	// Debugging
	getRegistryStats,
	// Lookup
	getWhereHandler,
	hasExpressionHandler,
	hasIncludeHandler,
	hasWhereHandler,
	type IncludeHandler,
	type IncludeResult,
	LOGICAL_OPERATORS,
	NULL_OPERATORS,
	PATTERN_OPERATORS,
	registerExpressionHandler,
	registerIncludeHandler,
	// Registration
	registerWhereHandler,
	type WhereDispatcher,
	type WhereHandler,
} from './handlers/index.js';
// Mutations
export {
	buildOnConflictClause,
	type ConflictAction,
	type ConflictTarget,
	compileDelete,
	compileInsert,
	compileMutation,
	compileUpdate,
	compileUpsert,
	conditionalUpdate,
	type DeleteConfig,
	excludedRef,
	type InsertConfig,
	type UpdateConfig,
	type UpsertConfig,
} from './mutations/index.js';
// Naming resolution
export { resolveLogicalName } from './naming.js';
// Naming plugins
export {
	CamelCaseNamingPlugin,
	camelCaseNaming,
	getNamingPlugin,
	IdentityNamingPlugin,
	identityNaming,
	type NamingPlugin,
} from './naming-plugin.js';
// ParamRef validation
export {
	collectAndValidateParamRefs,
	createAnyExpr,
	createEqualityExpr,
	createParamRef,
	createTypeCastParamRef,
	type ParamRefValidationResult,
	validateParamRef,
} from './param-ref.js';
// Adapter
export {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
	PgsqlAdapter,
	type PgsqlAdapterOptions,
} from './pgsql-adapter.js';
// Streaming (cursor-based)
export {
	buildCloseCursor,
	buildDeclareCursor,
	buildFetch,
	buildFetchAll,
	buildFetchFirst,
	buildFetchForward,
	buildFetchNext,
	buildStreamingStatements,
	type CursorHoldOption,
	type CursorOptions,
	type CursorScrollOption,
	type FetchDirection,
	type FetchOptions,
	generateCursorName,
	type StreamConfig,
} from './streaming/index.js';
// Validation
export {
	InvalidIdentifierError,
	isReservedKeyword,
	sanitizeForDisplay,
	validateIdentifier,
	validateIdentifiers,
	validateQualifiedIdentifier,
} from './validate.js';
