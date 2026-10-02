import { deparseSync } from 'pgsql-deparser';
import { expect, it } from 'vitest';
import {
	type CompilerContext,
	createCompilerState,
	createWhereDispatcher,
	type Decision,
} from '../handlers/index.js';

it('compiles rawExists with an inner WHERE when only the handler entry is imported', () => {
	const dispatch = createWhereDispatcher();
	const state = createCompilerState();
	const node = dispatch(
		{
			type: 'where',
			operator: 'rawExists',
			expressionIntent: {
				kind: 'query',
				from: 'posts',
				select: { kind: 'fields', fields: ['id'] },
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
			},
		} as Decision,
		{
			rootTable: 'users',
			dbCasing: 'preserve',
			maxRecursiveDepth: 100,
		} as CompilerContext,
		state,
	);
	expect(deparseSync(node).replace(/\s+/g, ' ')).toBe(
		'EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.published = $1)',
	);
	expect(state.parameters).toEqual([true]);
	expect(state.paramIndex).toBe(1);
});
