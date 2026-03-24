/**
 * Error-path tests for relation.ts expression handlers.
 *
 * Covers: relationStarHandler, relationColumnHandler, relationColumnsHandler,
 *         relationAliasHandler, prefixedRelationColumnHandler
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	prefixedRelationColumnHandler,
	relationAliasHandler,
	relationColumnHandler,
	relationColumnsHandler,
	relationStarHandler,
} from './relation.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// relationStarHandler errors
// ============================================================================

describe('relationStarHandler errors', () => {
	const ctx = makeCtx();

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'relationStar' } as CompilerDecision;
		expect(() => relationStarHandler.compile(decision, ctx, state)).toThrow(
			'Relation star handler requires relation name',
		);
	});
});

// ============================================================================
// relationColumnHandler errors
// ============================================================================

describe('relationColumnHandler errors', () => {
	const ctx = makeCtx();

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'relationColumn', column: 'name' } as CompilerDecision;
		expect(() => relationColumnHandler.compile(decision, ctx, state)).toThrow(
			'Relation column handler requires relation name',
		);
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'relationColumn',
			relation: 'posts',
		} as CompilerDecision;
		expect(() => relationColumnHandler.compile(decision, ctx, state)).toThrow(
			'Relation column handler requires column name',
		);
	});
});

// ============================================================================
// relationColumnsHandler errors
// ============================================================================

describe('relationColumnsHandler errors', () => {
	const ctx = makeCtx();

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'relationColumns',
			columns: ['id', 'name'],
		} as CompilerDecision;
		expect(() => relationColumnsHandler.compile(decision, ctx, state)).toThrow(
			'Relation columns handler requires relation name',
		);
	});

	it('throws when columns is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'relationColumns',
			relation: 'posts',
		} as CompilerDecision;
		expect(() => relationColumnsHandler.compile(decision, ctx, state)).toThrow(
			'Relation columns handler requires columns array',
		);
	});

	it('throws when columns is an empty array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'relationColumns',
			relation: 'posts',
			columns: [],
		} as unknown as CompilerDecision;
		expect(() => relationColumnsHandler.compile(decision, ctx, state)).toThrow(
			'Relation columns handler requires columns array',
		);
	});
});

// ============================================================================
// relationAliasHandler errors
// ============================================================================

describe('relationAliasHandler errors', () => {
	const ctx = makeCtx();

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'relationAlias',
			column: 'name',
			alias: 'author_name',
		} as CompilerDecision;
		expect(() => relationAliasHandler.compile(decision, ctx, state)).toThrow(
			'Relation alias handler requires relation name',
		);
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'relationAlias',
			relation: 'posts',
			alias: 'post_title',
		} as CompilerDecision;
		expect(() => relationAliasHandler.compile(decision, ctx, state)).toThrow(
			'Relation alias handler requires column name',
		);
	});
});

// ============================================================================
// prefixedRelationColumnHandler errors
// ============================================================================

describe('prefixedRelationColumnHandler errors', () => {
	const ctx = makeCtx();

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'prefixedRelationColumn',
			column: 'title',
		} as CompilerDecision;
		expect(() =>
			prefixedRelationColumnHandler.compile(decision, ctx, state),
		).toThrow('Prefixed relation column handler requires relation name');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'prefixedRelationColumn',
			relation: 'posts',
		} as CompilerDecision;
		expect(() =>
			prefixedRelationColumnHandler.compile(decision, ctx, state),
		).toThrow('Prefixed relation column handler requires column name');
	});
});
