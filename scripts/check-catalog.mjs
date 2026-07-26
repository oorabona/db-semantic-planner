#!/usr/bin/env node
/**
 * Checks that every dependency range in the workspace comes from the catalog,
 * and that the workspace's own dependencies resolve to one version each.
 *
 * Pnpm discovers the workspace projects; the lockfile records the projects it
 * installed. This check compares those two sets rather than reimplementing
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
 * block, and the lockfile is used for what only it knows — what each declaration
 * actually resolved to.
 *
 * Run it after `pnpm install --frozen-lockfile`, which is what keeps the
 * lockfile a faithful description of the manifests.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifestReader, DEPENDENCY_BLOCKS, readLockfile } from './check-guard-shared.mjs';

/** Defaults to this repository; a path argument lets the tests point it at fixtures. */
const ROOT = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const LOCKFILE = resolve(ROOT, 'pnpm-lock.yaml');

/**
 * What a declaration may say is a closed set, not a prefix. Every widening is a
 * way back to two versions of one package: `catalog:legacy` can name a second
 * range for the same dependency, `workspace:~` publishes a different contract
 * from `workspace:*` and `workspace:^`, and a bare `workspace:` or an explicit
 * range says something else again. Adding a form has to be an edit here.
 */
const THIRD_PARTY_FORM = 'catalog:';
const WORKSPACE_FORMS = new Set(['workspace:*', 'workspace:^']);

/** A catalog's recorded specifier must begin like an npm version range, not a tag or source shorthand. */
function isPlainCatalogRange(specifier) {
	return /^[v=]?\d|^[*xX~^<>]/.test(specifier) && !specifier.includes(':') && !specifier.includes('/');
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
 * What a declaration actually resolved to, as a package rather than as a key.
 *
 * The key is not the identity. pnpm writes an aliased dependency's real package
 * into the resolution — declare `odd-alias: npm:is-odd@2.0.0` and the importer
 * records `odd-alias: {version: "is-odd@2.0.0"}`, while an ordinary dependency
 * records a bare `3.0.1`. Reading identity from there rather than from the key
 * is what makes an alias visible at all: two keys naming one package become two
 * versions of that package, which is the thing this looks for. It also needs no
 * knowledge of how the alias was spelled, so `npm:`, `jsr:` and whatever pnpm
 * supports next are covered without being listed.
 *
 * Two importers reach the same workspace package by different relative paths —
 * `link:packages/core` from the root, `link:../core` from packages/mcp-server —
 * so those resolve against their importer to compare equal. A registry version
 * carries a peer-context suffix that is not part of its identity: this workspace
 * has 131 such instances and they are the normal shape of a pnpm store, not the
 * duplicate this looks for.
 */
function resolvedPackage(project, key, version) {
	const raw = String(version);
	for (const protocol of ['link:', 'file:']) {
		if (raw.startsWith(protocol)) {
			return { name: key, version: `link:${posix.normalize(posix.join(project, raw.slice(protocol.length)))}` };
		}
	}
	const bare = raw.split('(')[0];
	const at = bare.lastIndexOf('@');
	if (at > 0) return { name: bare.slice(0, at), version: bare.slice(at + 1) };
	return { name: key, version: bare };
}

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
			execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], {
				cwd: ROOT,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}),
		);
	} catch (error) {
		fail(
			`cannot discover the complete workspace with \`pnpm list -r --depth -1 --json\`: ${error.message}. This guard needs a single shared lockfile covering the whole workspace.`,
		);
	}
	if (!Array.isArray(records)) {
		fail('pnpm project discovery did not return a JSON array. This guard needs a single shared lockfile covering the whole workspace.');
	}

	const projects = new Set();
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
		projects.add(relativePath === '' ? '.' : relativePath.split(sep).join(posix.sep));
	}
	return projects;
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
 * Everything below trusts this file to describe the install. That is only true
 * if it is the file the install used, and several settings make it not be —
 * `lockfile: false` writes none, `gitBranchLockfile: true` writes a
 * branch-specific one, and a stale checkout writes nothing at all. Rather than
 * enumerate the settings, compare against the copy pnpm keeps of what it
 * actually installed from. A mismatch means this check would be certifying a
 * lockfile that governs nothing.
 */
const INSTALLED_LOCKFILE = resolve(ROOT, 'node_modules/.pnpm/lock.yaml');
let installed;
try {
	installed = readFileSync(INSTALLED_LOCKFILE, 'utf8');
} catch {
	fail(
		`no ${INSTALLED_LOCKFILE} — nothing has been installed here, so pnpm-lock.yaml is unverified. Run pnpm install --frozen-lockfile first; this check reads the result of an install, not a file on its own.`,
	);
}
if (installed !== readFileSync(LOCKFILE, 'utf8')) {
	fail(
		'pnpm-lock.yaml is not the lockfile pnpm installed from. The install used a different one — a branch lockfile, no lockfile, or an out-of-date checkout — so this file describes something other than what is on disk.',
	);
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
assertSameProjectSet(new Set(projects), discoveredProjects());

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
/**
 * What the catalog itself resolved to, as pnpm recorded it. Every `catalog:`
 * declaration is then held to exactly this version. Its specifier must be a
 * plain range too: this catches aliases and source protocols that a resolved
 * name cannot prove (`link:`, `file:` and bare versions manufacture `name: key`
 * in `resolvedPackage`). Conversely, the resolved-name comparison below catches
 * an alias target under an ordinary-looking key. Neither rule alone is a
 * general identity proof; together they cover the recorded shapes pnpm exposes.
 *
 * That one comparison is what makes the mechanisms below it irrelevant. An
 * override, a patch, a pnpmfile, a resolution mode — anything that moves a
 * project off the version the catalog produced shows up here as a mismatch,
 * without this needing to know which of them did it, or how it was spelled.
 * The alternative is a list of mechanisms to inspect, and that list is only ever
 * as current as the last person to read pnpm's changelog.
 */
const catalogResolved = lock?.catalogs?.default ?? {};
for (const [name, entry] of Object.entries(catalogResolved)) {
	if (typeof entry?.specifier !== 'string' || !isPlainCatalogRange(entry.specifier)) {
		fail(
			`catalog entry ${name} has non-plain specifier ${String(entry?.specifier)}. Catalog entries must record a plain range, not an alias or source protocol.`,
		);
	}
}

/** Every project's own name, so a declaration's required form follows from what it names. */
const manifests = new Map(projects.map((project) => [project, readManifest(project)]));
const workspaceProjectsByName = new Map();
for (const [project, manifest] of manifests) {
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

	// Only the lockfile knows what a declaration resolved to.
	for (const block of DEPENDENCY_BLOCKS) {
		for (const [key, declared] of Object.entries(importers[project]?.[block] ?? {})) {
			if (typeof declared?.version !== 'string') {
				// Without a version there is no identity, and every such entry would
				// collapse onto one — a silent way for two versions to compare equal.
				fail(`lockfile entry ${project} → ${block}.${key} has no resolved version`);
			}
			const resolved = resolvedPackage(project, key, declared.version);

			// A `catalog:` declaration must have got what the catalog got. This is
			// where a mechanism that quietly re-resolves it becomes visible.
			if (declared.specifier === THIRD_PARTY_FORM) {
				const expected = catalogResolved[key]?.version;
				if (expected === undefined) {
					fail(
						`${project} → ${block}.${key} says catalog:, but pnpm recorded no catalog resolution for it. Run pnpm install; if it persists, the catalog does not name ${key}.`,
					);
				}
				if (resolved.version !== expected) {
					fail(
						`${project} → ${block}.${key} resolved to ${resolved.version}, but the catalog resolved to ${expected}. Something between the catalog and this project re-decided the version — an override, a patch, a pnpmfile hook. The catalog is meant to be the only place that decides it.`,
					);
				}
				if (resolved.name !== key) {
					fail(
						`${project} → ${block}.${key} says catalog:, but resolved package identity is ${resolved.name}. A catalog key must resolve to the package with the same name.`,
					);
				}
			}

			// `workspace:*` and `workspace:^` say that this exact checked-out
			// project is the dependency. pnpm records that target as a link relative
			// to the importing project, so compare its normalized destination with
			// the importer belonging to the dependency name rather than merely
			// grouping every link under that name.
			if (WORKSPACE_FORMS.has(declared.specifier)) {
				const expectedProject = workspaceProjectsByName.get(key);
				if (expectedProject === undefined) {
					fail(`${project} → ${block}.${key} says ${declared.specifier}, but no workspace project is named ${key}`);
				}
				if (resolved.version !== `link:${expectedProject}`) {
					fail(
						`${project} → ${block}.${key} resolves to ${resolved.version}, but workspace package ${key} is importer ${expectedProject}. A workspace declaration must link to the project bearing its name.`,
					);
				}
			}

			if (!resolutions.has(resolved.name)) resolutions.set(resolved.name, new Map());
			const versions = resolutions.get(resolved.name);
			if (!versions.has(resolved.version)) versions.set(resolved.version, []);
			versions.get(resolved.version).push(project);
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
