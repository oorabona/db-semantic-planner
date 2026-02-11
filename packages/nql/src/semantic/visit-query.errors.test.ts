import { describe, expect, it } from 'vitest';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
import type { CstContext } from './helpers.js';
import {
	visitJoinSpec,
	visitLimitClause,
	visitOffsetClause,
	visitOrderItem,
	visitParam,
	visitProgram,
	visitQuery,
	visitQueryClause,
	visitSelectItem,
	visitSetClause,
	visitStatement,
	visitTableRef,
	visitWhereClause,
} from './visit-query.js';

/**
 * Build a minimal CstNode-like object (has `children` property).
 * Chevrotain CstNodes have `{ name, children, ... }`.
 */
function cstNode(
	children: Record<string, unknown[]> = {},
	name = 'mock',
): Record<string, unknown> {
	return { name, children };
}

/** Build a minimal IToken-like object (has `image`, no `children`). */
function token(image: string): Record<string, unknown> {
	return { image, tokenType: { name: 'MockToken' } };
}

/** Dummy visit function that returns the node or extracts a value */
const noopVisit = (node: unknown) => node;

// ---------------------------------------------------------------------------
// visitStatement — unreachable path
// ---------------------------------------------------------------------------
describe('visitStatement', () => {
	it('throws SEM_UNREACHABLE when context has neither query nor mutationPipeline', () => {
		const ctx: CstContext = {};
		expect(() => visitStatement(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitStatement(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_UNREACHABLE,
			);
			expect((e as NqlSemanticException).message).toBe('Invalid statement');
		}
	});
});

// ---------------------------------------------------------------------------
// visitQuery — requireFirst for tableRef
// ---------------------------------------------------------------------------
describe('visitQuery', () => {
	it('throws SEM_INVALID_SYNTAX when tableRef is missing', () => {
		const ctx: CstContext = {};
		expect(() => visitQuery(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitQuery(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe('Query missing table');
		}
	});
});

// ---------------------------------------------------------------------------
// visitTableRef — requireFirst for identSegment
// ---------------------------------------------------------------------------
describe('visitTableRef', () => {
	it('throws SEM_INVALID_SYNTAX when identSegment is missing', () => {
		const ctx: CstContext = {};
		expect(() => visitTableRef(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitTableRef(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Table ref missing identifier',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitQueryClause — unreachable path
// ---------------------------------------------------------------------------
describe('visitQueryClause', () => {
	it('throws SEM_UNREACHABLE when no known clause type is present', () => {
		const ctx: CstContext = {};
		expect(() => visitQueryClause(ctx, noopVisit)).toThrow(
			NqlSemanticException,
		);
		try {
			visitQueryClause(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_UNREACHABLE,
			);
			expect((e as NqlSemanticException).message).toBe('Unknown query clause');
		}
	});
});

// ---------------------------------------------------------------------------
// visitWhereClause — requireFirst for booleanExpr
// ---------------------------------------------------------------------------
describe('visitWhereClause', () => {
	it('throws SEM_INVALID_SYNTAX when booleanExpr is missing', () => {
		const ctx: CstContext = {};
		expect(() => visitWhereClause(ctx, noopVisit)).toThrow(
			NqlSemanticException,
		);
		try {
			visitWhereClause(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Where clause missing expression',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitLimitClause — requireFirst for NumberLiteral
// ---------------------------------------------------------------------------
describe('visitLimitClause', () => {
	it('throws SEM_INVALID_SYNTAX when NumberLiteral is missing', () => {
		const ctx: CstContext = {};
		expect(() => visitLimitClause(ctx, noopVisit)).toThrow(
			NqlSemanticException,
		);
		try {
			visitLimitClause(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Limit clause missing number',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitOffsetClause — requireFirst for NumberLiteral
// ---------------------------------------------------------------------------
describe('visitOffsetClause', () => {
	it('throws SEM_INVALID_SYNTAX when NumberLiteral is missing', () => {
		const ctx: CstContext = {};
		expect(() => visitOffsetClause(ctx)).toThrow(NqlSemanticException);
		try {
			visitOffsetClause(ctx);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Offset clause missing number',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitJoinSpec — requireFirst for identSegment
// ---------------------------------------------------------------------------
describe('visitJoinSpec', () => {
	it('throws SEM_INVALID_SYNTAX when identSegment is missing', () => {
		const ctx: CstContext = {};
		expect(() => visitJoinSpec(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitJoinSpec(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Join spec missing relation',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitParam — requireFields for identSegment and literal
// ---------------------------------------------------------------------------
describe('visitParam', () => {
	it('throws SEM_INVALID_SYNTAX when identSegment is missing', () => {
		const ctx: CstContext = { literal: [cstNode() as never] };
		expect(() => visitParam(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitParam(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Param missing name or value',
			);
		}
	});

	it('throws SEM_INVALID_SYNTAX when literal is missing', () => {
		const ctx: CstContext = { identSegment: [cstNode() as never] };
		expect(() => visitParam(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitParam(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
		}
	});

	it('throws SEM_INVALID_SYNTAX when both fields are missing', () => {
		const ctx: CstContext = {};
		expect(() => visitParam(ctx, noopVisit)).toThrow(NqlSemanticException);
	});
});

// ---------------------------------------------------------------------------
// visitSelectItem — requireFirst for expression
// ---------------------------------------------------------------------------
describe('visitSelectItem', () => {
	it('throws SEM_INVALID_SYNTAX when neither Star nor relationStarExpr nor expression is present', () => {
		const ctx: CstContext = {};
		expect(() => visitSelectItem(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitSelectItem(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Select item missing expression',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitOrderItem — requireFirst for expression
// ---------------------------------------------------------------------------
describe('visitOrderItem', () => {
	it('throws SEM_INVALID_SYNTAX when expression is missing', () => {
		const ctx: CstContext = {};
		expect(() => visitOrderItem(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitOrderItem(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_INVALID_SYNTAX,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Order item missing expression',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitSetClause — unreachable paths
// ---------------------------------------------------------------------------
describe('visitSetClause', () => {
	it('throws SEM_UNREACHABLE when no set operation keyword is present', () => {
		const ctx: CstContext = {};
		expect(() => visitSetClause(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitSetClause(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_UNREACHABLE,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Set clause missing operation keyword',
			);
		}
	});

	it('throws SEM_UNREACHABLE when operation keyword present but no operand', () => {
		const ctx: CstContext = { Union: [token('UNION') as never] };
		expect(() => visitSetClause(ctx, noopVisit)).toThrow(NqlSemanticException);
		try {
			visitSetClause(ctx, noopVisit);
		} catch (e) {
			expect((e as NqlSemanticException).code).toBe(
				NqlErrorCodes.SEM_UNREACHABLE,
			);
			expect((e as NqlSemanticException).message).toBe(
				'Set clause missing operand',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// visitProgram — empty statement list
// ---------------------------------------------------------------------------
describe('visitProgram', () => {
	it('returns empty statements array when ctx.statement is undefined', () => {
		const ctx: CstContext = {};
		const result = visitProgram(ctx, noopVisit);
		expect(result.type).toBe('program');
		expect(result.statements).toEqual([]);
	});
});
