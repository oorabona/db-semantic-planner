/** Tests for the post-pack artifact guard. Run with: node --test scripts/check-packed.test.mjs */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
			'packages/core': { name: '@acme/core', version: '2.0.0', publishConfig: { access: 'public' } },
			'packages/cli': {
				name: '@acme/cli',
				version: '3.0.0',
				publishConfig: { access: 'public' },
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
			publishConfig: { access: 'public' },
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

		if (options.sourceSnapshot) {
			const snapshot = join(dir, 'release-inputs');
			mkdirSync(snapshot, { recursive: true });
			writeFileSync(join(snapshot, 'package.json'), JSON.stringify(fixture.root));
			for (const [project, manifest] of Object.entries(fixture.projects)) {
				mkdirSync(join(snapshot, project), { recursive: true });
				writeFileSync(join(snapshot, project, 'package.json'), JSON.stringify(manifest));
			}
			writeFileSync(join(snapshot, 'pnpm-lock.yaml'), lockfile);
		}
		options.mutateWorktree?.(dir);

		const staging = join(dir, 'staging/package');
		mkdirSync(staging, { recursive: true });
		if (!options.noManifest) writeFileSync(join(staging, 'package.json'), JSON.stringify(fixture.packed));
		if (options.duplicateManifest) {
			mkdirSync(join(dir, 'staging/duplicate'), { recursive: true });
			writeFileSync(join(dir, 'staging/duplicate/package.json'), JSON.stringify({ ...fixture.packed, name: '@acme/other' }));
		}
		for (const file of options.files ?? []) {
			const path = join(staging, file);
			mkdirSync(join(path, '..'), { recursive: true });
			writeFileSync(path, 'fixture');
		}
		const tarball = join(dir, 'package.tgz');
		const transforms = [...(options.transform ? [options.transform] : []), ...(options.duplicateManifest ? ['s#^duplicate/#package/./#'] : [])];
		execFileSync('tar', ['-czf', tarball, ...transforms.map((transform) => `--transform=${transform}`), '-C', join(dir, 'staging'), 'package', ...(options.duplicateManifest ? ['duplicate/package.json'] : [])]);
		if (options.copyTarball) copyFileSync(tarball, join(dir, 'copy.tgz'));
		try {
			const pairs = options.pairs?.map(({ project, tarball: selected = 'package' }) => `${project}=${selected === 'copy' ? join(dir, 'copy.tgz') : tarball}`);
			const sourceArguments = options.sourceSnapshot ? ['--source-root', join(dir, 'release-inputs')] : [];
			const stdout = execFileSync('node', options.noTarballs ? [SCRIPT] : [SCRIPT, ...sourceArguments, ...(pairs ?? [`${options.project ?? 'packages/cli'}=${options.tarballArgument ?? tarball}`])], {
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

test('uses the pre-build source snapshot rather than a manifest rewritten while packing', () => {
	const mutateWorktree = (dir, fixture) => {
		fixture.packed.peerDependencies.pg = '^8.16.0';
		const source = JSON.parse(readFileSync(join(dir, 'packages/cli/package.json'), 'utf8'));
		source.peerDependencies.pg = '^8.16.0';
		writeFileSync(join(dir, 'packages/cli/package.json'), JSON.stringify(source));
	};

	const rewrittenWorktree = baseline();
	let result = run(rewrittenWorktree, { mutateWorktree: (dir) => mutateWorktree(dir, rewrittenWorktree) });
	assert.equal(result.code, 0, result.output);

	const snapshottedSource = baseline();
	result = run(snapshottedSource, { sourceSnapshot: true, mutateWorktree: (dir) => mutateWorktree(dir, snapshottedSource) });
	assert.equal(result.code, 1, result.output);
	assert.match(result.output, /packed peerDependencies\.pg is \^8\.16\.0, expected \^8\.21\.0/);
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

test('allows only the documented pnpm pack manifest drops', () => {
	const fixture = baseline();
	Object.assign(fixture.projects['packages/cli'], {
		packageManager: 'pnpm@10.33.0',
		pnpm: { onlyBuiltDependencies: [] },
		scripts: {
			build: 'node build.js', test: 'node test.js', prepublish: 'node prepublish.js', pack: 'node pack.js', prepublishOnly: 'node prepublish-only.js', prepack: 'node prepack.js', prepare: 'node prepare.js', postpack: 'node postpack.js', publish: 'node publish.js', postpublish: 'node postpublish.js',
		},
	});
	Object.assign(fixture.packed, {
		scripts: { build: 'node build.js', test: 'node test.js', prepublish: 'node prepublish.js', pack: 'node pack.js' },
	});
	const { code, output } = run(fixture);
	assert.equal(code, 0, output);
});

test('accepts the bounded compatibility envelope from a real pnpm pack', () => {
	const dir = mkdtempSync(join(tmpdir(), 'packed-real-pnpm-'));
	try {
		const manifest = {
			name: '@acme/packed-fixture',
			version: '1.0.0',
			packageManager: 'pnpm@10.33.0',
			pnpm: { onlyBuiltDependencies: [] },
			scripts: {
				build: 'node -e "process.exit(0)"',
				test: 'node -e "process.exit(0)"',
				typecheck: 'node -e "process.exit(0)"',
				prepublish: 'node -e "process.exit(0)"',
				pack: 'node -e "process.exit(0)"',
				prepublishOnly: 'node -e "process.exit(0)"',
				prepack: 'node -e "process.exit(0)"',
				prepare: 'node -e "process.exit(0)"',
				postpack: 'node -e "process.exit(0)"',
				publish: 'node -e "process.exit(0)"',
				postpublish: 'node -e "process.exit(0)"',
			},
			publishConfig: { access: 'public' },
		};
		writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
		writeFileSync(join(dir, 'pnpm-lock.yaml'), JSON.stringify({ importers: { '.': {} }, catalogs: { default: {} } }));
		const packed = join(dir, 'packed');
		mkdirSync(packed);
		execFileSync('pnpm', ['pack', '--pack-destination', packed], { cwd: dir, stdio: 'pipe' });
		const tarball = join(packed, readdirSync(packed).find((file) => file.endsWith('.tgz')) ?? 'missing.tgz');
		const output = execFileSync('node', [SCRIPT, `.= ${tarball}`.replace('= ', '=')], {
			cwd: dir,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		assert.match(output, /match their source catalog/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('requires exactly public access publishConfig on both source and packed candidates', () => {
	for (const [side, config] of [
		['source', { access: 'public', registry: 'https://registry.example.test' }],
		['source', { access: 'restricted' }],
		['source', { access: 'public', tag: 'next' }],
		['source', undefined],
		['packed', { access: 'public', registry: 'https://registry.example.test' }],
		['packed', { access: 'restricted' }],
		['packed', { access: 'public', tag: 'next' }],
		['packed', undefined],
	]) {
		const fixture = baseline();
		if (side === 'source') fixture.projects['packages/cli'].publishConfig = config;
		else fixture.packed.publishConfig = config;
		refuses(fixture, /publishConfig must be exactly \{"access":"public"\}/);
	}
});

test('refuses every present source or packed dependency block that is not a map', () => {
	for (const side of ['source', 'packed']) {
		for (const block of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
			for (const value of [null, true, 5, 'pg', ['pg']]) {
				const fixture = baseline();
				if (side === 'source') fixture.projects['packages/cli'][block] = value;
				else fixture.packed[block] = value;
				refuses(fixture, new RegExp(`${side === 'source' ? 'source manifest' : 'packed manifest'} ${block} is not a dependency map`));
			}
		}
	}
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

test('refuses an archive entry outside package/', () => {
	refuses(baseline(), /is outside package\//, {
		files: ['side.js'],
		transform: 's#^package/side\\.js$#/absolute/side.js#',
	});
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

test('refuses differently spelled package manifests that collide after path normalisation', () => {
	refuses(baseline(), /ambiguous package\/package\.json entries after path normalisation/, { duplicateManifest: true });
});

test('refuses a tarball that cannot be read', () => {
	refuses(baseline(), /cannot read .*missing\.tgz as a tarball/, { tarballArgument: 'missing.tgz' });
});

test('publish workflow verifies every tarball before the first registry PUT', () => {
	const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
	// Packing one package at a time put @dbsp/types on npm — immutably — before
	// @dbsp/cli had even been packed.
	const pack = workflow.indexOf('name: Pack changed packages');
	const verify = workflow.indexOf('name: Verify packed packages');
	const publish = workflow.indexOf('name: Publish verified packages');
	assert.ok(pack >= 0 && pack < verify && verify < publish);
	assert.doesNotMatch(workflow.slice(pack, verify), /npm publish/);
});

test('publish workflow verifies each tarball against the project that produced it', () => {
	const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
	// check-packed keys projects the way the lockfile does; the pack loop names
	// them by directory leaf, and the two have to be reconciled somewhere.
	assert.match(workflow, /pairs\+=\("packages\/\$p=\.packed\/\$tarball"\)/);
});

test('publish workflow snapshots release inputs before builds and verifies against that authority', () => {
	const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
	const catalog = workflow.indexOf('node scripts/check-catalog.mjs');
	const snapshot = workflow.indexOf('name: Snapshot release inputs');
	const build = workflow.indexOf('name: Build packages');
	assert.ok(catalog >= 0 && catalog < snapshot && snapshot < build);
	assert.match(workflow, /--source-root "\$RUNNER_TEMP\/release-inputs"/);
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
