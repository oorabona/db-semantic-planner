// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for relation.ts expression handlers.
 * Focus: Branch coverage for relationStarHandler, relationColumnHandler,
 *        relationColumnsHandler, relationAliasHandler, prefixedRelationColumnHandler
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import { createCompilerState } from '../types.js';
import {
	prefixedRelationColumnHandler,
	relationAliasHandler,
	relationColumnHandler,
	relationColumnsHandler,
	relationStarHandler,
} from './relation.js';

function makeCtx(overrides = {}) {
	return {
		naming: identityNaming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
		...overrides,
	};
}

describe('relationStarHandler — coverage', () => {
	it('compiles relation.* with alias from state', () => {
		const state = createCompilerState();
		state.aliases.set('author', 'a0');
		const node = relationStarHandler.compile(
			{ type: 'relationStar', relation: 'author' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
		expect(node.ColumnRef.fields[0].String.sval).toBe('a0');
		expect(node.ColumnRef.fields[1]).toHaveProperty('A_Star');
	});

	it('falls back to relation name when no alias in state', () => {
		const state = createCompilerState();
		const node = relationStarHandler.compile(
			{ type: 'relationStar', relation: 'author' },
			makeCtx(),
			state,
		);
		expect(node.ColumnRef.fields[0].String.sval).toBe('author');
	});

	it('uses expandRelation fallback', () => {
		const state = createCompilerState();
		const node = relationStarHandler.compile(
			{ type: 'expandStar', expandRelation: 'comments' },
			makeCtx(),
			state,
		);
		expect(node.ColumnRef.fields[0].String.sval).toBe('comments');
	});

	it('throws when relation name is missing', () => {
		const state = createCompilerState();
		expect(() =>
			relationStarHandler.compile({ type: 'relationStar' }, makeCtx(), state),
		).toThrow('Relation star handler requires relation name');
	});
});

describe('relationColumnHandler — coverage', () => {
	it('compiles relation.column with alias lookup', () => {
		const state = createCompilerState();
		state.aliases.set('author', 'a0');
		const node = relationColumnHandler.compile(
			{ type: 'relationColumn', relation: 'author', column: 'name' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('compiles relation.* (wildcard) via columnRefStar', () => {
		const state = createCompilerState();
		const node = relationColumnHandler.compile(
			{ type: 'relationColumn', relation: 'author', column: '*' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
		// Should use A_Star for the wildcard part
		const fields = node.ColumnRef.fields;
		expect(fields.some((f) => 'A_Star' in f)).toBe(true);
	});

	it('falls back to relation name when no alias', () => {
		const state = createCompilerState();
		const node = relationColumnHandler.compile(
			{ type: 'relCol', relation: 'editor', column: 'email' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		expect(() =>
			relationColumnHandler.compile(
				{ type: 'relationColumn', column: 'name' },
				makeCtx(),
				state,
			),
		).toThrow('Relation column handler requires relation name');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			relationColumnHandler.compile(
				{ type: 'relationColumn', relation: 'author' },
				makeCtx(),
				state,
			),
		).toThrow('Relation column handler requires column name');
	});
});

describe('relationColumnsHandler — coverage', () => {
	it('compiles first column from columns array', () => {
		const state = createCompilerState();
		const node = relationColumnsHandler.compile(
			{
				type: 'relationColumns',
				relation: 'author',
				columns: ['name', 'email'],
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('compiles with alias → ResTarget', () => {
		const state = createCompilerState();
		const node = relationColumnsHandler.compile(
			{
				type: 'expandColumns',
				relation: 'author',
				columns: ['name'],
				alias: 'author_name',
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ResTarget');
		expect(node.ResTarget.name).toBe('author_name');
	});

	it('uses expandRelation fallback', () => {
		const state = createCompilerState();
		const node = relationColumnsHandler.compile(
			{
				type: 'relCols',
				expandRelation: 'tags',
				relationColumns: ['label'],
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		expect(() =>
			relationColumnsHandler.compile(
				{ type: 'relationColumns', columns: ['a'] },
				makeCtx(),
				state,
			),
		).toThrow('Relation columns handler requires relation name');
	});

	it('throws when columns is empty', () => {
		const state = createCompilerState();
		expect(() =>
			relationColumnsHandler.compile(
				{ type: 'relationColumns', relation: 'author', columns: [] },
				makeCtx(),
				state,
			),
		).toThrow('Relation columns handler requires columns array');
	});

	it('throws when columns is missing', () => {
		const state = createCompilerState();
		expect(() =>
			relationColumnsHandler.compile(
				{ type: 'relationColumns', relation: 'author' },
				makeCtx(),
				state,
			),
		).toThrow('Relation columns handler requires columns array');
	});
});

describe('relationAliasHandler — coverage', () => {
	it('compiles relation.column AS alias → ResTarget', () => {
		const state = createCompilerState();
		const node = relationAliasHandler.compile(
			{
				type: 'relationAlias',
				relation: 'author',
				column: 'name',
				alias: 'author_name',
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ResTarget');
		expect(node.ResTarget.name).toBe('author_name');
	});

	it('compiles without alias → bare ColumnRef', () => {
		const state = createCompilerState();
		const node = relationAliasHandler.compile(
			{ type: 'relationAlias', relation: 'author', column: 'name' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('uses expandRelation fallback', () => {
		const state = createCompilerState();
		const node = relationAliasHandler.compile(
			{
				type: 'relColAs',
				expandRelation: 'editor',
				column: 'email',
				alias: 'e',
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ResTarget');
	});

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		expect(() =>
			relationAliasHandler.compile(
				{ type: 'relationAlias', column: 'x', alias: 'y' },
				makeCtx(),
				state,
			),
		).toThrow('Relation alias handler requires relation name');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			relationAliasHandler.compile(
				{ type: 'relationAlias', relation: 'author', alias: 'y' },
				makeCtx(),
				state,
			),
		).toThrow('Relation alias handler requires column name');
	});
});

describe('prefixedRelationColumnHandler — coverage', () => {
	it('compiles relation.column with prefixed alias', () => {
		const state = createCompilerState();
		const node = prefixedRelationColumnHandler.compile(
			{
				type: 'prefixedRelationColumn',
				relation: 'author',
				column: 'name',
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ResTarget');
		expect(node.ResTarget.name).toBe('author_name');
	});

	it('uses alias from state', () => {
		const state = createCompilerState();
		state.aliases.set('author', 'a0');
		const node = prefixedRelationColumnHandler.compile(
			{
				type: 'prefixedRelCol',
				relation: 'author',
				column: 'email',
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ResTarget');
		expect(node.ResTarget.name).toBe('author_email');
	});

	it('throws when relation is missing', () => {
		const state = createCompilerState();
		expect(() =>
			prefixedRelationColumnHandler.compile(
				{ type: 'prefixedRelationColumn', column: 'x' },
				makeCtx(),
				state,
			),
		).toThrow('Prefixed relation column handler requires relation name');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			prefixedRelationColumnHandler.compile(
				{ type: 'prefixedRelationColumn', relation: 'author' },
				makeCtx(),
				state,
			),
		).toThrow('Prefixed relation column handler requires column name');
	});
});
