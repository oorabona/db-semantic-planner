/* biome-ignore-all lint/style/noNonNullAssertion: NQL AST node access requires non-null assertions on validated parse tree */
/**
 * @module compiler/compile-cte
 * Compiles NQL WITH/CTE syntax to CteQueryIntent.
 */

import {
	type CteQueryIntent,
	NotYetSupportedError,
	type QueryIntent,
	type SimpleCteIntent,
} from '@dbsp/types';
import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';
import type { NqlWithQuery } from '../parser/ast.js';
import { compileNestedQuery, compileQuery } from './compile-query.js';
import type { CompileResult, CompilerContext, CompilerFns } from './types.js';

/**
 * Compile an NQL WITH query (CTE syntax) to a CteQueryIntent.
 *
 * Algorithm:
 * 1. Collect CTE names, validate no duplicates.
 * 2. Register CTE names in validator to bypass table existence check.
 * 3. Compile each CTE body to QueryIntent (a set operation there is not yet supported, #1080).
 * 4. Compile outer query (CTE names are now known tables).
 * 5. Clear CTE names from validator.
 * 6. Return CteQueryIntent.
 */
export function compileWithQuery(
	astNode: NqlWithQuery,
	ctx: CompilerContext,
	fns: CompilerFns,
): CompileResult {
	// 1. Validate no duplicate CTE names
	const cteNames = new Set<string>();
	for (const cte of astNode.ctes) {
		if (cteNames.has(cte.name)) {
			throw new NqlSemanticException(
				NqlErrorCodes.SEM_DUPLICATE_BINDING,
				`Duplicate CTE name: '${cte.name}'. Each CTE must have a unique name.`,
			);
		}
		cteNames.add(cte.name);
	}

	// 2. Register CTE names in validator so outer query can reference them
	ctx.validator?.addKnownCteTables(cteNames);

	try {
		// 3. Compile each CTE body
		const ctes: SimpleCteIntent[] = [];
		for (const cte of astNode.ctes) {
			const bodyResult = compileNestedQuery(cte.query, ctx, fns);
			if ('kind' in bodyResult && bodyResult.kind === 'setOperation') {
				throw new NotYetSupportedError(
					`a set operation (CTE '${cte.name}')`,
					'CTE body',
					1080,
				);
			}
			ctes.push({
				kind: 'simpleCte',
				name: cte.name,
				query: bodyResult as QueryIntent,
			});
		}

		// 4. Compile outer query (CTE names are registered as known tables)
		const outerResult = compileQuery(astNode.query, ctx, fns);
		if ('kind' in outerResult && outerResult.kind === 'setOperation') {
			throw new NotYetSupportedError(
				'a set operation',
				'WITH clause outer query',
				1080,
			);
		}

		const cteQueryIntent: CteQueryIntent = {
			kind: 'cteQuery',
			ctes,
			query: outerResult as QueryIntent,
		};

		return { cteQuery: cteQueryIntent };
	} finally {
		// 5. Always clear CTE names to avoid state leakage between compilations
		ctx.validator?.clearKnownCteTables();
	}
}
