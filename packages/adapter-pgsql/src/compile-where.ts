/** Compatibility bridge; callers keep their current compiler/context in step 1. @internal */
export {
	buildSubqueryFromIntent,
	compileWhereIntent,
} from './condition-compiler.js';
export type { WhereCompilerCtx } from './condition-context.js';
