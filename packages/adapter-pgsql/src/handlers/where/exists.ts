/**
 * Relation correlation and scope-alias helpers shared by the include handlers
 * and the select compiler.
 */

import { type ColumnListInput, toColumnList } from '@dbsp/types';
import type { Node } from '@pgsql/types';
import { andExpr, eqExpr } from '../../ast-helpers.js';
import type { CompilerContext, CompilerState } from '../types.js';
import { expressionQualifiedColumnRef } from '../types.js';

export function buildKeyCorrelation(
	sourceAlias: string,
	sourceCols: ColumnListInput,
	targetAlias: string,
	targetCols: ColumnListInput,
	ctx: CompilerContext,
): Node {
	const normalizedSourceCols = toColumnList(sourceCols);
	const normalizedTargetCols = toColumnList(targetCols);
	if (
		normalizedSourceCols.length === 0 ||
		normalizedTargetCols.length === 0 ||
		normalizedSourceCols.length !== normalizedTargetCols.length ||
		normalizedSourceCols.some((column) => column.length === 0) ||
		normalizedTargetCols.some((column) => column.length === 0)
	) {
		throw new Error(
			`Invalid relation correlation: source columns (${normalizedSourceCols.length}) must match target columns (${normalizedTargetCols.length}) and both must be non-empty.`,
		);
	}

	const comparisons = normalizedSourceCols.map((sourceColumn, index) =>
		eqExpr(
			expressionQualifiedColumnRef(sourceColumn, sourceAlias, ctx),
			expressionQualifiedColumnRef(
				normalizedTargetCols[index]!,
				targetAlias,
				ctx,
			),
		),
	);
	if (comparisons.length === 1) return comparisons[0]!;
	return andExpr(...comparisons);
}

/** Allocate and reserve a fresh query-local name without shadowing SQL scope. */
export function allocateScopeAlias(
	ctx: CompilerContext,
	state: CompilerState,
	candidateForSuffix: (suffix: number) => string,
	initialSuffix = state.aliases.size,
	additionalNames: Iterable<string> = [],
): string {
	const scopeName = (identifier: string): string => identifier;
	const outerAliases = new Set<string>(additionalNames);
	if (ctx.currentAlias) outerAliases.add(scopeName(ctx.currentAlias));
	if (ctx.rootTable) outerAliases.add(scopeName(ctx.rootTable));
	if (ctx.outerAlias) outerAliases.add(scopeName(ctx.outerAlias));
	for (const binding of ctx.scope?.bindings.values() ?? []) {
		outerAliases.add(scopeName(binding.qualifier));
	}
	const aliasInUse = (candidate: string): boolean => {
		if (outerAliases.has(candidate)) return true;
		for (const key of state.aliases.keys()) {
			if (key === candidate) return true;
		}
		for (const value of state.aliases.values()) {
			if (value === candidate) return true;
		}
		return false;
	};
	let suffix = initialSuffix;
	let targetAlias = candidateForSuffix(suffix);
	while (aliasInUse(targetAlias)) {
		suffix += 1;
		targetAlias = candidateForSuffix(suffix);
	}
	state.aliases.set(targetAlias, targetAlias);

	return targetAlias;
}
