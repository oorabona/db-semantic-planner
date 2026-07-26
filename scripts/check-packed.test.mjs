/** Tests for the post-pack artifact guard. Run with: node --test scripts/check-packed.test.mjs */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('./check-packed.mjs', import.meta.url));

function baseline() {
	return {
		root: { name: 'root', version: '1.0.0', private: true },
		projects: {
			'packages/core': { name: '@acme/core', version: '2.0.0' },
			'packages/cli': {
				name: '@acme/cli',
				version: '3.0.0',
				dependencies: { '@acme/core': 'workspace:*' },
				devDependencies: { pg: 'catalog:' },
				peerDependencies: { pg: 'catalog:' },
				optionalDependencies: { '@acme/core': 'workspace:^' },
			},
		},
		lock: {
			'.': {},
			'packages/core': {},
			'packages/cli': {},
		},
		catalogs: { default: { pg: { specifier: '^8.21.0', version: '8.22.0' } } },
		packed: {
			name: '@acme/cli',
			version: '3.0.0',
			dependencies: { '@acme/core': '2.0.0' },
			devDependencies: { pg: '^8.21.0' },
			peerDependencies: { pg: '^8.21.0' },
			optionalDependencies: { '@acme/core': '^2.0.0' },
		},
	};
}

function run(fixture, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'packed-check-'));
	try {
		writeFileSync(join(dir, 'package.json'), JSON.stringify(fixture.root));
		for (const [project, manifest] of Object.entries(fixture.projects)) {
			mkdirSync(join(dir, project), { recursive: true });
			writeFileSync(join(dir, project, 'package.json'), JSON.stringify(manifest));
		}
		const lockfile = JSON.stringify({ catalogs: fixture.catalogs, importers: fixture.lock });
		writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile);
		mkdirSync(join(dir, 'node_modules/.pnpm'), { recursive: true });
		writeFileSync(join(dir, 'node_modules/.pnpm/lock.yaml'), lockfile);

		const staging = join(dir, 'staging/package');
		mkdirSync(staging, { recursive: true });
		if (!options.noManifest) writeFileSync(join(staging, 'package.json'), JSON.stringify(fixture.packed));
		for (const file of options.files ?? []) {
			const path = join(staging, file);
			mkdirSync(join(path, '..'), { recursive: true });
			writeFileSync(path, 'fixture');
		}
		const tarball = join(dir, 'package.tgz');
		execFileSync('tar', ['-czf', tarball, '-C', join(dir, 'staging'), 'package']);
		try {
			const stdout = execFileSync('node', options.noTarballs ? [SCRIPT] : [SCRIPT, options.tarballArgument ?? tarball], {
				cwd: dir,
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			return { code: 0, output: stdout };
		} catch (error) {
			return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function refuses(fixture, expected, options) {
	const { code, output } = run(fixture, options);
	assert.equal(code, 1, `expected the guard to refuse, got exit ${code}:\n${output}`);
	assert.match(output, expected);
}

test('accepts a tarball whose substitutions match the source contracts', () => {
	const { code, output } = run(baseline());
	assert.equal(code, 0, output);
	assert.match(output, /match their source catalog/);
});

test('refuses zero tarballs', () => {
	refuses(baseline(), /no tarballs supplied/, { noTarballs: true });
});

test('refuses a catalog declaration rewritten to a different packed range', () => {
	const fixture = baseline();
	fixture.packed.peerDependencies.pg = '^8.16.0';
	refuses(fixture, /packed peerDependencies\.pg is \^8\.16\.0, expected \^8\.21\.0/);
});

test('refuses incorrect workspace substitutions for both workspace forms', () => {
	for (const [block, expected] of [
		['dependencies', '2.0.0'],
		['optionalDependencies', '^2.0.0'],
	]) {
		const fixture = baseline();
		fixture.packed[block]['@acme/core'] = '9.9.9';
		refuses(fixture, new RegExp(`packed ${block}\\.@acme/core is 9\\.9\\.9, expected ${expected.replace('^', '\\^').replaceAll('.', '\\.')}`));
	}
});

test('refuses leaked catalog and workspace protocols in any packed dependency block', () => {
	for (const [block, range] of [
		['devDependencies', 'catalog:'],
		['dependencies', 'workspace:*'],
	]) {
		const fixture = baseline();
		fixture.packed[block].leaked = range;
		refuses(fixture, /leaks an unresolved protocol/);
	}
});

test('refuses a dependency added by packing', () => {
	const fixture = baseline();
	fixture.packed.dependencies.pg = '^8.16.0';
	refuses(fixture, /packed dependencies adds pg, which source @acme\/cli does not declare/);
});

test('refuses a dependency dropped by packing', () => {
	const fixture = baseline();
	delete fixture.packed.peerDependencies.pg;
	refuses(fixture, /packed peerDependencies drops pg, which source @acme\/cli declares/);
});

test('refuses a packed name not present in the source workspace', () => {
	const fixture = baseline();
	fixture.packed.name = '@acme/not-cli';
	refuses(fixture, /does not match any source workspace package/);
});

test('refuses a packed version that differs from its source manifest', () => {
	const fixture = baseline();
	fixture.packed.version = '3.0.1';
	refuses(fixture, /packed version 3\.0\.1 does not match source 3\.0\.0/);
});

test('refuses either bundled-dependency field in the packed manifest', () => {
	for (const field of ['bundleDependencies', 'bundledDependencies']) {
		const fixture = baseline();
		fixture.packed[field] = true;
		refuses(fixture, new RegExp(`packed manifest has ${field}`));
	}
});

test('refuses bundled files and publishable shrinkwrap files in the archive', () => {
	for (const file of ['node_modules/pg/package.json', 'npm-shrinkwrap.json']) {
		refuses(baseline(), file.includes('node_modules') ? /contains package\/node_modules/ : /contains package\/npm-shrinkwrap\.json/, {
			files: [file],
		});
	}
});

test('refuses a tarball without package/package.json', () => {
	refuses(baseline(), /has no package\/package\.json/, { noManifest: true });
});

test('refuses a tarball that cannot be read', () => {
	refuses(baseline(), /cannot read .*missing\.tgz as a tarball/, { tarballArgument: 'missing.tgz' });
});
