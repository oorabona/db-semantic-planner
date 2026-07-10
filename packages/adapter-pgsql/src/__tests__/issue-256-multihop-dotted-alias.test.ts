import { createOrm, eq, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const issue256Schema = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
	projects: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	definitions: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'definitions' }),
		project_id: ref('projects', { as: 'project', inverse: 'definitions' }),
	},
	uses: {
		id: { type: 'integer', primaryKey: true },
		def_id: ref('definitions', { as: 'definition', inverse: 'uses' }),
		file_id: ref('files', { as: 'file', inverse: 'uses' }),
	},
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		author_id: ref('authors', { as: 'author', inverse: 'posts' }),
		title: { type: 'text' },
	},
	// Self-relation: exercises alias uniqueness across repeated target tables
	// (a cyclic dotted path revisits `nodes` every hop) and the depth cap on a
	// user-controlled dotted path.
	nodes: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		parent_id: ref('nodes', {
			roles: { parent: 'parent', children: 'children' },
		}),
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({
		model: issue256Schema.model,
	});
	return createOrm({ model: issue256Schema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

describe('issue #256: multi-hop dotted WHERE relation paths', () => {
	it('binds definition.file.id to nested definition.file when direct file is also joined and filtered', () => {
		const dump = buildOrm()
			.select('uses')
			.where(eq('definition.file.id', 1))
			.include('file', { join: 'inner', where: eq('path', '/direct.ts') })
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT uses.id, file.id AS "file.id" FROM uses JOIN files AS file ON uses.file_id = file.id WHERE EXISTS (SELECT 1 FROM definitions AS definitions_exists_1 WHERE uses.def_id = definitions_exists_1.id AND EXISTS (SELECT 1 FROM files AS files_exists_2 WHERE definitions_exists_1.file_id = files_exists_2.id AND files_exists_2.id = $1)) AND file.path = $2',
		);
		expect(dump.params).toEqual([1, '/direct.ts']);
	});

	it('keeps single-hop dotted author.name SQL unchanged', () => {
		const dump = buildOrm()
			.select('posts')
			.where(eq('author.name', 'Ada'))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT posts.id FROM posts WHERE EXISTS (SELECT 1 FROM authors AS authors_exists_0 WHERE posts.author_id = authors_exists_0.id AND authors_exists_0.name = $1)',
		);
		expect(dump.params).toEqual(['Ada']);
	});

	it('lowers non-colliding multi-hop definition.project.id to nested EXISTS SQL', () => {
		const dump = buildOrm()
			.select('uses')
			.where(eq('definition.project.id', 2))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT uses.id FROM uses WHERE EXISTS (SELECT 1 FROM definitions AS definitions_exists_0 WHERE uses.def_id = definitions_exists_0.id AND EXISTS (SELECT 1 FROM projects AS projects_exists_1 WHERE definitions_exists_0.project_id = projects_exists_1.id AND projects_exists_1.id = $1))',
		);
		expect(dump.params).toEqual([2]);
	});

	it('gives each hop of a self-relation dotted path a distinct alias correlated to the previous hop', () => {
		// parent.parent.parent.name on a self-relation revisits `nodes` at every
		// hop. Each nested EXISTS must get its OWN alias (nodes_exists_0/1/2) and
		// correlate to the PREVIOUS hop — not reuse an alias and compare a hop
		// against itself.
		const dump = buildOrm()
			.select('nodes')
			.where(eq('parent.parent.parent.name', 'root'))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT nodes.id FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.parent_id = nodes_exists_0.id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_1 WHERE nodes_exists_0.parent_id = nodes_exists_1.id AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_2 WHERE nodes_exists_1.parent_id = nodes_exists_2.id AND nodes_exists_2.name = $1)))',
		);
		expect(dump.params).toEqual(['root']);
	});

	it('does not shadow an outer alias after naming-plugin normalization (snake_case)', () => {
		// Under dbCasing: 'snake_case' the model root `tExists_0` emits as
		// `t_exists_0` — the same database name the allocator would generate for the
		// inner EXISTS over `t`. The collision must be detected in the emitted
		// (database) namespace and bumped to `t_exists_1`.
		const casingSchema = schema({
			tExists_0: {
				id: { type: 'integer', primaryKey: true },
				t_id: ref('t', { as: 'rel', inverse: 'owners' }),
			},
			t: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'text' },
			},
		} as const);
		const adapter = createPgsqlCompileOnlyAdapter({
			model: casingSchema.model,
			dbCasing: 'snake_case',
		});
		const orm = createOrm({ model: casingSchema.model, adapter });

		const dump = orm
			.select('tExists_0')
			.where(eq('rel.name', 'x'))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT t_exists_0.id FROM t_exists_0 WHERE EXISTS (SELECT 1 FROM t AS t_exists_1 WHERE t_exists_0.t_id = t_exists_1.id AND t_exists_1.name = $1)',
		);
		expect(dump.params).toEqual(['x']);
	});

	it('fails closed when an intermediate hop of a dotted path is not a declared relation', () => {
		// `definition` resolves (uses -> definitions) but `typo` is not a relation on
		// definitions — the remaining `typo.name` must not compile to a dangling
		// qualified ref.
		expect(() =>
			buildOrm()
				.select('uses')
				.where(eq('definition.typo.name', 'x'))
				.columns(['id'])
				.dump(),
		).toThrow(/no relation 'typo' is declared on table 'definitions'/);
	});

	it('rejects a dotted relation path deeper than the maximum hop depth', () => {
		// 11 self-relation hops (parent.parent.…) exceeds the 10-hop cap.
		const deepPath = `${'parent.'.repeat(11)}name`;
		expect(() =>
			buildOrm()
				.select('nodes')
				.where(eq(deepPath, 'x'))
				.columns(['id'])
				.dump(),
		).toThrow(/exceeds the maximum depth of 10 hops/);
	});

	it('does not shadow an outer alias when a table is named like a generated EXISTS alias', () => {
		// Root table `t_exists_0` is named exactly like the alias the allocator
		// would generate for the inner EXISTS over `t` (t_exists_0). The allocator
		// must bump past it to `t_exists_1` rather than reusing `t_exists_0` and
		// self-correlating.
		const collisionSchema = schema({
			t_exists_0: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'text' },
				t_id: ref('t', { as: 'rel', inverse: 'owners' }),
			},
			t: {
				id: { type: 'integer', primaryKey: true },
				name: { type: 'text' },
			},
		} as const);
		const adapter = createPgsqlCompileOnlyAdapter({
			model: collisionSchema.model,
		});
		const orm = createOrm({ model: collisionSchema.model, adapter });

		const dump = orm
			.select('t_exists_0')
			.where(eq('rel.name', 'x'))
			.columns(['id'])
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT t_exists_0.id FROM t_exists_0 WHERE EXISTS (SELECT 1 FROM t AS t_exists_1 WHERE t_exists_0.t_id = t_exists_1.id AND t_exists_1.name = $1)',
		);
		expect(dump.params).toEqual(['x']);
	});
});
