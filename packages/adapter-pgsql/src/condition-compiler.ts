/** Acyclic composition of the condition compiler. */
import { createConditionCompiler } from './condition-compiler-factory.js';
import { buildCustomFnFilter } from './custom-fn-filter.js';

export type {
	ConditionCompilerCtx,
	ConditionPosition,
	WhereCompilerCtx,
} from './condition-context.js';
export const { compileCondition } =
	createConditionCompiler(buildCustomFnFilter);
