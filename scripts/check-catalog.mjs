#!/usr/bin/env node
/**
 * Checks that every dependency range in the workspace comes from the catalog,
 * and that the workspace's own dependencies resolve to one version each.
 *
 * Pnpm discovers the workspace projects and reports their direct resolutions;
 * the lockfile records the projects it installed. This check compares those
 * project sets rather than reimplementing
 * workspace glob semantics, because reproducing YAML escapes and pnpm's glob
 * handling would be a copy that drifts from the original.
 *
 * What pnpm records is not enough on its own, though. An importer collapses a
 * dependency declared in several blocks into one entry, so a peer range that is
 * shadowed by a dev dependency of the same name never reaches the lockfile at
 * all: `pnpm install --frozen-lockfile` and a lockfile-only check both accept
 * `peerDependencies.tsx: "^4.21.0"` while `devDependencies.tsx` stays
 * `"catalog:"`. A published peer drifting from the catalog is exactly the defect
 * this exists to prevent, so the declarations are read from the manifests, per
 * block. `pnpm list` supplies the direct resolutions without exposing the
 * lockfile's dependency-path grammar.
 *
 * Run it after `pnpm install --frozen-lockfile`. That reconciles manifests and
 * lockfile, and CI runs it immediately before this guard; this guard does not
 * duplicate that reconciliation.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { assertDependencyBlocks, createManifestReader, DEPENDENCY_BLOCKS, readLockfile } from './check-guard-shared.mjs';

/** Defaults to this repository; a path argument lets the tests point it at fixtures. */
const ROOT = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
/**
 * What a declaration may say is a closed set, not a prefix. Every widening is a
 * way back to two versions of one package: `catalog:legacy` can name a second
 * range for the same dependency, `workspace:~` publishes a different contract
 * from `workspace:*` and `workspace:^`, and a bare `workspace:` or an explicit
 * range says something else again. Adding a form has to be an edit here.
 */
const THIRD_PARTY_FORM = 'catalog:';
const WORKSPACE_FORMS = new Set(['workspace:*', 'workspace:^']);

/**
 * Release policy intentionally accepts this closed catalog-specifier language.
 * A future legitimate comparator or prerelease is a deliberate guard edit:
 * widening to general npm ranges would need semver parsing and would change the
 * published-range policy, not merely recognise another spelling.
 */
function isAllowedCatalogSpecifier(specifier) {
	return /^(?:[~^]?\d+\.\d+\.\d+)$/.test(specifier);
}

/** Which form a name must use is decided by what the name IS, not by the caller. */
function expectedForms(name, workspacePackages) {
	return workspacePackages.has(name) ? WORKSPACE_FORMS : new Set([THIRD_PARTY_FORM]);
}

function fail(message) {
	console.error(`catalog check: ${message}`);
	process.exit(1);
}

const { assertInside, readManifest, realRoot: REAL_ROOT } = createManifestReader(ROOT, fail);

/**
 * Discover projects from pnpm itself instead of reconstructing workspace globs.
 * One bound remains: a repo-level setting that narrows both pnpm discovery and
 * the install leaves these two pnpm views agreeing, and this check cannot see
 * that narrowing.
 */
function discoveredProjects() {
	let records;
	try {
		records = JSON.parse(
			// 64 MiB is ample for the workspace's direct-resolution report.
			execFileSync('pnpm', ['list', '-r', '--depth', '0', '--json'], {
				cwd: ROOT,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				maxBuffer: 64 * 1024 * 1024,
			}),
		);
	} catch (error) {
		fail(
			`cannot discover the complete workspace with \`pnpm list -r --depth 0 --json\`: ${error.message}. This guard needs a single shared lockfile covering the whole workspace.`,
		);
	}
	if (!Array.isArray(records)) {
		fail('pnpm project discovery did not return a JSON array. This guard needs a single shared lockfile covering the whole workspace.');
	}

	const projects = new Set();
	const recordsByProject = new Map();
	for (const record of records) {
		if (record === null || typeof record !== 'object' || typeof record.path !== 'string') {
			fail('pnpm project discovery returned a project without a path. This guard needs a single shared lockfile covering the whole workspace.');
		}
		const path = resolve(record.path);
		assertInside(ROOT, path, 'pnpm-discovered project');
		let real;
		try {
			real = realpathSync(path);
		} catch (error) {
			fail(`cannot resolve pnpm-discovered project ${record.path}: ${error.message}`);
		}
		assertInside(REAL_ROOT, real, 'pnpm-discovered project');
		const relativePath = relative(ROOT, path);
		const project = relativePath === '' ? '.' : relativePath.split(sep).join(posix.sep);
		projects.add(project);
		recordsByProject.set(project, record);
	}
	return { projects, recordsByProject };
}

function assertSameProjectSet(lockfileProjects, pnpmProjects) {
	const missingFromLockfile = [...pnpmProjects].filter((project) => !lockfileProjects.has(project));
	const missingFromPnpm = [...lockfileProjects].filter((project) => !pnpmProjects.has(project));
	if (missingFromLockfile.length > 0 || missingFromPnpm.length > 0) {
		const details = [
			missingFromLockfile.length > 0 && `pnpm listed but the lockfile lacks: ${missingFromLockfile.join(', ')}`,
			missingFromPnpm.length > 0 && `lockfile carries but pnpm did not list: ${missingFromPnpm.join(', ')}`,
		]
			.filter(Boolean)
			.join('; ');
		fail(`project discovery and pnpm-lock.yaml importers differ (${details}). This guard needs a single shared lockfile covering the whole workspace; run a complete shared workspace install.`);
	}
}

const lock = readLockfile(ROOT, fail);

/**
 * The workspace file is authority for what was declared; pnpm's installed list
 * is authority for direct resolutions. Neither substitutes for the other:
 * pnpm omits unused catalog entries from its list.
 */
let workspace;
try {
	workspace = parse(readFileSync(resolve(ROOT, 'pnpm-workspace.yaml'), 'utf8'));
} catch (error) {
	fail(`cannot read pnpm-workspace.yaml: ${error.message}`);
}
if (workspace === null || typeof workspace !== 'object' || Array.isArray(workspace)) {
	fail('pnpm-workspace.yaml is not a map');
}
if (Object.hasOwn(workspace, 'catalogs')) {
	fail('pnpm-workspace.yaml declares named catalogs. This repository has one catalog on purpose: a second one can hold a different range for the same package.');
}
if (workspace.catalog !== undefined && (workspace.catalog === null || typeof workspace.catalog !== 'object' || Array.isArray(workspace.catalog))) {
	fail('pnpm-workspace.yaml catalog is not a map');
}
for (const [name, specifier] of Object.entries(workspace.catalog ?? {})) {
	if (typeof specifier !== 'string' || !isAllowedCatalogSpecifier(specifier)) {
		fail(`pnpm-workspace.yaml catalog entry ${name} has disallowed specifier ${String(specifier)}. Catalog entries must use the release policy's closed range grammar.`);
	}
}

/**
 * `pnpmfileChecksum` is pnpm's record that a pnpmfile participated in the
 * install, regardless of whether it was the conventional filename or the
 * configured `pnpmfile:` path. Its absence is detection, not proof: a hook can
 * appear after this install or only run while packing. CI's frozen install
 * immediately before this check is what makes this refusal strong there.
 */
if (lock?.pnpmfileChecksum !== undefined) {
	fail(
		'pnpm-lock.yaml records pnpmfileChecksum, so a pnpmfile participated in this install. This check refuses hook-rewritten resolutions; absence is not proof no hook can run while packing.',
	);
}

// A check that certifies an empty or malformed workspace is worse than no check:
// it reports success over ground it never looked at. Nothing here may default.
const importers = lock?.importers;
if (importers === null || typeof importers !== 'object' || Array.isArray(importers)) {
	fail('pnpm-lock.yaml has no usable `importers` map — run pnpm install first');
}
const projects = Object.keys(importers);
if (projects.length === 0) {
	fail('pnpm-lock.yaml lists no workspace projects — refusing to certify an empty workspace');
}
const { projects: pnpmProjects, recordsByProject } = discoveredProjects();
assertSameProjectSet(new Set(projects), pnpmProjects);

/**
 * Pnpm records every named catalog in this lockfile. Refuse every name but the
 * default one: this is hardening, not a live bypass fix, because named catalogs
 * are already visible in pnpm's recorded resolution graph.
 */
const catalogNames = Object.keys(lock?.catalogs ?? {});
if (catalogNames.some((name) => name !== 'default')) {
	fail(
		'pnpm-lock.yaml records named catalogs. This repository has one catalog on purpose: a second one can hold a different range for the same package, which is how a dependency ends up loaded twice.',
	);
}
for (const [name, entry] of Object.entries(lock?.catalogs?.default ?? {})) {
	if (typeof entry?.specifier !== 'string' || !isAllowedCatalogSpecifier(entry.specifier)) {
		fail(
			`catalog entry ${name} has disallowed specifier ${String(entry?.specifier)}. Catalog entries must use the release policy's closed range grammar.`,
		);
	}
}

/** Every project's own name, so a declaration's required form follows from what it names. */
const manifests = new Map(projects.map((project) => [project, readManifest(project)]));
const workspaceProjectsByName = new Map();
for (const [project, manifest] of manifests) {
	assertDependencyBlocks(manifest, `${project} source manifest`, fail);
	if (typeof manifest?.name !== 'string') continue;
	if (workspaceProjectsByName.has(manifest.name)) {
		fail(`workspace manifests contain duplicate package name ${manifest.name}`);
	}
	workspaceProjectsByName.set(manifest.name, project);
}
const workspacePackages = new Set(workspaceProjectsByName.keys());

const offenders = [];
const resolutions = new Map();
let declarations = 0;

for (const project of projects) {
	const manifest = manifests.get(project);
	for (const field of ['bundleDependencies', 'bundledDependencies']) {
		if (Object.hasOwn(manifest, field)) {
			fail(
				`${project}/${field} is present. Bundled dependencies ship a physical package/node_modules copy, so a range comparison cannot prevent a second copy from being published.`,
			);
		}
	}
	for (const block of DEPENDENCY_BLOCKS) {
		for (const [name, range] of Object.entries(manifest[block] ?? {})) {
			declarations += 1;
			const allowed = expectedForms(name, workspacePackages);
			if (typeof range !== 'string' || !allowed.has(range)) {
				offenders.push({ project, block, name, range: String(range), allowed: [...allowed] });
			}
		}
	}

	const record = recordsByProject.get(project);
	for (const block of ['dependencies', 'devDependencies', 'optionalDependencies']) {
		for (const [key, entry] of Object.entries(record?.[block] ?? {})) {
			if (entry?.from !== key) {
				fail(`pnpm list entry ${project} → ${block}.${key} reports from ${String(entry?.from)}, not ${key}. A direct dependency must resolve to the name it declares.`);
			}
			if (typeof entry.version !== 'string') {
				fail(`pnpm list entry ${project} → ${block}.${key} has no resolved version`);
			}
			if (entry.version.startsWith('link:')) {
				const expectedProject = workspaceProjectsByName.get(key);
				if (expectedProject === undefined) {
					fail(`${project} → ${block}.${key} resolves as a workspace link, but no workspace project is named ${key}`);
				}
				if (typeof entry.path !== 'string') {
					fail(`pnpm list entry ${project} → ${block}.${key} has no resolved path for its workspace link`);
				}
				let actual;
				let expected;
				try {
					actual = realpathSync(resolve(entry.path));
					expected = realpathSync(resolve(ROOT, expectedProject));
				} catch (error) {
					fail(`cannot resolve workspace link ${project} → ${block}.${key}: ${error.message}`);
				}
				if (actual !== expected) {
					fail(`${project} → ${block}.${key} resolves to ${actual}, but workspace package ${key} is ${expected}. A workspace declaration must link to the project bearing its name.`);
				}
				continue;
			}
			if (!resolutions.has(key)) resolutions.set(key, new Map());
			const versions = resolutions.get(key);
			if (!versions.has(entry.version)) versions.set(entry.version, []);
			versions.get(entry.version).push(project);
		}
	}
}

const duplicates = [...resolutions].filter(([, versions]) => versions.size > 1);

if (offenders.length > 0 || duplicates.length > 0) {
	if (offenders.length > 0) {
		console.error(`catalog check: ${offenders.length} declaration(s) do not use the form their dependency requires\n`);
		for (const { project, block, name, range, allowed } of offenders) {
			console.error(`  ${project} → ${block}.${name}: ${range}   (expected ${allowed.join(' or ')})`);
		}
		console.error(
			'\nA package that carries its own range gets its own resolution, so the same\nlibrary can load twice in one process. Third-party ranges live in the\n`catalog:` of pnpm-workspace.yaml; a package of this workspace is named\nthrough the workspace protocol so the checked-out copy is the one used.\n',
		);
	}
	if (duplicates.length > 0) {
		console.error(`catalog check: ${duplicates.length} name(s) resolve to more than one version across workspace projects\n`);
		for (const [name, versions] of duplicates) {
			console.error(`  ${name}`);
			for (const [version, where] of versions) console.error(`    ${version}  ← ${where.join(', ')}`);
		}
		console.error('\nTwo projects of this workspace depend on different versions of the same\npackage. That is the shape of #387.\n');
	}
	process.exit(1);
}

console.log(
	`catalog check: ${declarations} declarations across ${projects.length} workspace projects, all through the catalog or the workspace protocol; ${resolutions.size} direct dependencies, one version each.`,
);
