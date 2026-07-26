/** Tests for the post-pack artifact guard. Run with: node --test scripts/check-packed.test.mjs */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('./check-packed.mjs', import.meta.url));
const PUBLISH_WORKFLOW = fileURLToPath(new URL('../.github/workflows/publish.yml', import.meta.url));

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
		options.archiveSetup?.(staging);
		const tarball = join(dir, 'package.tgz');
		execFileSync('tar', ['-czf', tarball, ...(options.transform ? [`--transform=${options.transform}`] : []), '-C', join(dir, 'staging'), 'package']);
		if (options.copyTarball) copyFileSync(tarball, join(dir, 'copy.tgz'));
		try {
			const pairs = options.pairs?.map(({ project, tarball: selected = 'package' }) => `${project}=${selected === 'copy' ? join(dir, 'copy.tgz') : tarball}`);
			const stdout = execFileSync('node', options.noTarballs ? [SCRIPT] : [SCRIPT, ...(pairs ?? [`${options.project ?? 'packages/cli'}=${options.tarballArgument ?? tarball}`])], {
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
	refuses(fixture, /does not match source @acme\/cli for project packages\/cli/);
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

test('refuses a non-dependency field changed while packing', () => {
	const fixture = baseline();
	fixture.projects['packages/cli'].exports = './dist/index.js';
	fixture.packed.exports = './dist/other.js';
	refuses(fixture, /does not exactly match source/);
});

test('refuses bundled files and publishable shrinkwrap files in the archive', () => {
	for (const file of ['node_modules/pg/package.json', 'npm-shrinkwrap.json']) {
		refuses(baseline(), file.includes('node_modules') ? /contains package\/node_modules/ : /contains package\/npm-shrinkwrap\.json/, {
			files: [file],
		});
	}
});

test('normalizes archive paths before refusing bundled dependencies', () => {
	refuses(baseline(), /contains package\/node_modules/, {
		files: ['node_modules/pg/package.json'],
		transform: 's#^package/#package/./#',
	});
});

test('refuses a parent-directory segment that normalizes back inside package/', () => {
	refuses(baseline(), /spelled with a parent-directory segment/, {
		files: ['side.js'],
		transform: 's#^package/side\\.js$#package/nested/../side.js#',
	});
});

test('refuses an archive path that escapes package/', () => {
	refuses(baseline(), /escapes package\//, {
		files: ['side.js'],
		transform: 's#^package/side\\.js$#/absolute/side.js#',
	});
});

test('refuses symbolic and hard links in an archive', () => {
	for (const setup of [
		(staging) => symlinkSync('package.json', join(staging, 'linked-package.json')),
		(staging) => linkSync(join(staging, 'package.json'), join(staging, 'hard-linked-package.json')),
	]) {
		refuses(baseline(), /link archive entry/, { archiveSetup: setup });
	}
});

test('binds each tarball to the project that produced it', () => {
	const fixture = baseline();
	fixture.packed.name = '@acme/core';
	fixture.packed.version = '2.0.0';
	refuses(fixture, /does not match source @acme\/cli for project packages\/cli/);
});

test('refuses a tarball supplied for more than one project', () => {
	refuses(baseline(), /appears more than once/, {
		pairs: [
			{ project: 'packages/cli' },
			{ project: 'packages/core' },
		],
	});
});

test('refuses a project supplied with more than one tarball', () => {
	refuses(baseline(), /project packages\/cli appears more than once/, {
		copyTarball: true,
		pairs: [
			{ project: 'packages/cli' },
			{ project: 'packages/cli', tarball: 'copy' },
		],
	});
});

test('refuses a tarball without package/package.json', () => {
	refuses(baseline(), /has no package\/package\.json/, { noManifest: true });
});

test('refuses a tarball that cannot be read', () => {
	refuses(baseline(), /cannot read .*missing\.tgz as a tarball/, { tarballArgument: 'missing.tgz' });
});

test('publish workflow snapshots the dependency contract around builds and packs', () => {
	const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
	const snapshot = workflow.indexOf('name: Snapshot dependency contract');
	const build = workflow.indexOf('name: Build packages');
	const pack = workflow.indexOf('name: Pack changed packages');
	const recheck = workflow.indexOf('name: Refuse dependency-contract mutations');
	const verify = workflow.indexOf('name: Verify packed packages');
	assert.ok(snapshot >= 0 && snapshot < build && build < pack && pack < recheck && recheck < verify);
	assert.match(workflow.slice(snapshot, recheck), /sha256sum -- "\$file"/);
	assert.match(workflow.slice(recheck, verify), /cmp -s "\$contract" "\$actual"/);
});

test('publish workflow hashes manifests, not the directories that contain them', () => {
	const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
	// `pnpm list` reports a project's directory, and `sha256sum` on a directory
	// is an error, so hashing `.path` ends the step at its first entry.
	assert.equal((workflow.match(/\.path \+ "\/package\.json"/g) ?? []).length, 2);
	assert.doesNotMatch(workflow, /jq -r '\.\[\] \| \.path'/);
});

test('publish workflow verifies each tarball against the project that produced it', () => {
	const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
	// check-packed keys projects the way the lockfile does; the pack loop names
	// them by directory leaf, and the two have to be reconciled somewhere.
	assert.match(workflow, /pairs\+=\("packages\/\$p=\.packed\/\$tarball"\)/);
});

test('publish workflow asks one shared probe whether a version is on npm', () => {
	const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
	// Both decisions — whether to build, and whether to pack — go through the
	// one script, so an undetermined registry answer cannot be classified two
	// ways and there is no second copy to drift.
	assert.equal((workflow.match(/scripts\/npm-published-state\.sh/g) ?? []).length, 2);
	assert.equal((workflow.match(/\[ "\$state" = published \]/g) ?? []).length, 2);
	assert.doesNotMatch(workflow, /npm view/);
	assert.doesNotMatch(workflow, /E404/);
});
