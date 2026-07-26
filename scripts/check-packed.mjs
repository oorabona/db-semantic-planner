#!/usr/bin/env node
/**
 * Verifies the package.json and file list in the tarballs that will be
 * published. check-catalog verifies source declarations and the installed
 * graph; lifecycle hooks can still rewrite a manifest while packing, so this
 * deliberately reads the finished artifact instead.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createManifestReader, DEPENDENCY_BLOCKS, readLockfile } from './check-guard-shared.mjs';

const ROOT = resolve(process.cwd());
const TARBALLS = process.argv.slice(2);

function fail(message) {
	console.error(`packed check: ${message}`);
	process.exit(1);
}

const { readManifest } = createManifestReader(ROOT, fail);

function archiveEntries(tarball) {
	try {
		return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
			.split(/\r?\n/)
			.filter(Boolean);
	} catch (error) {
		fail(`cannot read ${tarball} as a tarball: ${error.message}`);
	}
}

function packedManifest(tarball, entries) {
	if (!entries.includes('package/package.json')) {
		fail(`${tarball} has no package/package.json`);
	}
	try {
		return JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
	} catch (error) {
		fail(`cannot read package/package.json from ${tarball}: ${error.message}`);
	}
}

if (TARBALLS.length === 0) {
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

const sourceByName = new Map();
for (const project of Object.keys(importers)) {
	const manifest = readManifest(project);
	if (typeof manifest?.name !== 'string' || typeof manifest?.version !== 'string') {
		fail(`${project} source manifest has no string name and version`);
	}
	if (sourceByName.has(manifest.name)) {
		fail(`source manifests contain duplicate package name ${manifest.name}`);
	}
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

for (const tarballArgument of TARBALLS) {
	const tarball = resolve(tarballArgument);
	const entries = archiveEntries(tarball);
	if (entries.some((entry) => entry === 'package/node_modules' || entry.startsWith('package/node_modules/'))) {
		fail(`${tarball} contains package/node_modules, so it ships bundled dependency copies`);
	}
	if (entries.includes('package/npm-shrinkwrap.json')) {
		fail(`${tarball} contains package/npm-shrinkwrap.json, which can dictate published resolutions outside the catalog`);
	}

	const packed = packedManifest(tarball, entries);
	if (typeof packed?.name !== 'string' || typeof packed?.version !== 'string') {
		fail(`${tarball} package/package.json has no string name and version`);
	}
	const source = sourceByName.get(packed.name);
	if (source === undefined) {
		fail(`${tarball} packs ${packed.name}, which does not match any source workspace package`);
	}
	if (packed.version !== source.version) {
		fail(`${tarball}: packed version ${packed.version} does not match source ${source.version} for ${packed.name}`);
	}
	for (const field of ['bundleDependencies', 'bundledDependencies']) {
		if (Object.hasOwn(packed, field)) {
			fail(`${tarball}: packed manifest has ${field}`);
		}
	}
	assertArtifactDependencies(tarball, source, packed);
}

console.log(`packed check: ${TARBALLS.length} tarball(s) match their source catalog and workspace contracts.`);
