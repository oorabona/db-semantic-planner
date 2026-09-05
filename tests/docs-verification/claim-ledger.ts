import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doctestSourceFiles, looksLikeFragment } from './doc-sources.js';
import { extractBlocks } from './doctest.js';

export const BYPASS_KINDS = [
	'explicit-skip',
	'dry-run',
	'real-db-only',
	'heuristic-fragment',
] as const;

export type BypassKind = (typeof BYPASS_KINDS)[number];
export type BypassCounts = Record<BypassKind, number>;
export type ClaimKind = 'typescript-path' | 'method-mention';

export interface Claim {
	kind: ClaimKind;
	token: string;
	line: number;
}

export interface LedgerFile {
	file: string;
	fences: number;
	bypasses: BypassCounts;
	claims: Claim[];
}

export interface Ledger {
	files: LedgerFile[];
	totals: BypassCounts & { fences: number };
}

const MARKER = /^\s*\/\/\s*doctest:\s*(skip|dry-run|real-db-only)\b(.*)$/i;
const REASON = /^\s+—\s+\S/;

function emptyCounts(): BypassCounts {
	return {
		'explicit-skip': 0,
		'dry-run': 0,
		'real-db-only': 0,
		'heuristic-fragment': 0,
	};
}

/**
 * Finds direct claim-shaped tokens without resolving them. A future resolver
 * consumes this inventory; this pass intentionally records no correctness.
 */
function claimsIn(text: string): Claim[] {
	const claims: Claim[] = [];
	for (const [lineIndex, line] of text.split('\n').entries()) {
		for (const match of line.matchAll(/`([^`\n]*\.ts)`/g)) {
			claims.push({
				kind: 'typescript-path',
				token: match[1],
				line: lineIndex + 1,
			});
		}
		for (const match of line.matchAll(/`(\.[A-Za-z_$][\w$]*\(\))`/g)) {
			claims.push({
				kind: 'method-mention',
				token: match[1],
				line: lineIndex + 1,
			});
		}
	}
	return claims;
}

/** Scan precisely the markdown files that generate-tests.ts passes to extractBlocks. */
export function scanDocs(root: string): {
	ledger: Ledger;
	missingReasons: string[];
} {
	const files: LedgerFile[] = [];
	const missingReasons: string[] = [];
	const totals = { ...emptyCounts(), fences: 0 };

	for (const file of doctestSourceFiles(root)) {
		const absolute = join(root, file);
		const text = readFileSync(absolute, 'utf8');
		const bypasses = emptyCounts();
		const blocks = extractBlocks(absolute);
		for (const block of blocks) {
			const markerKinds: BypassKind[] = [];
			for (const [lineIndex, line] of block.code.split('\n').entries()) {
				const marker = line.match(MARKER);
				if (!marker) continue;
				const kind = marker[1].toLowerCase() as
					| 'skip'
					| 'dry-run'
					| 'real-db-only';
				const bypassKind = kind === 'skip' ? 'explicit-skip' : kind;
				markerKinds.push(bypassKind);
				if (!REASON.test(marker[2])) {
					missingReasons.push(
						`${file}:${block.line + lineIndex + 1} (${bypassKind})`,
					);
				}
			}
			for (const kind of new Set(markerKinds)) bypasses[kind] += 1;
			if (markerKinds.length === 0 && looksLikeFragment(block.code)) {
				bypasses['heuristic-fragment'] += 1;
			}
		}

		for (const kind of BYPASS_KINDS) totals[kind] += bypasses[kind];
		totals.fences += blocks.length;
		files.push({
			file,
			fences: blocks.length,
			bypasses,
			claims: claimsIn(text),
		});
	}

	return { ledger: { files, totals }, missingReasons };
}

export function inventory(ledger: Ledger) {
	const files = ledger.files.map(({ file, claims }) => ({
		file,
		claims: {
			'typescript-path': claims
				.filter((claim) => claim.kind === 'typescript-path')
				.map(({ token, line }) => ({ token, line })),
			'method-mention': claims
				.filter((claim) => claim.kind === 'method-mention')
				.map(({ token, line }) => ({ token, line })),
		},
	}));
	const totals = {
		'typescript-path': files.reduce(
			(count, file) => count + file.claims['typescript-path'].length,
			0,
		),
		'method-mention': files.reduce(
			(count, file) => count + file.claims['method-mention'].length,
			0,
		),
	};
	return {
		version: 1,
		description:
			'Direct documentation claim tokens. This inventory does not resolve, verify, or judge any claim.',
		totals,
		files,
	};
}
