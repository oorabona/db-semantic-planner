import { describe, expect, it } from 'vitest';
import {
	buildPairedTree,
	type PairedTreeDir,
	type PairedTreeFile,
	type PairedTreePair,
} from './paired-tree';

// ── Helpers ──────────────────────────────────────────────────────

function file(node: unknown): PairedTreeFile {
	return node as PairedTreeFile;
}
function pair(node: unknown): PairedTreePair {
	return node as PairedTreePair;
}
function dir(node: unknown): PairedTreeDir {
	return node as PairedTreeDir;
}

// ── Tests ────────────────────────────────────────────────────────

describe('buildPairedTree', () => {
	it('returns empty array for empty input', () => {
		expect(buildPairedTree([])).toEqual([]);
	});

	it('creates file nodes for standalone .dbsp files', () => {
		const tree = buildPairedTree(['main.dbsp']);

		expect(tree).toHaveLength(1);
		expect(file(tree[0]).type).toBe('file');
		expect(file(tree[0]).name).toBe('main.dbsp');
		expect(file(tree[0]).language).toBe('dbsp');
	});

	it('creates file nodes for standalone .sql files', () => {
		const tree = buildPairedTree(['setup.sql']);

		expect(tree).toHaveLength(1);
		expect(file(tree[0]).type).toBe('file');
		expect(file(tree[0]).language).toBe('sql');
	});

	it('pairs .dbsp + .assert.dbsp with same base name', () => {
		const tree = buildPairedTree(['users.dbsp', 'users.assert.dbsp']);

		expect(tree).toHaveLength(1);
		expect(pair(tree[0]).type).toBe('pair');
		expect(pair(tree[0]).baseName).toBe('users');
		expect(pair(tree[0]).dbsp.name).toBe('users.dbsp');
		expect(pair(tree[0]).assert.name).toBe('users.assert.dbsp');
	});

	it('does NOT pair .sql with .dbsp', () => {
		const tree = buildPairedTree(['query.dbsp', 'query.sql']);

		expect(tree).toHaveLength(2);
		// Both should be standalone file nodes (no pairing)
		expect(file(tree[0]).language).toBe('dbsp');
		expect(file(tree[1]).language).toBe('sql');
	});

	it('handles unpaired .assert.dbsp (missing .dbsp)', () => {
		const tree = buildPairedTree(['orphan.assert.dbsp']);

		expect(tree).toHaveLength(1);
		expect(file(tree[0]).type).toBe('file');
		expect(file(tree[0]).language).toBe('assert');
	});

	it('groups files into directory nodes', () => {
		const tree = buildPairedTree([
			'src/users.dbsp',
			'src/users.assert.dbsp',
			'root.dbsp',
		]);

		expect(tree).toHaveLength(2); // dir + file
		expect(dir(tree[0]).type).toBe('dir');
		expect(dir(tree[0]).name).toBe('src');
		expect(dir(tree[0]).children).toHaveLength(1); // 1 pair
		expect(pair(dir(tree[0]).children[0]).type).toBe('pair');

		expect(file(tree[1]).name).toBe('root.dbsp');
	});

	it('handles deeply nested paths', () => {
		const tree = buildPairedTree(['a/b/deep.dbsp']);

		expect(dir(tree[0]).name).toBe('a');
		const b = dir(dir(tree[0]).children[0]);
		expect(b.name).toBe('b');
		expect(file(b.children[0]).name).toBe('deep.dbsp');
	});

	it('sorts directories before files, then alphabetically', () => {
		const tree = buildPairedTree(['z.dbsp', 'a-dir/x.dbsp', 'b.dbsp']);

		expect(dir(tree[0]).name).toBe('a-dir'); // dir first
		expect(file(tree[1]).name).toBe('b.dbsp'); // then alphabetical
		expect(file(tree[2]).name).toBe('z.dbsp');
	});

	it('sorts pairs before unpaired files', () => {
		const tree = buildPairedTree(['z.dbsp', 'a.dbsp', 'a.assert.dbsp']);

		// pair comes first, then unpaired dbsp
		expect(pair(tree[0]).baseName).toBe('a');
		expect(file(tree[1]).name).toBe('z.dbsp');
	});

	it('handles mixed file types in same directory', () => {
		const tree = buildPairedTree([
			'src/users.dbsp',
			'src/users.assert.dbsp',
			'src/setup.sql',
			'src/utils.dbsp',
		]);

		const srcDir = dir(tree[0]);
		expect(srcDir.children).toHaveLength(3); // 1 pair + 1 unpaired dbsp + 1 sql
		expect(pair(srcDir.children[0]).type).toBe('pair');
		expect(file(srcDir.children[1]).name).toBe('utils.dbsp');
		expect(file(srcDir.children[2]).name).toBe('setup.sql');
	});

	// ── Snapshot tests ───────────────────────────────────────────

	it('snapshot: typical project structure', () => {
		const tree = buildPairedTree([
			'src/models/users.dbsp',
			'src/models/users.assert.dbsp',
			'src/models/orders.dbsp',
			'src/queries/search.dbsp',
			'src/queries/search.assert.dbsp',
			'migrations/001.sql',
			'schema.dbsp',
		]);

		expect(tree).toMatchSnapshot();
	});

	it('snapshot: flat project with all file types', () => {
		const tree = buildPairedTree([
			'main.dbsp',
			'main.assert.dbsp',
			'setup.sql',
			'orphan.assert.dbsp',
			'standalone.dbsp',
		]);

		expect(tree).toMatchSnapshot();
	});

	it('returns single-root tree when roots has 0 or 1 entries', () => {
		const files = ['a.dbsp', 'b.sql'];
		const noRoots = buildPairedTree(files, []);
		const oneRoot = buildPairedTree(files, ['/project']);
		const plain = buildPairedTree(files);
		expect(noRoots).toEqual(plain);
		expect(oneRoot).toEqual(plain);
	});

	it('partitions files into per-root DirNodes when multiple roots (AC-2)', () => {
		const tree = buildPairedTree(
			[
				'/home/user/api/routes.dbsp',
				'/home/user/api/models.dbsp',
				'/home/user/web/pages.dbsp',
			],
			['/home/user/api', '/home/user/web'],
		);

		expect(tree).toHaveLength(2);
		expect(tree[0]!.type).toBe('dir');
		expect((tree[0] as { name: string }).name).toBe('api');
		expect(tree[1]!.type).toBe('dir');
		expect((tree[1] as { name: string }).name).toBe('web');
	});

	it('strips root prefix from files inside each root section', () => {
		const tree = buildPairedTree(
			['/root/src/a.dbsp', '/root/src/sub/b.sql'],
			['/root/src', '/root/other'],
		);

		const srcRoot = tree.find((n) => n.type === 'dir' && n.name === 'src') as {
			children: readonly { type: string; name?: string; path?: string }[];
		};
		expect(srcRoot).toBeDefined();
		// a.dbsp should be at top level of src root (no prefix path)
		const fileNode = srcRoot.children.find((c) => c.type === 'file');
		expect(fileNode).toBeDefined();
		expect(fileNode!.name).toBe('a.dbsp');
	});

	it('handles orphan files not in any root', () => {
		const tree = buildPairedTree(['/root/a.dbsp', 'orphan.sql'], ['/root']);

		// Single root → no partitioning, treated as single-root
		// (only multi-root triggers partitioning)
		expect(tree).toBeDefined();
		expect(tree.length).toBeGreaterThan(0);
	});

	it('sorts root nodes alphabetically (AC-15)', () => {
		const tree = buildPairedTree(
			['/z-root/a.dbsp', '/a-root/b.dbsp', '/m-root/c.dbsp'],
			['/z-root', '/a-root', '/m-root'],
		);

		expect(tree).toHaveLength(3);
		const names = tree.map((n) => (n as { name: string }).name);
		expect(names).toEqual(['a-root', 'm-root', 'z-root']);
	});
});
