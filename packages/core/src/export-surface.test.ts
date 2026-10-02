import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type Row = { name: string; kind: string; origin?: string };
type Entry = { declarations: Row[]; runtime: string[] };
const before: {
	main: string;
	root: Entry;
	internal: Entry;
} = JSON.parse(
	readFileSync(
		new URL('./public-surface.before.json', import.meta.url),
		'utf8',
	),
);
// Frozen copies of the owner-approved name lists, including kind and origin.
function readList(file: string): Row[] {
	return readFileSync(new URL(file, import.meta.url), 'utf8')
		.trim()
		.split('\n')
		.map((line) => {
			const [name, kind, origin] = line.split('\t');
			if (!name || (kind !== 'value' && kind !== 'type') || !origin)
				throw new Error('Invalid surface list row: ' + line);
			return { name, kind, origin };
		});
}
const moved = readList('./public-surface.root-to-internal.tsv');
const removed = readList('./public-surface.root-remove.tsv');
const manifest = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const names = (rows: Row[]) => rows.map((row) => row.name);
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const excluded = new Set([...names(moved), ...names(removed)]);
const rootNames = names(before.root.declarations).filter(
	(name) => !excluded.has(name),
);
const rootRuntime = before.root.runtime.filter((name) => !excluded.has(name));
const internalNames = [...names(before.internal.declarations), ...names(moved)];
const movedRuntime = before.root.runtime.filter((name) =>
	names(moved).includes(name),
);
const internalRuntime = [...before.internal.runtime, ...movedRuntime];

// Read the built declaration target from the package exports map, never src/index.ts.
function declarations(subpath: '.' | './internal') {
	const file = fileURLToPath(
		new URL('../' + manifest.exports[subpath].types, import.meta.url),
	);
	const program = ts.createProgram([file], {
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		skipLibCheck: true,
	});
	const source = program.getSourceFile(file);
	if (!source)
		throw new Error('Build the package before running surface tests: ' + file);
	const checker = program.getTypeChecker();
	const symbol = checker.getSymbolAtLocation(source);
	if (!symbol) throw new Error('No module symbol: ' + file);
	return sorted(
		checker.getExportsOfModule(symbol).map((symbol) => symbol.name),
	);
}

describe('built package export surface (#860)', () => {
	it('root declaration exports = before minus moved minus removed', () => {
		expect(declarations('.')).toEqual(sorted(rootNames));
	});
	it('internal declaration exports follow the exact union', () => {
		expect(declarations('./internal')).toEqual(sorted(internalNames));
	});
	it('root runtime exports follow the same subtraction', async () => {
		const entry = await import('@dbsp/core');
		expect(Object.keys(entry).sort()).toEqual(sorted(rootRuntime));
	});
	it('internal runtime exports follow the same union', async () => {
		const entry = await import('@dbsp/core/internal');
		expect(Object.keys(entry).sort()).toEqual(sorted(internalRuntime));
	});
});
