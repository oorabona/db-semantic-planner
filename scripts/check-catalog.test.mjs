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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
		writeFileSync(join(dir, 'pnpm-lock.yaml'), JSON.stringify({ importers: fixture.lock }));
		for (const [project, manifest] of Object.entries(fixture.projects)) {
			mkdirSync(join(dir, project), { recursive: true });
			writeFileSync(join(dir, project, 'package.json'), JSON.stringify(manifest));
		}
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

test('refuses an alias in the catalog', () => {
	const fixture = baseline();
	fixture.workspace.catalog['pg-old'] = 'npm:pg@8.20.0';
	refuses(fixture, /catalog entry pg-old.*is an alias/);
});

test('refuses an alias in pnpm.overrides — the other substitution channel', () => {
	const fixture = baseline();
	fixture.root.pnpm = { overrides: { 'pg-old': 'npm:pg@8.20.0' } };
	refuses(fixture, /override pg-old.*is an alias/);
});

test('refuses two projects resolving one dependency to different versions', () => {
	const fixture = baseline();
	fixture.lock['packages/core'].dependencies.pg.version = '8.20.0';
	refuses(fixture, /more than one version/);
});

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
	refuses(fixture, /neither package.json nor package.yaml/);
});
