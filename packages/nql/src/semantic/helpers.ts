// @ts-nocheck — Chevrotain CST visitor helpers
/**
 * @module semantic/helpers
 * Shared types and utility functions for NQL CST-to-AST visitor.
 */

import type { CstNode, IToken } from 'chevrotain';
import { NqlErrorCodes, NqlSemanticException } from '../errors/index.js';

/** CST context type — values are arrays of CstNode or IToken */
export type CstContext = Record<string, (CstNode | IToken)[] | undefined>;

/** Visitor dispatch function — calls this.visit() on a CstNode */
// biome-ignore lint/suspicious/noExplicitAny: Chevrotain BaseCstVisitor.visit() returns any
export type VisitFn = (node: CstNode) => any;

/** Type guard to check if value is a CstNode (has children property) */
function isCstNode(value: CstNode | IToken): value is CstNode {
	return 'children' in value;
}

/** Safely extract CstNode from context array */
export function asCstNode(value: CstNode | IToken): CstNode {
	/* v8 ignore start — defensive: Chevrotain parser guarantees CstNode at call sites -- @preserve */
	if (!isCstNode(value)) {
		throw new NqlSemanticException(
			NqlErrorCodes.SEM_UNREACHABLE,
			`Expected CstNode but got IToken: ${(value as IToken).image}`,
		);
	}
	/* v8 ignore stop -- @preserve */
	return value;
}

/** Get token image */
export function getImage(value: CstNode | IToken): string {
	/* v8 ignore start — defensive: callers always pass IToken -- @preserve */
	if (isCstNode(value)) {
		unreachable('Expected IToken but got CstNode');
	}
	/* v8 ignore stop -- @preserve */
	return (value as IToken).image;
}

/** Guard: require a context field to be present, return first element */
export function requireFirst(
	ctx: CstContext,
	field: string,
	message: string,
): CstNode | IToken {
	const arr = ctx[field];
	if (!arr?.[0]) {
		throw new NqlSemanticException(NqlErrorCodes.SEM_INVALID_SYNTAX, message);
	}
	return arr[0];
}

/** Guard: require multiple context fields to be present */
export function requireFields(
	ctx: CstContext,
	fields: string[],
	message: string,
): void {
	for (const field of fields) {
		if (!ctx[field]) {
			throw new NqlSemanticException(NqlErrorCodes.SEM_INVALID_SYNTAX, message);
		}
	}
}

/** Shorthand for unreachable code paths in exhaustive if-else chains */
export function unreachable(message: string): never {
	throw new NqlSemanticException(NqlErrorCodes.SEM_UNREACHABLE, message);
}

/**
 * Window specification returned by windowClause visitor
 */
export interface WindowSpec {
	partitionBy: NqlExpression[];
	orderBy: NqlOrderItem[];
}

// Re-import for WindowSpec typing
import type { NqlExpression, NqlOrderItem } from '../parser/ast.js';
