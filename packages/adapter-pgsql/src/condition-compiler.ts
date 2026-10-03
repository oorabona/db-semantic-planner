/** Acyclic composition of the full condition compiler and handler dispatcher. */
import { createConditionCompiler } from './condition-compiler-factory.js';
import { buildCustomFnFilter } from './custom-fn-filter.js';
import { createWhereDispatcher } from './handlers/index.js';

export type {
	ConditionCompilerCtx,
	ConditionPosition,
	WhereCompilerCtx,
} from './condition-context.js';
export const { compileCondition, compileWhereIntent, buildSubqueryFromIntent } =
	createConditionCompiler(createWhereDispatcher, buildCustomFnFilter);
