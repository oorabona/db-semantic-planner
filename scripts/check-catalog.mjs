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
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
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

let REAL_ROOT;
try {
	REAL_ROOT = realpathSync(ROOT);
} catch (error) {
	fail(`cannot resolve ${ROOT}: ${error.message}`);
}

/**
 * `relative` rather than a `${root}/` prefix, because on Windows `resolve`
 * returns `C:\repo\packages\core` and that prefix never matches — every child
 * project would read as outside the repository.
 */
function assertInside(root, path, describe) {
	const rel = relative(root, path);
	if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
		fail(`${describe} resolves outside the repository (${path})`);
	}
}

/**
 * A path out of the lockfile is untrusted input, and `resolve` strips `..` but
 * not a symlink: an importer directory, or the manifest inside it, can point
 * anywhere while its lexical path still sits under the root. Both forms are
 * checked — the lexical one because it works on a path that does not exist, the
 * canonical one because it is the path actually read. Returns undefined when
 * there is nothing there; what that means is the caller's decision.
 */
function containedPath(path, describe) {
	assertInside(ROOT, path, describe);
	let real;
	try {
		real = realpathSync(path);
	} catch {
		return undefined;
	}
	assertInside(REAL_ROOT, real, describe);
	return real;
}

/**
 * pnpm's own precedence, copied from its `MANIFEST_BASE_NAMES`: the first of
 * these that exists is the manifest, and the rest are inert files on disk.
 */
const MANIFEST_BASE_NAMES = ['package.json', 'package.json5', 'package.yaml'];

/**
 * Read the manifest pnpm would read. This does not parse JSON5, and reading a
 * file pnpm is not using would be worse than reading none — the check would
 * certify a manifest that governs nothing — so a project whose effective
 * manifest is JSON5 stops the check instead. No project here has one; if one
 * ever does, teach this to read it (pnpm's own reader is
 * `@pnpm/read-project-manifest`) rather than reordering around it.
 */
function readManifest(project) {
	const directory = resolve(ROOT, project);
	containedPath(directory, `lockfile importer "${project}"`);
	const found = new Map();
	for (const file of MANIFEST_BASE_NAMES) {
		const path = containedPath(resolve(directory, file), `${project}/${file}`);
		if (path !== undefined) found.set(file, path);
	}
	// Only the first one pnpm would pick matters. A package.json5 sitting beside
	// a package.json changes nothing, because pnpm reads the json.
	const [file, path] = found.entries().next().value ?? [];
	if (file === undefined) {
		fail(`${project} has none of ${MANIFEST_BASE_NAMES.join(', ')} — the three manifests pnpm accepts.`);
	}
	if (file === 'package.json5') {
		fail(
			`${project}/package.json5 is the manifest pnpm reads here, and this check cannot parse JSON5. Refusing rather than certifying a manifest pnpm is not using.`,
		);
	}
	try {
		return (file === 'package.json' ? JSON.parse : parse)(readFileSync(path, 'utf8'));
	} catch (error) {
		fail(`cannot parse ${project}/${file}: ${error.message}`);
	}
}

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

let lock;
try {
	lock = parse(readFileSync(LOCKFILE, 'utf8'));
} catch (error) {
	fail(`cannot read ${LOCKFILE}: ${error.message}`);
}

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
 * A pnpmfile is arbitrary code that rewrites manifests, and `beforePacking`
 * runs after every check here, on its way into the tarball. Nothing this reads
 * would show it. There is none in this repository; adding one means deciding
 * how the published manifest gets verified, which is a larger question than
 * this check answers.
 */
for (const name of ['.pnpmfile.cjs', '.pnpmfile.js', 'pnpmfile.cjs']) {
	if (containedPath(resolve(ROOT, name), name) !== undefined) {
		fail(
			`${name} exists. A pnpmfile can rewrite dependencies after this check runs — hooks.beforePacking edits the manifest on its way into the tarball — so what is verified here need not be what is published.`,
		);
	}
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
/**
 * What the catalog itself resolved to, as pnpm recorded it. Every `catalog:`
 * declaration is then held to exactly this version.
 *
 * That one comparison is what makes the mechanisms below it irrelevant. An
 * override, a patch, a pnpmfile, a resolution mode — anything that moves a
 * project off the version the catalog produced shows up here as a mismatch,
 * without this needing to know which of them did it, or how it was spelled.
 * The alternative is a list of mechanisms to inspect, and that list is only ever
 * as current as the last person to read pnpm's changelog.
 */
const catalogResolved = lock?.catalogs?.default ?? {};

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
