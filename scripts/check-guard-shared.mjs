/** Shared filesystem and manifest boundary for the catalog and packed guards. */
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

/** The dependency blocks whose published contract must remain intact. */
export const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** pnpm's manifest precedence: later files are inert when an earlier one exists. */
export const MANIFEST_BASE_NAMES = ['package.json', 'package.json5', 'package.yaml'];

/** Read the workspace lockfile through the same parser used by both guards. */
export function readLockfile(root, fail) {
	const lockfile = resolve(root, 'pnpm-lock.yaml');
	try {
		return parse(readFileSync(lockfile, 'utf8'));
	} catch (error) {
		fail(`cannot read ${lockfile}: ${error.message}`);
	}
}

/**
 * Build a reader for manifests named by untrusted lockfile importer paths.
 * It checks both the lexical and canonical path so a symlink cannot make a
 * guard certify a manifest outside this workspace.
 */
export function createManifestReader(rootArgument, fail) {
	const root = resolve(rootArgument);
	let realRoot;
	try {
		realRoot = realpathSync(root);
	} catch (error) {
		fail(`cannot resolve ${root}: ${error.message}`);
	}

	function assertInside(base, path, describe) {
		const rel = relative(base, path);
		if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
			fail(`${describe} resolves outside the repository (${path})`);
		}
	}

	function containedPath(path, describe) {
		assertInside(root, path, describe);
		let real;
		try {
			real = realpathSync(path);
		} catch {
			return undefined;
		}
		assertInside(realRoot, real, describe);
		return real;
	}

	function readManifest(project) {
		const directory = resolve(root, project);
		containedPath(directory, `lockfile importer "${project}"`);
		const found = new Map();
		for (const file of MANIFEST_BASE_NAMES) {
			const path = containedPath(resolve(directory, file), `${project}/${file}`);
			if (path !== undefined) found.set(file, path);
		}
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

	return { root, realRoot, assertInside, containedPath, readManifest };
}
