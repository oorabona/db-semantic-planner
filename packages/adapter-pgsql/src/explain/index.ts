/**
 * EXPLAIN Statement Support
 */

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
} from './explain.js';
