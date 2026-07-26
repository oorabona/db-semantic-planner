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
import { createManifestReader, DEPENDENCY_BLOCKS, readLockfile } from './check-guard-shared.mjs';

const ROOT = resolve(process.cwd());
const TARBALL_PAIRS = process.argv.slice(2);

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

	const entries = [];
	const normalized = new Set();
	for (const raw of rawEntries) {
		// Refuse a parent-directory segment on the spelling, before normalising it
		// away. `package/nested/../side.js` lands inside package/ under this
		// normaliser, but whether it does depends on whose normaliser runs — and
		// pnpm does not write that spelling, so there is nothing to reason about.
		if (raw.split('/').includes('..')) {
			fail(`${tarball} contains archive path ${raw}, which is spelled with a parent-directory segment`);
		}
		// Absolute paths need no separate test: they normalise to themselves and
		// fail the package/ prefix below.
		const path = posix.normalize(raw).replace(/\/+$/, '');
		if (path !== 'package' && !path.startsWith('package/')) {
			fail(`${tarball} contains archive path ${raw}, which escapes package/`);
		}
		if (normalized.has(path)) {
			fail(`${tarball} contains multiple spellings of archive path ${path}`);
		}
		normalized.add(path);
		entries.push({ path, raw });
	}
	return entries;
}

function assertRegularArchiveEntries(tarball) {
	let listing;
	try {
		listing = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (error) {
		fail(`cannot inspect ${tarball} archive entry types: ${error.message}`);
	}
	for (const line of listing.split(/\r?\n/).filter(Boolean)) {
		if (line.startsWith('l')) fail(`${tarball} contains a symbolic-link archive entry`);
		if (line.startsWith('h')) fail(`${tarball} contains a hard-link archive entry`);
		if (!line.startsWith('-') && !line.startsWith('d')) {
			fail(`${tarball} contains unsupported archive entry type ${line[0]}`);
		}
	}
}

function packedManifest(tarball, entries) {
	const entry = entries.find(({ path }) => path === 'package/package.json');
	if (entry === undefined) {
		fail(`${tarball} has no package/package.json`);
	}
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
	for (const block of DEPENDENCY_BLOCKS) {
		const sourceDependencies = source[block] ?? {};
		const packedDependencies = packed[block] ?? {};
		if (
			packedDependencies === null ||
			typeof packedDependencies !== 'object' ||
			Array.isArray(packedDependencies)
		) {
			fail(`${tarball}: packed ${block} is not a dependency map`);
		}
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
	assertRegularArchiveEntries(tarball);
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
