/**
 * Tests for the catalog guard.
 * Run with: node --test scripts/check-catalog.test.mjs
 *
 * Every case here is a way the workspace could end up loading two versions of
 * one package. The guard's whole value is refusing them, so each one is a test
 * that must FAIL the guard — a green suite over the happy path alone would say
 * nothing about what this protects.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('./check-catalog.mjs', import.meta.url));

/** A workspace that passes, as the baseline every case below perturbs. */
function baseline() {
	return {
		workspace: {
			packages: ['packages/*'],
			catalog: { pg: '^8.21.0' },
		},
		root: { name: 'root', private: true, devDependencies: { pg: 'catalog:' } },
		projects: {
			'packages/core': { name: '@acme/core', dependencies: { pg: 'catalog:' } },
			'packages/cli': {
				name: '@acme/cli',
				dependencies: { '@acme/core': 'workspace:*' },
				peerDependencies: { pg: 'catalog:' },
			},
		},
		// What pnpm records for the catalog itself; every `catalog:` declaration
		// is held to this exact version.
		catalogs: { default: { pg: { specifier: '^8.21.0', version: '8.22.0' } } },
		lock: {
			'.': { devDependencies: { pg: { specifier: 'catalog:', version: '8.22.0' } } },
			'packages/core': { dependencies: { pg: { specifier: 'catalog:', version: '8.22.0' } } },
			'packages/cli': {
				dependencies: {
					'@acme/core': { specifier: 'workspace:*', version: 'link:../core' },
					pg: { specifier: 'catalog:', version: '8.22.0' },
				},
			},
		},
	};
}

/** Materialise a fixture workspace and run the guard over it. */
function run(fixture) {
	const dir = mkdtempSync(join(tmpdir(), 'catalog-check-'));
	try {
		writeFileSync(join(dir, 'pnpm-workspace.yaml'), JSON.stringify(fixture.workspace));
		writeFileSync(join(dir, 'package.json'), JSON.stringify(fixture.root));
		const lockfile = JSON.stringify({
			overrides: fixture.overrides ?? {},
			catalogs: fixture.catalogs ?? {},
			importers: fixture.lock,
		});
		writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile);
		// The guard refuses a lockfile that is not the one pnpm installed from, so
		// a fixture has to look installed. `fixture.installed` lets a case make
		// them differ on purpose.
		mkdirSync(join(dir, 'node_modules/.pnpm'), { recursive: true });
		writeFileSync(join(dir, 'node_modules/.pnpm/lock.yaml'), fixture.installed ?? lockfile);
		for (const [project, manifest] of Object.entries(fixture.projects)) {
			mkdirSync(join(dir, project), { recursive: true });
			writeFileSync(join(dir, project, 'package.json'), JSON.stringify(manifest));
		}
		// Anything a fixture can only express against the materialised tree —
		// a symlink, chiefly, which is the shape `resolve` alone does not see.
		fixture.after?.(dir);
		try {
			const stdout = execFileSync('node', [SCRIPT, dir], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
			return { code: 0, output: stdout };
		} catch (error) {
			return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Assert the guard refused, and that it said why. */
function refuses(fixture, expected) {
	const { code, output } = run(fixture);
	assert.equal(code, 1, `expected the guard to refuse, got exit ${code}:\n${output}`);
	assert.match(output, expected);
}

test('accepts a workspace where every range comes from the catalog', () => {
	const { code, output } = run(baseline());
	assert.equal(code, 0, output);
	assert.match(output, /one version each/);
});

test('refuses a literal range in peerDependencies — the #387 defect itself', () => {
	const fixture = baseline();
	fixture.projects['packages/cli'].peerDependencies.pg = '^8.16.0';
	refuses(fixture, /peerDependencies\.pg: \^8\.16\.0/);
});

test('refuses a peer range shadowed by a dependency of the same name', () => {
	// The lockfile importer keeps only one entry per name, so this declaration
	// never reaches it — a lockfile-only check certifies it.
	const fixture = baseline();
	fixture.projects['packages/cli'].peerDependencies.pg = '^8.16.0';
	fixture.projects['packages/cli'].dependencies.pg = 'catalog:';
	fixture.lock['packages/cli'].dependencies.pg = { specifier: 'catalog:', version: '8.22.0' };
	refuses(fixture, /peerDependencies\.pg: \^8\.16\.0/);
});

test('refuses a named catalog reference', () => {
	const fixture = baseline();
	fixture.projects['packages/core'].dependencies.pg = 'catalog:legacy';
	refuses(fixture, /catalog:legacy/);
});

test('refuses a named catalogs block outright', () => {
	const fixture = baseline();
	fixture.workspace.catalogs = { legacy: { pg: '^8.16.0' } };
	refuses(fixture, /named catalogs/);
});

test('refuses a workspace package referenced through the catalog', () => {
	const fixture = baseline();
	fixture.projects['packages/cli'].dependencies['@acme/core'] = 'catalog:';
	refuses(fixture, /expected workspace:\* or workspace:\^/);
});

test('refuses a workspace protocol form outside the two this repo publishes', () => {
	const fixture = baseline();
	fixture.projects['packages/cli'].dependencies['@acme/core'] = 'workspace:~';
	refuses(fixture, /workspace:~/);
});

test('catches an alias by what it resolved to, not by how it was spelled', () => {
	// `pg-old: npm:pg@8.20.0` in the catalog puts pg under a second key. pnpm
	// records the real package in the resolution — `version: "pg@8.20.0"` — so
	// keying identity there turns two keys into two versions of one package.
	// Nothing here knows what `npm:` means, which is why `jsr:`, a git shorthand
	// and whatever pnpm supports next are covered too.
	const fixture = baseline();
	fixture.workspace.catalog['pg-old'] = 'npm:pg@8.20.0';
	fixture.catalogs.default['pg-old'] = { specifier: 'npm:pg@8.20.0', version: '8.20.0' };
	fixture.projects['packages/cli'].dependencies['pg-old'] = 'catalog:';
	fixture.lock['packages/cli'].dependencies['pg-old'] = { specifier: 'catalog:', version: 'pg@8.20.0' };
	refuses(fixture, /more than one version/);
});

test('refuses a catalog declaration that resolved to something other than the catalog', () => {
	// An override, a patch or a pnpmfile can re-decide a version after the
	// catalog has. The mechanism does not matter; the divergence does.
	const fixture = baseline();
	fixture.lock['packages/core'].dependencies.pg.version = '8.20.0';
	refuses(fixture, /catalog resolved to 8\.22\.0/);
});

test('accepts an override on a transitive package the catalog does not name', () => {
	// Security pins on transitive dependencies are what overrides are for, and
	// parent-scoped selectors like `vite>esbuild` are the ordinary spelling.
	const fixture = baseline();
	fixture.overrides = { 'lodash@>=4.0.0 <4.17.23': '>=4.17.23', 'vite>esbuild': '^0.25.12' };
	const { code, output } = run(fixture);
	assert.equal(code, 0, output);
});

test('accepts catalog: as an override value — pnpm’s own way to force one range', () => {
	// This is how a package used directly and transitively is pinned to the
	// catalog without naming the range twice. Refusing it would push the second
	// copy of the range back into existence.
	const fixture = baseline();
	fixture.overrides = { pg: 'catalog:' };
	const { code, output } = run(fixture);
	assert.equal(code, 0, output);
});

test('refuses a lockfile that is not the one pnpm installed from', () => {
	// `lockfile: false`, `gitBranchLockfile: true` and a stale checkout all end
	// here, without the guard needing to know which of them happened.
	const fixture = baseline();
	fixture.installed = JSON.stringify({ importers: {} });
	refuses(fixture, /not the lockfile pnpm installed from/);
});

test('refuses a pnpmfile, which can rewrite the manifest after every check', () => {
	const fixture = baseline();
	fixture.after = (dir) => writeFileSync(join(dir, '.pnpmfile.cjs'), 'module.exports = {}');
	refuses(fixture, /pnpmfile\.cjs exists/);
});

test('refuses an importer whose directory is a symlink out of the repository', () => {
	// `resolve` strips `..` but follows nothing: the lexical path stays under
	// the root while the read lands anywhere.
	const fixture = baseline();
	fixture.lock['packages/escape'] = { dependencies: {} };
	fixture.after = (dir) => symlinkSync(tmpdir(), join(dir, 'packages/escape'), 'dir');
	refuses(fixture, /resolves outside the repository/);
});

test('refuses an importer whose manifest file is a symlink out of the repository', () => {
	const fixture = baseline();
	// Outside the fixture root on purpose — that is the whole point — so it is
	// this test's job to remove it. `run()` only cleans the workspace it made.
	const foreign = mkdtempSync(join(tmpdir(), 'catalog-foreign-'));
	try {
		writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'foreign' }));
		fixture.lock['packages/sneak'] = { dependencies: {} };
		fixture.after = (dir) => {
			mkdirSync(join(dir, 'packages/sneak'), { recursive: true });
			symlinkSync(join(foreign, 'package.json'), join(dir, 'packages/sneak/package.json'));
		};
		refuses(fixture, /resolves outside the repository/);
	} finally {
		rmSync(foreign, { recursive: true, force: true });
	}
});

test('refuses a project whose effective manifest is package.json5', () => {
	// pnpm's MANIFEST_BASE_NAMES is [package.json, package.json5, package.yaml].
	// With no package.json the json5 is what pnpm reads, so certifying the yaml
	// would certify a manifest that governs nothing.
	const fixture = baseline();
	fixture.lock['packages/five'] = { dependencies: {} };
	fixture.after = (dir) => {
		mkdirSync(join(dir, 'packages/five'), { recursive: true });
		writeFileSync(join(dir, 'packages/five/package.json5'), '{ name: "@acme/five" }');
		writeFileSync(join(dir, 'packages/five/package.yaml'), 'name: "@acme/five"\n');
	};
	refuses(fixture, /package\.json5/);
});

test('accepts a package.json5 that pnpm would not read, beside a package.json', () => {
	// package.json outranks it, so it is an inert file on disk. Refusing it
	// would block a project pnpm handles perfectly well.
	const fixture = baseline();
	fixture.after = (dir) => writeFileSync(join(dir, 'packages/core/package.json5'), '{ name: "stale" }');
	const { code, output } = run(fixture);
	assert.equal(code, 0, output);
});

// Two projects on plainly different versions of one `catalog:` dependency is
// covered above, by the catalog-resolution rule, which names the divergence more
// precisely than the duplicate count can. What only the duplicate rule can catch
// is a package reached under two different keys — the alias case at the top of
// this file — because there the versions are consistent with their own catalog
// entries and it is the identity that collides.

test('refuses an empty importer map rather than certifying nothing', () => {
	const fixture = baseline();
	fixture.lock = {};
	refuses(fixture, /no workspace projects/);
});

test('refuses an importers section that is not a map', () => {
	const fixture = baseline();
	fixture.lock = [];
	refuses(fixture, /no usable `importers` map/);
});

test('refuses an importer key that escapes the repository', () => {
	const fixture = baseline();
	fixture.lock['../../elsewhere'] = { dependencies: {} };
	refuses(fixture, /resolves outside the repository/);
});

test('refuses a lockfile entry with no resolved version', () => {
	const fixture = baseline();
	fixture.lock['packages/core'].dependencies.pg = { specifier: 'catalog:' };
	refuses(fixture, /has no resolved version/);
});

test('refuses a project whose manifest it cannot read', () => {
	const fixture = baseline();
	fixture.lock['packages/ghost'] = { dependencies: {} };
	refuses(fixture, /has none of package\.json, package\.json5, package\.yaml/);
});
