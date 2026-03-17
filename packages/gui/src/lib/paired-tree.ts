/**
 * Build a paired file tree from a flat list of project files.
 *
 * Groups `.dbsp` + `.assert.dbsp` files into pair nodes.
 * `.sql` files are always standalone leaves.
 * Directories are preserved and sorted before files.
 */

// ── Types ────────────────────────────────────────────────────────

export interface PairedTreeFile {
	readonly type: 'file';
	readonly path: string;
	readonly name: string;
	readonly language: 'dbsp' | 'assert' | 'sql' | 'other';
}

export interface PairedTreePair {
	readonly type: 'pair';
	readonly baseName: string;
	readonly dbsp: PairedTreeFile;
	readonly assert: PairedTreeFile;
}

export interface PairedTreeDir {
	readonly type: 'dir';
	readonly path: string;
	readonly name: string;
	readonly children: readonly PairedTreeNode[];
}

export type PairedTreeNode = PairedTreeFile | PairedTreePair | PairedTreeDir;

// ── Helpers ──────────────────────────────────────────────────────

function classifyFile(name: string): PairedTreeFile['language'] {
	if (name.endsWith('.assert.dbsp')) return 'assert';
	if (name.endsWith('.dbsp')) return 'dbsp';
	if (name.endsWith('.sql')) return 'sql';
	return 'other';
}

/** Strip the language extension to get the base name for pairing. */
function baseName(name: string): string {
	if (name.endsWith('.assert.dbsp')) return name.slice(0, -12); // ".assert.dbsp" = 12
	if (name.endsWith('.dbsp')) return name.slice(0, -5);
	return name;
}

// ── Internal tree builder ────────────────────────────────────────

type IntermediateDir = {
	path: string;
	name: string;
	children: Map<string, IntermediateDir | PairedTreeFile>;
};

function ensureDir(
	root: Map<string, IntermediateDir | PairedTreeFile>,
	parts: string[],
): Map<string, IntermediateDir | PairedTreeFile> {
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part) continue;
		const dirPath = parts.slice(0, i + 1).join('/');
		let dir = current.get(part) as IntermediateDir | undefined;
		if (!dir || !('children' in dir)) {
			dir = { path: dirPath, name: part, children: new Map() };
			current.set(part, dir);
		}
		current = dir.children;
	}
	return current;
}

function pairAndSort(
	map: Map<string, IntermediateDir | PairedTreeFile>,
): PairedTreeNode[] {
	// Separate dirs and files
	const dirs: IntermediateDir[] = [];
	const files: PairedTreeFile[] = [];

	for (const entry of map.values()) {
		if ('children' in entry) {
			dirs.push(entry);
		} else {
			files.push(entry);
		}
	}

	// Build directory nodes (recurse)
	const dirNodes: PairedTreeDir[] = dirs
		.map((d) => ({
			type: 'dir' as const,
			path: d.path,
			name: d.name,
			children: pairAndSort(d.children),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	// Pair .dbsp + .assert.dbsp files
	const dbspMap = new Map<string, PairedTreeFile>();
	const assertMap = new Map<string, PairedTreeFile>();
	const standalone: PairedTreeFile[] = [];

	for (const file of files) {
		if (file.language === 'dbsp') {
			dbspMap.set(baseName(file.name), file);
		} else if (file.language === 'assert') {
			assertMap.set(baseName(file.name), file);
		} else {
			standalone.push(file);
		}
	}

	const pairs: PairedTreePair[] = [];
	const unpairedDbsp: PairedTreeFile[] = [];

	for (const [base, dbsp] of dbspMap) {
		const assert = assertMap.get(base);
		if (assert) {
			pairs.push({ type: 'pair', baseName: base, dbsp, assert });
			assertMap.delete(base);
		} else {
			unpairedDbsp.push(dbsp);
		}
	}

	// Any remaining .assert.dbsp without a matching .dbsp
	const unpairedAssert = [...assertMap.values()];

	// Sort each group alphabetically
	const sortByName = (a: { name: string }, b: { name: string }) =>
		a.name.localeCompare(b.name);
	const sortPairByBase = (a: PairedTreePair, b: PairedTreePair) =>
		a.baseName.localeCompare(b.baseName);

	pairs.sort(sortPairByBase);
	unpairedDbsp.sort(sortByName);
	unpairedAssert.sort(sortByName);
	standalone.sort(sortByName);

	// Final order: dirs → pairs → unpaired dbsp → unpaired assert → sql/other
	return [
		...dirNodes,
		...pairs,
		...unpairedDbsp,
		...unpairedAssert,
		...standalone,
	];
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Build a paired file tree from flat file paths.
 *
 * - Groups `foo.dbsp` + `foo.assert.dbsp` into pair nodes
 * - `.sql` files are always standalone
 * - Directories are created from path segments
 * - Sorted: directories first, then pairs, then unpaired files
 * - When multiple roots are provided, files are partitioned into per-root sections
 */
export function buildPairedTree(
	files: readonly string[],
	roots?: readonly string[],
): PairedTreeNode[] {
	// Multi-root: partition files by root and wrap each in a DirNode
	if (roots && roots.length > 1) {
		return buildMultiRootTree(files, roots);
	}
	return buildSingleRootTree(files);
}

function buildMultiRootTree(
	files: readonly string[],
	roots: readonly string[],
): PairedTreeNode[] {
	const sortedRoots = [...roots].sort((a, b) => a.localeCompare(b));
	const rootNodes: PairedTreeNode[] = [];

	for (const root of sortedRoots) {
		const rootFiles = files.filter(
			(f) => f.startsWith(`${root}/`) || f === root,
		);
		// Strip root prefix so internal tree is relative
		const stripped = rootFiles.map((f) => {
			const rel = f.slice(root.length);
			return rel.startsWith('/') ? rel.slice(1) : rel;
		});
		const rootName = root.split('/').pop() ?? root;
		rootNodes.push({
			type: 'dir',
			path: root,
			name: rootName,
			children: buildSingleRootTree(stripped),
		});
	}

	// Files not belonging to any root (orphans) — build as flat tree
	const orphans = files.filter(
		(f) => !sortedRoots.some((r) => f.startsWith(`${r}/`) || f === r),
	);
	if (orphans.length > 0) {
		rootNodes.push(...buildSingleRootTree(orphans));
	}

	return rootNodes;
}

function buildSingleRootTree(files: readonly string[]): PairedTreeNode[] {
	const root = new Map<string, IntermediateDir | PairedTreeFile>();

	for (const filePath of files) {
		const parts = filePath.split('/');
		const fileName = parts.pop();
		if (!fileName) continue;
		const dir = parts.length > 0 ? ensureDir(root, parts) : root;

		dir.set(fileName, {
			type: 'file',
			path: filePath,
			name: fileName,
			language: classifyFile(fileName),
		});
	}

	return pairAndSort(root);
}
