#!/usr/bin/env node
/**
 * Two things nothing was looking at.
 *
 * The docs already execute their own code: `pnpm test:docs` runs every fenced
 * TypeScript block against a real PostgreSQL. So code that no longer compiles, or
 * no longer works, is caught. What was not caught is everything *around* the code:
 *
 *   1. a site-internal link that points at a page which does not exist — twelve
 *      of them survived a directory move because nothing looked;
 *   2. docs teaching an export the packages no longer have — an API can be deleted
 *      from source and left standing in a guide, and no test fails, because the
 *      guide never calls it. It only teaches it.
 *
 * Neither of these can catch prose that lies about *behaviour* — for that, the claim
 * has to be executable, which is what the `real-db-only` doctest blocks are for.
 * This script covers the part a machine can check.
 *
 * Exit 1 on any finding. Run: `node scripts/check-docs.mjs`
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'packages', 'docs');
const PACKAGES = ['types', 'core', 'adapter-pgsql', 'nql', 'cli'];

const BUILTIN_OR_EXTERNAL_SYMBOLS = new Set([
	'AbortController',
	'AbortSignal',
	'AggregateError',
	'Array',
	'ArrayBuffer',
	'BigInt',
	'Boolean',
	'Buffer',
	'Crypto',
	'Date',
	'Error',
	'JSON',
	'Map',
	'Math',
	'Number',
	'Object',
	'Pool',
	'PoolClient',
	'Promise',
	'Readonly',
	'ReadonlyArray',
	'Record',
	'RegExp',
	'Set',
	'String',
	'URL',
	'Uint8Array',
	'WeakMap',
	'WeakSet',
	'console',
	'crypto',
	'process',
]);

function markdownFiles(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist' || entry === '.vitepress') {
			continue;
		}
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) markdownFiles(path, out);
		else if (entry.endsWith('.md')) out.push(path);
	}
	return out;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicDeclarationFile(pkg) {
	return join(ROOT, 'packages', pkg, 'dist', 'index.d.ts');
}

function parseExportList(body, out) {
	for (const rawItem of body.split(',')) {
		const item = rawItem.trim().replace(/^type\s+/, '');
		if (!item) continue;
		const aliasMatch = item.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
		const name = aliasMatch?.[1] ?? item.match(/^([A-Za-z_$][\w$]*)/)?.[1];
		if (name) out.add(name);
	}
}

function readPackageExports() {
	const exported = new Set();
	const findings = [];

	for (const pkg of PACKAGES) {
		const dts = publicDeclarationFile(pkg);
		if (!existsSync(dts)) {
			findings.push(
				`packages/${pkg}/dist/index.d.ts → missing built declaration file`,
			);
			continue;
		}

		const src = readFileSync(dts, 'utf8');
		for (const match of src.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
			parseExportList(match[1], exported);
		}
		for (const match of src.matchAll(
			/export\s+declare\s+(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
		)) {
			exported.add(match[1]);
		}
	}

	return { exported, findings };
}

function looksLikeExportName(name) {
	if (BUILTIN_OR_EXTERNAL_SYMBOLS.has(name)) return false;
	return (
		/^[A-Z_][A-Za-z0-9_$]*$/.test(name) ||
		/^[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/.test(name)
	);
}

function readChangelogRemovedSymbols(exportedSymbols) {
	const removed = new Set();
	const packagesDir = join(ROOT, 'packages');

	for (const pkg of readdirSync(packagesDir)) {
		const changelog = join(packagesDir, pkg, 'CHANGELOG.md');
		if (!existsSync(changelog)) continue;
		const src = readFileSync(changelog, 'utf8');
		for (const match of src.matchAll(
			/(?:Removed from|From)\s+@dbsp\/[\w-]+:\s*([^.\n]*)/g,
		)) {
			for (const word of match[1].matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
				const symbol = word[0];
				if (looksLikeExportName(symbol) && !exportedSymbols.has(symbol)) {
					removed.add(symbol);
				}
			}
		}
	}

	return removed;
}

function stripFencedBlocks(src) {
	return src.replace(/^```[\w-]*[^\n]*\n[\s\S]*?^```/gm, '');
}

function extractTypeScriptBlocks(src) {
	const blocks = [];
	for (const match of src.matchAll(
		/^```(ts|typescript)[^\n]*\n([\s\S]*?)^```/gm,
	)) {
		blocks.push(match[2]);
	}
	return blocks;
}

function stripTypeScriptTrivia(code) {
	return code
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/.*$/gm, ' ')
		.replace(/'(?:\\.|[^'\\])*'/g, ' ')
		.replace(/"(?:\\.|[^"\\])*"/g, ' ')
		.replace(/`(?:\\.|[^`\\])*`/gs, ' ');
}

function parseNamedImports(named) {
	const imports = [];
	for (const rawItem of named.split(',')) {
		const item = rawItem.trim().replace(/^type\s+/, '');
		if (!item) continue;
		const aliasMatch = item.match(
			/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
		);
		if (aliasMatch) {
			imports.push({ imported: aliasMatch[1], local: aliasMatch[2] });
			continue;
		}
		const name = item.match(/^([A-Za-z_$][\w$]*)/)?.[1];
		if (name) imports.push({ imported: name, local: name });
	}
	return imports;
}

function parseImports(code) {
	const dbspImports = new Set();
	const externalLocals = new Set();
	const importPattern =
		/import\s+(?:type\s+)?(?:(?<defaultName>[A-Za-z_$][\w$]*)\s*,\s*)?(?:(?:\{(?<named>[\s\S]*?)\})|(?:\*\s+as\s+(?<namespaceName>[A-Za-z_$][\w$]*))|(?<bareDefault>[A-Za-z_$][\w$]*))\s+from\s+['"](?<source>[^'"]+)['"]/g;

	for (const match of code.matchAll(importPattern)) {
		const source = match.groups?.source ?? '';
		const isDbsp = source.startsWith('@dbsp/');
		const named = match.groups?.named;

		if (match.groups?.defaultName && !isDbsp) {
			externalLocals.add(match.groups.defaultName);
		}
		if (match.groups?.bareDefault && !isDbsp) {
			externalLocals.add(match.groups.bareDefault);
		}
		if (match.groups?.namespaceName && !isDbsp) {
			externalLocals.add(match.groups.namespaceName);
		}

		if (!named) continue;
		for (const spec of parseNamedImports(named)) {
			if (isDbsp) dbspImports.add(spec.imported);
			else externalLocals.add(spec.local);
		}
	}

	return { dbspImports, externalLocals };
}

function localDeclarations(code) {
	const locals = new Set();
	for (const match of code.matchAll(
		/\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
	)) {
		locals.add(match[1]);
	}
	return locals;
}

function findStaleSymbolsInTypeScript(code, staleSymbols) {
	const found = new Set();
	const { dbspImports, externalLocals } = parseImports(code);
	const cleaned = stripTypeScriptTrivia(code);
	const locals = localDeclarations(cleaned);

	for (const symbol of staleSymbols) {
		if (BUILTIN_OR_EXTERNAL_SYMBOLS.has(symbol)) continue;
		if (dbspImports.has(symbol)) {
			found.add(symbol);
			continue;
		}
		if (externalLocals.has(symbol) || locals.has(symbol)) continue;
		if (new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(cleaned)) {
			found.add(symbol);
		}
	}

	return found;
}

function inlineCodeSpans(src) {
	const spans = [];
	const prose = stripFencedBlocks(src);
	for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
		spans.push(match[1]);
	}
	return spans;
}

function inlineSpanTeachesSymbol(span, symbol) {
	const trimmed = span.trim();
	if (!trimmed) return false;
	if (/^import\s+/.test(trimmed) && trimmed.includes('@dbsp/')) {
		const { dbspImports } = parseImports(trimmed);
		return dbspImports.has(symbol);
	}

	const escaped = escapeRegExp(symbol);
	return new RegExp(
		`(?:^|[^A-Za-z0-9_$])${escaped}(?:\\s*(?:[<(]|$)|\\b)`,
	).test(trimmed);
}

function findStaleSymbolsInInlineCode(src, staleSymbols) {
	const found = new Set();
	for (const span of inlineCodeSpans(src)) {
		for (const symbol of staleSymbols) {
			if (
				!BUILTIN_OR_EXTERNAL_SYMBOLS.has(symbol) &&
				inlineSpanTeachesSymbol(span, symbol)
			) {
				found.add(symbol);
			}
		}
	}
	return found;
}

function findStaleSymbols(src, staleSymbols) {
	const found = new Set(findStaleSymbolsInInlineCode(src, staleSymbols));
	for (const block of extractTypeScriptBlocks(src)) {
		for (const symbol of findStaleSymbolsInTypeScript(block, staleSymbols)) {
			found.add(symbol);
		}
	}
	return found;
}

function normalizeLinkTarget(rawTarget) {
	let target = rawTarget.trim();
	if (target.startsWith('<') && target.endsWith('>')) {
		target = target.slice(1, -1).trim();
	}
	if (!target || target.startsWith('#')) return undefined;
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
		return undefined;
	}

	const withoutHash = target.split('#', 1)[0];
	const withoutQuery = withoutHash.split('?', 1)[0];
	if (!withoutQuery) return undefined;
	if (!withoutQuery.startsWith('.') && !withoutQuery.startsWith('/')) {
		return undefined;
	}
	return withoutQuery;
}

function linkCandidates(targetPath, rootRelativeTarget) {
	const candidates = [
		targetPath,
		`${targetPath}.md`,
		join(targetPath, 'index.md'),
	];
	if (rootRelativeTarget !== undefined) {
		const publicTarget = resolve(DOCS, 'public', rootRelativeTarget);
		candidates.push(
			publicTarget,
			`${publicTarget}.md`,
			join(publicTarget, 'index.md'),
		);
	}
	return candidates;
}

function checkLink(where, sourcePath, rawTarget, findings) {
	const target = normalizeLinkTarget(rawTarget);
	if (target === undefined) return;

	const rootRelativeTarget = target.startsWith('/')
		? target.replace(/^\/+/, '')
		: undefined;
	const resolvedTarget =
		rootRelativeTarget === undefined
			? resolve(dirname(sourcePath), target)
			: resolve(DOCS, rootRelativeTarget);

	if (
		!linkCandidates(resolvedTarget, rootRelativeTarget).some((candidate) =>
			existsSync(candidate),
		)
	) {
		findings.push(`${where} → dead link: ${rawTarget}`);
	}
}

function checkMarkdownLinks(page, src, findings) {
	const where = relative(ROOT, page);
	const prose = stripFencedBlocks(src);
	for (const match of prose.matchAll(
		/\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/g,
	)) {
		checkLink(where, page, match[1], findings);
	}
	for (const match of prose.matchAll(/\bhref\s*=\s*['"]([^'"]+)['"]/g)) {
		checkLink(where, page, match[1], findings);
	}
}

function checkVitePressConfigLinks(findings) {
	const config = join(DOCS, '.vitepress', 'config.ts');
	if (!existsSync(config)) return;
	const src = readFileSync(config, 'utf8');
	const where = relative(ROOT, config);
	for (const match of src.matchAll(/\blink\s*:\s*['"]([^'"]+)['"]/g)) {
		checkLink(where, config, match[1], findings);
	}
}

const findings = [];
const { exported, findings: exportFindings } = readPackageExports();
findings.push(...exportFindings);
const staleSymbols = readChangelogRemovedSymbols(exported);
const pages = markdownFiles(DOCS);

for (const page of pages) {
	const src = readFileSync(page, 'utf8');
	const where = relative(ROOT, page);

	// 1. Site-internal links that resolve to nothing. VitePress lets a broken
	//    link build and deploy perfectly happily; the reader finds it, not the build.
	checkMarkdownLinks(page, src, findings);

	// 2. Deleted exports taught as API. CHANGELOGs are exempt: naming what was
	//    removed is precisely their job.
	if (where.includes('CHANGELOG')) continue;
	for (const symbol of findStaleSymbols(src, staleSymbols)) {
		findings.push(`${where} → teaches a deleted API: ${symbol}`);
	}
}

checkVitePressConfigLinks(findings);

// A page whose only claims are prose has nothing that can contradict it. Not an
// error — a comparison table or a landing page has no business executing anything —
// but worth printing, because that is where a guide rots without anyone noticing.
const unverifiable = pages.filter(
	(p) => !/^```(ts|typescript)/m.test(readFileSync(p, 'utf8')),
);

if (findings.length > 0) {
	console.error(`\n✗ ${findings.length} problem(s) in the docs:\n`);
	for (const f of findings) console.error(`  ${f}`);
	console.error(
		'\nA dead link and a deleted API both survive a build and a deploy. Only this looks.\n',
	);
	process.exit(1);
}

console.log(`✓ docs: ${pages.length} pages, no dead links, no deleted APIs taught`);
console.log(
	`  (${staleSymbols.size} changelog-removed symbol(s) are absent from package exports and checked only in inline code / TypeScript fences.)`,
);
console.log(
	`  (${unverifiable.length} page(s) carry no executable block, so nothing can contradict them:`,
);
for (const p of unverifiable) console.log(`     ${relative(ROOT, p)}`);
console.log('   that is fine for a landing or comparison page — not for a guide.)');
