// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for handlers/index.ts.
 *
 * Focus: Branch coverage for the handler registry including:
 * - Registration functions (where, expression, include)
 * - Lookup functions (get/has handlers)
 * - Error paths (duplicate registration, missing handlers)
 * - normalizeToDecision (WhereIntent → Decision conversion)
 * - Registry stats and operator listing
 * - clearHandlers
 */

import { createOrm, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import {
	clearHandlers,
	ensureExpressionHandlersRegistered,
	ensureIncludeHandlersRegistered,
	getExpressionHandler,
	getIncludeHandler,
	getRegisteredOperators,
	getRegistryStats,
	hasExpressionHandler,
	hasIncludeHandler,
	registerExpressionHandler,
} from './index.js';

function ensureRegistered() {
	ensureExpressionHandlersRegistered();
	ensureIncludeHandlersRegistered();
}

const registryDb = schema({
	authors: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('authors', { as: 'author' }),
	},
	orders: { id: { type: 'integer', primaryKey: true } },
});
const registryOrm = createOrm({
	schema: registryDb,
	adapter: createPgCompileOnlyAdapter({ model: registryDb.model }),
});

/** A public read that initialises the EXPRESSION registry. */
function readOrderCount() {
	const { sql, params } = registryOrm
		.select('orders')
		.count('*', 'total')
		.dump();
	return { sql, params };
}

/** A public read that initialises the INCLUDE registry. */
function readPostsWithAuthor() {
	const { sql, params } = registryOrm.select('posts').include('author').dump();
	return { sql, params };
}

const ORDER_COUNT = {
	sql: 'SELECT count(*) AS total FROM orders',
	params: [],
};
const POSTS_WITH_AUTHOR = {
	sql: `SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM authors AS __t__ WHERE __t__.id = posts."authorId"), '[]'::json) AS author_json FROM posts`,
	params: [],
};

function restoreAllHandlerFamilies() {
	ensureRegistered();
	readOrderCount();
	readPostsWithAuthor();
	const operators = getRegisteredOperators();
	expect(operators.expression).toContain('count');
	expect(operators.include).toContain('join');
}

describe('handlers/index - Coverage Tests', () => {
	describe('registry stats after dispatcher init', () => {
		it('returns counts of registered handlers', () => {
			ensureRegistered();
			const stats = getRegistryStats();
			expect(typeof stats.expression).toBe('number');
			expect(typeof stats.include).toBe('number');
		});
	});

	describe('getRegisteredOperators', () => {
		it('returns arrays of registered operators after init', () => {
			ensureRegistered();
			const ops = getRegisteredOperators();
			expect(Array.isArray(ops.expression)).toBe(true);
			expect(Array.isArray(ops.include)).toBe(true);
		});
	});

	describe('hasExpressionHandler', () => {
		it('returns false for unregistered type', () => {
			expect(hasExpressionHandler('__nonexistent__')).toBe(false);
		});
	});

	describe('hasIncludeHandler', () => {
		it('returns false for unregistered strategy', () => {
			expect(hasIncludeHandler('__fake__' as any)).toBe(false);
		});
	});

	describe('getExpressionHandler - error path', () => {
		it('throws for unregistered type', () => {
			expect(() => getExpressionHandler('__nonexistent_type__')).toThrow(
				/No EXPRESSION handler registered for type/,
			);
		});
	});

	describe('getIncludeHandler - error path', () => {
		it('throws for unregistered strategy', () => {
			expect(() => getIncludeHandler('__fake__' as any)).toThrow(
				/No INCLUDE handler registered for strategy/,
			);
		});
	});

	describe('clearHandlers and re-init', () => {
		it('clears all handlers and stats return 0', () => {
			expect(() => clearHandlers()).not.toThrow();
			const stats = getRegistryStats();
			expect(stats.expression).toBe(0);
			expect(stats.include).toBe(0);
		});

		it('re-registers expression handlers through a public read after clearing', () => {
			clearHandlers();
			try {
				expect(readOrderCount()).toEqual(ORDER_COUNT);
				expect(getRegistryStats().expression).toBeGreaterThan(0);
				clearHandlers();
				expect(getRegistryStats().expression).toBe(0);
				expect(readOrderCount()).toEqual(ORDER_COUNT);
				expect(getRegistryStats().expression).toBeGreaterThan(0);
			} finally {
				clearHandlers();
				restoreAllHandlerFamilies();
			}
		});

		it('re-registers include handlers through a public read after clearing', () => {
			clearHandlers();
			try {
				expect(readPostsWithAuthor()).toEqual(POSTS_WITH_AUTHOR);
				expect(getRegistryStats().include).toBeGreaterThan(0);
				clearHandlers();
				expect(getRegistryStats().include).toBe(0);
				expect(readPostsWithAuthor()).toEqual(POSTS_WITH_AUTHOR);
				expect(getRegistryStats().include).toBeGreaterThan(0);
			} finally {
				clearHandlers();
				restoreAllHandlerFamilies();
			}
		});
	});

	describe('registration contract', () => {
		const compile = () => ({});

		it('refuses empty EXPRESSION key lists without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({ types: [], compile } as any),
			).toThrow(/cannot be empty/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('refuses empty EXPRESSION keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({ types: [''], compile } as any),
			).toThrow(/cannot be empty/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('refuses non-string EXPRESSION keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({ types: [1], compile } as any),
			).toThrow(/expected a string, received number/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('refuses duplicate EXPRESSION keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({
					types: ['__d__', '__d__'],
					compile,
				} as any),
			).toThrow(/duplicate __d__/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('reinitializes all handler families through compilation after clearHandlers', () => {
			clearHandlers();
			restoreAllHandlerFamilies();
		});
	});

	describe('duplicate registration errors', () => {
		it('throws on duplicate EXPRESSION type registration', () => {
			readOrderCount();
			expect(getRegisteredOperators().expression).toContain('count');
			const handler = {
				types: ['count'],
				compile: () => ({}),
			};
			expect(() => registerExpressionHandler(handler as any)).toThrow(
				new Error('EXPRESSION handler already registered for type: count'),
			);
		});
	});
});
