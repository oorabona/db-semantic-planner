#!/usr/bin/env node
/**
 * Checks that every dependency range in the workspace comes from the catalog,
 * and that the workspace's own dependencies resolve to one version each.
 *
 * Which projects form the workspace is the one question this does not answer
 * for itself: it takes the list from the `importers` section of pnpm-lock.yaml,
 * where pnpm records the projects it discovered. Reimplementing that discovery
 * would mean reproducing YAML escape semantics, pnpm's glob handling and its
 * manifest formats — copies that drift from the original to learn what the
 * original already recorded.
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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** Defaults to this repository; a path argument lets the tests point it at fixtures. */
const ROOT = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const LOCKFILE = resolve(ROOT, 'pnpm-lock.yaml');

/** The four blocks a manifest can declare a dependency in. */
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * What a declaration may say is a closed set, not a prefix. Every widening is a
 * way back to two versions of one package: `catalog:legacy` can name a second
 * range for the same dependency, `workspace:~` publishes a different contract
 * from `workspace:*` and `workspace:^`, and a bare `workspace:` or an explicit
 * range says something else again. Adding a form has to be an edit here.
 */
const THIRD_PARTY_FORM = 'catalog:';
const WORKSPACE_FORMS = new Set(['workspace:*', 'workspace:^']);

/** Which form a name must use is decided by what the name IS, not by the caller. */
function expectedForms(name, workspacePackages) {
	return workspacePackages.has(name) ? WORKSPACE_FORMS : new Set([THIRD_PARTY_FORM]);
}

function fail(message) {
	console.error(`catalog check: ${message}`);
	process.exit(1);
}

/**
 * Read one project's manifest. pnpm also accepts package.json5, which this does
 * not parse — an unread manifest would be a silent hole, so it stops instead.
 */
function readManifest(project) {
	// A project path comes from the lockfile, and a lockfile is a file like any
	// other. An absolute or `../`-bearing key would send the read outside the
	// repository and put a foreign manifest's contents in the log.
	const directory = resolve(ROOT, project);
	if (directory !== ROOT && !directory.startsWith(`${ROOT}/`)) {
		fail(`lockfile importer "${project}" resolves outside the repository (${directory})`);
	}
	for (const [file, parseAs] of [
		['package.json', JSON.parse],
		['package.yaml', parse],
	]) {
		const path = resolve(directory, file);
		if (!existsSync(path)) continue;
		try {
			return parseAs(readFileSync(path, 'utf8'));
		} catch (error) {
			fail(`cannot parse ${project}/${file}: ${error.message}`);
		}
	}
	fail(
		`${project} has neither package.json nor package.yaml. pnpm also supports package.json5, which this check does not read — convert the manifest or teach the check to read it, rather than leaving it unchecked.`,
	);
}

/**
 * Two importers reach the same workspace package by different relative paths —
 * `link:packages/core` from the root, `link:../core` from packages/mcp-server.
 * Resolve both against their importer so they compare equal. A registry version
 * carries a peer-context suffix that is not part of its identity: this
 * workspace has 131 such instances and they are the normal shape of a pnpm
 * store, not the duplicate this looks for.
 */
function identity(project, version) {
	const raw = String(version);
	for (const protocol of ['link:', 'file:']) {
		if (raw.startsWith(protocol)) {
			return `link:${posix.normalize(posix.join(project, raw.slice(protocol.length)))}`;
		}
	}
	return raw.split('(')[0];
}

let lock;
try {
	lock = parse(readFileSync(LOCKFILE, 'utf8'));
} catch (error) {
	fail(`cannot read ${LOCKFILE}: ${error.message}`);
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

/**
 * One catalog, and no aliases in it. A named catalog can hold a second range for
 * a package the default catalog already names, and an alias entry
 * (`pg-old: npm:pg@8.20.0`) is a second name for one package — both are the
 * duplicate this exists to prevent, wearing a spelling the rest of the check
 * would read as two unrelated dependencies. Needing either is a deliberate
 * decision that starts by editing this guard.
 */
const workspaceConfig = parse(readFileSync(resolve(ROOT, 'pnpm-workspace.yaml'), 'utf8'));
if (workspaceConfig?.catalogs !== undefined) {
	fail(
		'pnpm-workspace.yaml declares named catalogs. This repository has one catalog on purpose: a second one can hold a different range for the same package, which is how a dependency ends up loaded twice.',
	);
}
const rootManifest = readManifest('.');
const substitutions = [
	...Object.entries(workspaceConfig?.catalog ?? {}).map(([name, value]) => ['catalog entry', name, value]),
	...Object.entries(rootManifest?.pnpm?.overrides ?? {}).map(([name, value]) => ['override', name, value]),
];
for (const [channel, name, value] of substitutions) {
	if (String(value).startsWith('npm:')) {
		fail(
			`${channel} ${name}: ${value} is an alias. Two names for one package defeat the one-version rule — every check below would read them as unrelated dependencies.`,
		);
	}
}

/** Every project's own name, so a declaration's required form follows from what it names. */
const manifests = new Map(projects.map((project) => [project, readManifest(project)]));
const workspacePackages = new Set([...manifests.values()].map((manifest) => manifest?.name).filter(Boolean));

const offenders = [];
const resolutions = new Map();
let declarations = 0;

for (const project of projects) {
	const manifest = manifests.get(project);
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
		for (const [name, declared] of Object.entries(importers[project]?.[block] ?? {})) {
			if (typeof declared?.version !== 'string') {
				// Without a version there is no identity, and every such entry would
				// collapse onto one — a silent way for two versions to compare equal.
				fail(`lockfile entry ${project} → ${block}.${name} has no resolved version`);
			}
			if (!resolutions.has(name)) resolutions.set(name, new Map());
			const versions = resolutions.get(name);
			const version = identity(project, declared.version);
			if (!versions.has(version)) versions.set(version, []);
			versions.get(version).push(project);
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
