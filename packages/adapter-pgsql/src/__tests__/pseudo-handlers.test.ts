/**
 * Pseudo-Column and Relation Expression Handler Tests
 */

import { describe, expect, it } from 'vitest';
import {
	chainedPseudoHandler,
	prefixedRelationColumnHandler,
	pseudoColumnHandler,
	relationAliasHandler,
	relationColumnHandler,
	relationStarHandler,
	singleHopPseudoHandler,
} from '../handlers/expression/index.js';
import {
	type CompilerContext,
	createCompilerState,
} from '../handlers/types.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';

describe('Pseudo-Column Handlers', () => {
	const naming = new CamelCaseNamingPlugin();
	const baseCtx: CompilerContext = {
		naming,
		rootTable: 'employees',
		maxRecursiveDepth: 100,
	};

	describe('pseudoColumnHandler', () => {
		it('should be registered for correct types', () => {
			expect(pseudoColumnHandler.types).toContain('pseudoColumn');
			expect(pseudoColumnHandler.types).toContain('pseudo');
			expect(pseudoColumnHandler.types).toContain('hierarchy');
		});

		it('should compile ascendant traversal to scalar subquery', () => {
			const state = createCompilerState();
			const decision = {
				type: 'pseudoColumn',
				traversal: 'ascendant',
				column: 'name',
				table: 'employees',
				fkColumn: 'parent_id',
				pkColumn: 'id',
			};

			const result = pseudoColumnHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			// Should produce a SubLink (scalar subquery)
			expect(result).toHaveProperty('SubLink');
			expect(result.SubLink).toHaveProperty('subLinkType', 'EXPR_SUBLINK');
			expect(result.SubLink).toHaveProperty('subselect');

			// The subselect should contain a WITH RECURSIVE
			const subselect = result.SubLink.subselect;
			expect(subselect).toHaveProperty('SelectStmt');
			expect(subselect.SelectStmt).toHaveProperty('withClause');
			expect(subselect.SelectStmt.withClause).toHaveProperty('recursive', true);
		});

		it('should compile descendant traversal to scalar subquery', () => {
			const state = createCompilerState();
			const decision = {
				type: 'pseudoColumn',
				traversal: 'descendant',
				column: 'id',
				table: 'employees',
			};

			const result = pseudoColumnHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('SubLink');
			expect(result.SubLink.subLinkType).toBe('EXPR_SUBLINK');
		});

		it('should throw without traversal', () => {
			const state = createCompilerState();
			const decision = {
				type: 'pseudoColumn',
				column: 'name',
			};

			expect(() => {
				pseudoColumnHandler.compile(decision, baseCtx, state);
			}).toThrow('requires traversal');
		});
	});

	describe('singleHopPseudoHandler', () => {
		it('should be registered for correct types', () => {
			expect(singleHopPseudoHandler.types).toContain('singleHopPseudo');
			expect(singleHopPseudoHandler.types).toContain('parentPseudo');
		});

		it('should compile parent traversal to scalar subquery', () => {
			const state = createCompilerState();
			const decision = {
				type: 'singleHopPseudo',
				traversal: 'parent',
				column: 'name',
				table: 'employees',
			};

			const result = singleHopPseudoHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('SubLink');
			expect(result.SubLink.subLinkType).toBe('EXPR_SUBLINK');

			// Should have a simple SELECT with LIMIT 1
			const subselect = result.SubLink.subselect;
			expect(subselect).toHaveProperty('SelectStmt');
			expect(subselect.SelectStmt).toHaveProperty('limitCount');
		});

		it('should compile child traversal with LIMIT 1', () => {
			const state = createCompilerState();
			const decision = {
				type: 'singleHopPseudo',
				traversal: 'child',
				column: 'name',
				table: 'employees',
			};

			const result = singleHopPseudoHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('SubLink');
			const subselect = result.SubLink.subselect;
			// limitCount should be an integer node
			expect(subselect.SelectStmt.limitCount).toBeDefined();
		});
	});

	describe('chainedPseudoHandler', () => {
		it('should be registered for correct types', () => {
			expect(chainedPseudoHandler.types).toContain('chainedPseudo');
			expect(chainedPseudoHandler.types).toContain('multiHopPseudo');
		});

		it('should throw without traversals array', () => {
			const state = createCompilerState();
			const decision = {
				type: 'chainedPseudo',
				column: 'name',
			};

			expect(() => {
				chainedPseudoHandler.compile(decision, baseCtx, state);
			}).toThrow('requires traversals array');
		});

		it('should compile chained traversals to nested subqueries', () => {
			const state = createCompilerState();
			const decision = {
				type: 'chainedPseudo',
				table: 'employees',
				traversals: [
					{ traversal: 'parent' },
					{ traversal: 'parent', targetColumn: 'name' },
				],
			};

			const result = chainedPseudoHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('SubLink');
			expect(result.SubLink.subLinkType).toBe('EXPR_SUBLINK');
		});
	});
});

describe('Relation Expression Handlers', () => {
	const naming = new CamelCaseNamingPlugin();
	const baseCtx: CompilerContext = {
		naming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
	};

	describe('relationStarHandler', () => {
		it('should be registered for correct types', () => {
			expect(relationStarHandler.types).toContain('relationStar');
			expect(relationStarHandler.types).toContain('relation.*');
		});

		it('should compile relation.* to qualified star', () => {
			const state = createCompilerState();
			state.aliases.set('author', 'author_0');

			const decision = {
				type: 'relationStar',
				relation: 'author',
			};

			const result = relationStarHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('ColumnRef');
			expect(result.ColumnRef.fields).toHaveLength(2);
			expect(result.ColumnRef.fields[0]).toHaveProperty('String', {
				sval: 'author_0',
			});
			expect(result.ColumnRef.fields[1]).toHaveProperty('A_Star');
		});

		it('should throw without relation', () => {
			const state = createCompilerState();
			const decision = { type: 'relationStar' };

			expect(() => {
				relationStarHandler.compile(decision, baseCtx, state);
			}).toThrow('requires relation name');
		});
	});

	describe('relationColumnHandler', () => {
		it('should be registered for correct types', () => {
			expect(relationColumnHandler.types).toContain('relationColumn');
			expect(relationColumnHandler.types).toContain('relation.column');
		});

		it('should compile relation.column to qualified column ref', () => {
			const state = createCompilerState();
			state.aliases.set('author', 'users_1');

			const decision = {
				type: 'relationColumn',
				relation: 'author',
				column: 'name',
			};

			const result = relationColumnHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('ColumnRef');
			const fields = result.ColumnRef.fields;
			expect(fields).toHaveLength(2);
			expect(fields[0]).toHaveProperty('String', { sval: 'users_1' });
			expect(fields[1]).toHaveProperty('String', { sval: 'name' });
		});
	});

	describe('relationAliasHandler', () => {
		it('should compile relation column with output alias', () => {
			const state = createCompilerState();
			state.aliases.set('author', 'users_0');

			const decision = {
				type: 'relationAlias',
				relation: 'author',
				column: 'name',
				alias: 'authorName',
			};

			const result = relationAliasHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('ResTarget');
			expect(result.ResTarget).toHaveProperty('name', 'author_name');
			expect(result.ResTarget).toHaveProperty('val');
			expect(result.ResTarget.val).toHaveProperty('ColumnRef');
		});
	});

	describe('prefixedRelationColumnHandler', () => {
		it('should compile with automatic prefixed alias', () => {
			const state = createCompilerState();
			state.aliases.set('category', 'categories_0');

			const decision = {
				type: 'prefixedRelationColumn',
				relation: 'category',
				column: 'name',
			};

			const result = prefixedRelationColumnHandler.compile(
				decision,
				baseCtx,
				state,
			) as any;

			expect(result).toHaveProperty('ResTarget');
			// Should have alias like category_name
			expect(result.ResTarget.name).toBe('category_name');
		});
	});
});
