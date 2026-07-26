#!/usr/bin/env node
/**
 * Verifies the package.json and file list in the tarballs that will be
 * published. check-catalog verifies source declarations and the installed
 * graph; lifecycle hooks can still rewrite a manifest while packing, so this
 * deliberately reads the finished artifact instead.
 */
import { execFileSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertDependencyBlocks, createManifestReader, DEPENDENCY_BLOCKS, readLockfile } from './check-guard-shared.mjs';

let sourceRoot = process.cwd();
const TARBALL_PAIRS = [];
for (let index = 2; index < process.argv.length; index += 1) {
	if (process.argv[index] === '--source-root') {
		if (index + 1 === process.argv.length) {
			console.error('packed check: --source-root requires a directory');
			process.exit(1);
		}
		sourceRoot = process.argv[index + 1];
		index += 1;
	} else {
		TARBALL_PAIRS.push(process.argv[index]);
	}
}
const ROOT = resolve(sourceRoot);

/** pnpm 10.33.0 drops exactly these package lifecycle scripts during pack. */
const PACK_DROPPED_SCRIPT_KEYS = ['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish'];

function fail(message) {
	console.error(`packed check: ${message}`);
	process.exit(1);
}

const { readManifest } = createManifestReader(ROOT, fail);

function archiveEntries(tarball) {
	let rawEntries;
	try {
		rawEntries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
			.split(/\r?\n/)
			.filter(Boolean);
	} catch (error) {
		fail(`cannot read ${tarball} as a tarball: ${error.message}`);
	}

	// Normalised so the bundled-copy tests below are exact comparisons against one
	// spelling rather than against however tar happened to write the entry.
	const entries = [];
	for (const raw of rawEntries) {
		const path = posix.normalize(raw).replace(/\/+$/, '');
		if (path !== 'package' && !path.startsWith('package/')) {
			fail(`${tarball} contains archive path ${raw}, which is outside package/`);
		}
		entries.push({ path, raw });
	}
	return entries;
}

function packedManifest(tarball, entries) {
	const manifestEntries = entries.filter(({ path }) => path === 'package/package.json');
	if (manifestEntries.length === 0) {
		fail(`${tarball} has no package/package.json`);
	}
	if (manifestEntries.length !== 1) {
		fail(`${tarball} has ambiguous package/package.json entries after path normalisation`);
	}
	const [entry] = manifestEntries;
	try {
		return JSON.parse(execFileSync('tar', ['-xOzf', tarball, '--', entry.raw], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
	} catch (error) {
		fail(`cannot read package/package.json from ${tarball}: ${error.message}`);
	}
}

if (TARBALL_PAIRS.length === 0) {
	fail('no tarballs supplied — refusing to certify nothing');
}

const lock = readLockfile(ROOT, fail);

const importers = lock?.importers;
if (importers === null || typeof importers !== 'object' || Array.isArray(importers)) {
	fail('pnpm-lock.yaml has no usable importers map');
}
const catalog = lock?.catalogs?.default;
if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
	fail('pnpm-lock.yaml has no usable default catalog');
}

const sourceByProject = new Map();
const sourceByName = new Map();
for (const project of Object.keys(importers)) {
	const manifest = readManifest(project);
	assertDependencyBlocks(manifest, `${project} source manifest`, fail);
	if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') {
		fail(`${project} source manifest has no string name and version`);
	}
	if (sourceByName.has(manifest.name)) {
		fail(`source manifests contain duplicate package name ${manifest.name}`);
	}
	sourceByProject.set(project, manifest);
	sourceByName.set(manifest.name, manifest);
}

function assertArtifactDependencies(tarball, source, packed) {
	assertDependencyBlocks(packed, `${tarball}: packed manifest`, fail);
	for (const block of DEPENDENCY_BLOCKS) {
		const sourceDependencies = source[block] ?? {};
		const packedDependencies = packed[block] ?? {};
		for (const [name, range] of Object.entries(packedDependencies)) {
			if (typeof range !== 'string' || range.startsWith('catalog:') || range.startsWith('workspace:')) {
				fail(`${tarball}: packed ${block}.${name} leaks an unresolved protocol (${String(range)})`);
			}
		}
		const added = Object.keys(packedDependencies).filter((name) => !Object.hasOwn(sourceDependencies, name));
		if (added.length > 0) {
			fail(`${tarball}: packed ${block} adds ${added.join(', ')}, which source ${source.name} does not declare`);
		}
		const dropped = Object.keys(sourceDependencies).filter((name) => !Object.hasOwn(packedDependencies, name));
		if (dropped.length > 0) {
			fail(`${tarball}: packed ${block} drops ${dropped.join(', ')}, which source ${source.name} declares`);
		}
		for (const [name, sourceRange] of Object.entries(sourceDependencies)) {
			let expected;
			if (sourceRange === 'catalog:') {
				expected = catalog[name]?.specifier;
				if (typeof expected !== 'string') {
					fail(`${tarball}: source ${source.name} ${block}.${name} says catalog:, but the default catalog has no recorded specifier`);
				}
			} else if (sourceRange === 'workspace:*' || sourceRange === 'workspace:^') {
				const workspace = sourceByName.get(name);
				if (workspace === undefined) {
					fail(`${tarball}: source ${source.name} ${block}.${name} names unknown workspace package ${name}`);
				}
				expected = `${sourceRange === 'workspace:^' ? '^' : ''}${workspace.version}`;
			} else {
				continue;
			}
			if (packedDependencies[name] !== expected) {
				fail(`${tarball}: packed ${block}.${name} is ${String(packedDependencies[name])}, expected ${expected} from source ${sourceRange}`);
			}
		}
	}
}

function expectedPackedManifest(tarball, source) {
	const expected = structuredClone(source);
	// These are the only `pnpm pack` normalisations this guard understands:
	// hard-coded drops can be checked, but publishConfig overrides transform
	// values we would have to predict. A future pnpm change therefore refuses
	// to publish instead of certifying an artifact this guard no longer models.
	delete expected.packageManager;
	delete expected.pnpm;
	if (expected.scripts !== undefined) {
		for (const lifecycle of PACK_DROPPED_SCRIPT_KEYS) delete expected.scripts[lifecycle];
	}
	for (const block of DEPENDENCY_BLOCKS) {
		for (const [name, sourceRange] of Object.entries(source[block] ?? {})) {
			if (sourceRange === 'catalog:') {
				const range = catalog[name]?.specifier;
				if (typeof range !== 'string') {
					fail(`${tarball}: source ${source.name} ${block}.${name} says catalog:, but the default catalog has no recorded specifier`);
				}
				expected[block][name] = range;
			} else if (sourceRange === 'workspace:*' || sourceRange === 'workspace:^') {
				const workspace = sourceByName.get(name);
				if (workspace === undefined) {
					fail(`${tarball}: source ${source.name} ${block}.${name} names unknown workspace package ${name}`);
				}
				expected[block][name] = `${sourceRange === 'workspace:^' ? '^' : ''}${workspace.version}`;
			}
		}
	}
	return expected;
}

function assertPublicPublishConfig(tarball, side, manifest) {
	const config = manifest.publishConfig;
	if (config === null || typeof config !== 'object' || Array.isArray(config)) {
		fail(`${tarball}: ${side} publishConfig must be exactly {"access":"public"}`);
	}
	const keys = Object.keys(config);
	if (keys.length !== 1 || keys[0] !== 'access' || config.access !== 'public') {
		fail(`${tarball}: ${side} publishConfig must be exactly {"access":"public"}`);
	}
}

function parseTarballPair(argument, seenProjects, seenTarballs) {
	const separator = argument.indexOf('=');
	if (separator <= 0 || separator === argument.length - 1) {
		fail(`tarball argument ${argument} must be <project>=<tarball>`);
	}
	const project = argument.slice(0, separator);
	const tarball = resolve(argument.slice(separator + 1));
	if (seenProjects.has(project)) fail(`project ${project} appears more than once`);
	if (seenTarballs.has(tarball)) fail(`tarball ${tarball} appears more than once`);
	seenProjects.add(project);
	seenTarballs.add(tarball);
	return { project, tarball };
}

const seenProjects = new Set();
const seenTarballs = new Set();
for (const argument of TARBALL_PAIRS) {
	const { project, tarball } = parseTarballPair(argument, seenProjects, seenTarballs);
	const source = sourceByProject.get(project);
	if (source === undefined) {
		fail(`${tarball}: project ${project} is not a workspace importer`);
	}
	const entries = archiveEntries(tarball);
	if (entries.some(({ path }) => path === 'package/node_modules' || path.startsWith('package/node_modules/'))) {
		fail(`${tarball} contains package/node_modules, so it ships bundled dependency copies`);
	}
	if (entries.some(({ path }) => path === 'package/npm-shrinkwrap.json')) {
		fail(`${tarball} contains package/npm-shrinkwrap.json, which can dictate published resolutions outside the catalog`);
	}

	const packed = packedManifest(tarball, entries);
	if (typeof packed?.name !== 'string' || typeof packed?.version !== 'string') {
		fail(`${tarball} package/package.json has no string name and version`);
	}
	if (packed.name !== source.name) {
		fail(`${tarball}: packed name ${packed.name} does not match source ${source.name} for project ${project}`);
	}
	if (packed.version !== source.version) {
		fail(`${tarball}: packed version ${packed.version} does not match source ${source.version} for project ${project}`);
	}
	assertPublicPublishConfig(tarball, `source ${source.name}`, source);
	assertPublicPublishConfig(tarball, 'packed manifest', packed);
	for (const field of ['bundleDependencies', 'bundledDependencies']) {
		if (Object.hasOwn(packed, field)) {
			fail(`${tarball}: packed manifest has ${field}`);
		}
	}
	assertArtifactDependencies(tarball, source, packed);
	const expected = expectedPackedManifest(tarball, source);
	if (!isDeepStrictEqual(packed, expected)) {
		fail(`${tarball}: packed manifest does not exactly match source ${source.name} after catalog and workspace substitutions`);
	}
}

console.log(`packed check: ${TARBALL_PAIRS.length} tarball(s) match their source catalog and workspace contracts.`);
