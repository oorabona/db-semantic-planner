/**
 * Shared test helper — CompilerContext factory.
 *
 * Used by handler error-path tests that need a minimal CompilerContext
 * with a fixed rootTable and optional per-call overrides.
 */

import type { CompilerContext } from '../../handlers/types.js';
import { identityNaming } from '../../naming-plugin.js';

/**
 * Build a minimal CompilerContext for unit tests.
 *
 * Defaults: rootTable='test_table', maxRecursiveDepth=100, identityNaming.
 * Pass `overrides` to customise specific fields per test case.
 */
export function makeCtx(
	overrides: Partial<CompilerContext> = {},
): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}
