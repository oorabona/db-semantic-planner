const { readFileSync, readdirSync } = require('node:fs');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (paths) => paths.map((path) => `^${escapeRegExp(path)}$`);

// Frozen cross-package test imports; remove entries as #450 is resolved.
const exceptions = {
	'adapter-pgsql-not-nql': [
		'packages/adapter-pgsql/src/__tests__/bigint-js-column-metadata.test.ts', // see #450
		'packages/adapter-pgsql/src/__tests__/bigint-js-conversion.test.ts', // see #450
		'packages/adapter-pgsql/src/__tests__/issue-763-relation-column-alias.test.ts', // see #450
		'packages/adapter-pgsql/src/__tests__/nql-bind-cte-injection.test.ts', // see #450
		'packages/adapter-pgsql/src/__tests__/nql-to-sql.test.ts', // see #450
		'packages/adapter-pgsql/src/__tests__/set-operation.test.ts', // see #450
		'packages/adapter-pgsql/src/batch/any-operator.test.ts', // see #450
	],
	'core-not-adapter': [
		'packages/core/src/dx/__tests__/api-hardening.test.ts', // see #450
		'packages/core/src/dx/__tests__/dump-meta.test.ts', // see #450
		'packages/core/src/dx/__tests__/hasMany-disambiguation.test.ts', // see #450
		'packages/core/src/dx/__tests__/nql-bindings.test.ts', // see #450
		'packages/core/src/dx/__tests__/nql-mutation-rejection.test.ts', // see #450
		'packages/core/src/dx/__tests__/range-sql.test.ts', // see #450
		'packages/core/src/dx/__tests__/typed-orm.test.ts', // see #450
		'packages/core/src/dx/__tests__/union.test.ts', // see #450
		'packages/core/src/dx/exists.test.ts', // see #450
		'packages/core/src/dx/nql-params.test.ts', // see #450
		'packages/core/src/dx/nql.coverage.test.ts', // see #450
		'packages/core/src/dx/predicate-ref.test.ts', // see #450
		'packages/core/src/dx/typed-query-builder.test.ts', // see #450
	],
	'nql-not-adapter': [
		'packages/nql/tests/nql-with.test.ts', // see #450
	],
};

const packages = readdirSync('packages', { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => {
		const path = `packages/${entry.name}`;
		const manifest = JSON.parse(readFileSync(`${path}/package.json`, 'utf8'));
		if (!manifest.name?.startsWith('@dbsp/'))
			throw new Error(`Expected workspace package: ${path}`);
		return { path, manifest, name: manifest.name.slice(6) };
	});

const allowed = {
	types: [],
	nql: ['types'],
	core: ['types', 'nql'],
	'adapter-pgsql': ['types', 'core'],
};
const forbidden = [];
for (const source of packages) {
	for (const target of packages) {
		if (source.name === target.name) continue;
		const edge = `${source.name}-not-${target.name === 'adapter-pgsql' ? 'adapter' : target.name}`;
		if (
			(Object.hasOwn(allowed, source.name) &&
				!allowed[source.name].includes(target.name)) ||
			(source.name === 'mcp-server' && target.name === 'adapter-pgsql')
		) {
			const name = edge;
			forbidden.push({
				name,
				severity: 'error',
				comment: `${source.manifest.name} must not import ${target.manifest.name} (ARCH-001).`,
				from: {
					path: `^${escapeRegExp(source.path)}/`,
					pathNot: exact(exceptions[name] ?? []),
				},
				to: {
					path: `^(?:${escapeRegExp(target.path)}/|${escapeRegExp(target.manifest.name)}(?:/|$))`,
				},
			});
		}
		// Source aliases are local dependencies to dependency-cruiser, so its
		// npm-no-pkg classifier alone cannot enforce the importing manifest.
		const declared = [
			'dependencies',
			'devDependencies',
			'peerDependencies',
			'optionalDependencies',
		].some((block) =>
			Object.hasOwn(source.manifest[block] ?? {}, target.manifest.name),
		);
		if (!declared)
			forbidden.push({
				name: `${source.name}-no-non-package-json-${target.name}`,
				severity: 'error',
				comment: `${source.manifest.name} does not declare ${target.manifest.name}.`,
				from: {
					path: `^${escapeRegExp(source.path)}/`,
					pathNot: exact(exceptions[edge] ?? []),
				},
				to: {
					path: `^(?:${escapeRegExp(target.path)}/|${escapeRegExp(target.manifest.name)}(?:/|$))`,
				},
			});
	}
}
forbidden.push(
	{
		name: 'workspace-no-non-package-json',
		severity: 'error',
		from: { path: '^packages/' },
		to: {
			path: '(^@dbsp/|(^|/)node_modules/@dbsp/)',
			dependencyTypes: ['unknown', 'undetermined', 'npm-no-pkg', 'npm-unknown'],
		},
	},
	{
		name: 'workspace-not-unresolvable',
		severity: 'error',
		from: { path: '^packages/' },
		to: { path: '^@dbsp/', couldNotResolve: true },
	},
);

module.exports = {
	forbidden,
	options: {
		tsConfig: { fileName: 'tsconfig.arch.json' },
		tsPreCompilationDeps: true,
		combinedDependencies: false,
		doNotFollow: { path: 'node_modules' },
		exclude: {
			path: '(^|/)node_modules/|^packages/[^/]+/(dist|dist-types)/|^packages/gui/src-tauri/target/',
		},
	},
};
