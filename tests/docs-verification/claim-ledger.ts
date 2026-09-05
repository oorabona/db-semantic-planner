import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doctestSourceFiles, looksLikeFragment } from './doc-sources.js';
import { extractBlocks } from './doctest.js';

export const BYPASS_KINDS = [
	'explicit-skip',
	'real-db-only',
	'heuristic-fragment',
] as const;

export type BypassKind = (typeof BYPASS_KINDS)[number];
export type BypassCounts = Record<BypassKind, number>;
export type ClaimKind = 'typescript-path' | 'method-mention';

export type Claim =
	| {
			kind: 'typescript-path';
			path: string;
			lineRange?: string;
			line: number;
	  }
	| {
			kind: 'method-mention';
			token: string;
			raw: string;
			line: number;
	  };

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

const MARKER = /^\s*\/\/\s*doctest:\s*(skip|real-db-only)\b(.*)$/i;
const EM_DASH_REASON = /^\s+—\s+(.+)$/;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const VISIBLE_REASON_CONTENT = /[\p{L}\p{N}]/u;

function emptyCounts(): BypassCounts {
	return {
		'explicit-skip': 0,
		'real-db-only': 0,
		'heuristic-fragment': 0,
	};
}

function hasReason(suffix: string): boolean {
	const match = suffix.match(EM_DASH_REASON);
	if (!match) return false;
	return VISIBLE_REASON_CONTENT.test(
		match[1].normalize('NFC').replace(DEFAULT_IGNORABLE, ''),
	);
}

function closingParen(text: string, open: number): number | undefined {
	let depth = 0;
	let quote: string | undefined;
	let escaped = false;
	for (let index = open; index < text.length; index++) {
		const character = text[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"' || character === '`') {
			quote = character;
			continue;
		}
		if (character === '(') depth += 1;
		if (character === ')') {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return undefined;
}

function rootBefore(text: string, dot: number): string | undefined {
	const expression = text
		.slice(0, dot)
		.match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/);
	return expression?.[1]?.split('.')[0];
}

const EXTERNAL_RECEIVERS = new Set(['db', 'prisma']);

/**
 * Record direct dbsp method mentions and chains. A leading `.method()` is a
 * documented builder-surface mention; an unfamiliar named receiver is kept so
 * the inventory never silently discards an undecidable claim. Known external
 * examples are excluded, and only a previously recorded call can extend them.
 */
function methodsIn(span: string, line: number): Claim[] {
	const claims: Claim[] = [];
	const recordedEnds = new Set<number>();
	const excludedEnds = new Set<number>();
	for (const match of span.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) {
		const dot = match.index ?? 0;
		const open = dot + match[0].lastIndexOf('(');
		const close = closingParen(span, open);
		if (close === undefined) continue;
		const root = rootBefore(span, dot);
		const continuesRecordedCall = recordedEnds.has(dot);
		if (
			excludedEnds.has(dot) ||
			(root && EXTERNAL_RECEIVERS.has(root) && !continuesRecordedCall)
		) {
			excludedEnds.add(close + 1);
			continue;
		}
		claims.push({
			kind: 'method-mention',
			token: `.${match[1]}()`,
			raw: span.slice(dot, close + 1),
			line,
		});
		recordedEnds.add(close + 1);
	}
	return claims;
}

/**
 * Finds direct claim-shaped tokens without resolving them. A future resolver
 * consumes this inventory; this pass intentionally records no correctness.
 */
function claimsIn(text: string): Claim[] {
	const claims: Claim[] = [];
	for (const [lineIndex, line] of text.split('\n').entries()) {
		for (const match of line.matchAll(
			/`([^`\n]*?\.ts)(?::(\d+(?:-\d+)?))?`/g,
		)) {
			claims.push({
				kind: 'typescript-path',
				path: match[1],
				...(match[2] === undefined ? {} : { lineRange: match[2] }),
				line: lineIndex + 1,
			});
		}
		for (const match of line.matchAll(/`([^`\n]+)`/g)) {
			claims.push(...methodsIn(match[1], lineIndex + 1));
		}
	}
	return claims;
}

/** Scan precisely the markdown files that generate-tests.ts passes to extractBlocks. */
export function scanDocs(root: string): {
	ledger: Ledger;
	missingReasons: string[];
	markerConflicts: string[];
} {
	const files: LedgerFile[] = [];
	const missingReasons: string[] = [];
	const markerConflicts: string[] = [];
	const totals = { ...emptyCounts(), fences: 0 };

	for (const file of doctestSourceFiles(root)) {
		const absolute = join(root, file);
		const text = readFileSync(absolute, 'utf8');
		const bypasses = emptyCounts();
		const blocks = extractBlocks(absolute);
		for (const block of blocks) {
			const markers: Array<{ kind: BypassKind; line: number }> = [];
			for (const [lineIndex, line] of block.code.split('\n').entries()) {
				const marker = line.match(MARKER);
				if (!marker) continue;
				const kind = marker[1].toLowerCase() as 'skip' | 'real-db-only';
				const bypassKind = kind === 'skip' ? 'explicit-skip' : kind;
				markers.push({
					kind: bypassKind,
					line: block.line + lineIndex + 1,
				});
				if (!hasReason(marker[2])) {
					missingReasons.push(
						`${file}:${block.line + lineIndex + 1} (${bypassKind})`,
					);
				}
			}
			const markerKinds = new Set(markers.map((marker) => marker.kind));
			if (markerKinds.size > 1) {
				markerConflicts.push(
					`${file}:${markers[0].line} has conflicting control markers: ${[...markerKinds].join(', ')}`,
				);
			} else {
				for (const kind of markerKinds) bypasses[kind] += 1;
			}
			if (markers.length === 0 && looksLikeFragment(block.code)) {
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

	return { ledger: { files, totals }, missingReasons, markerConflicts };
}

export function inventory(ledger: Ledger) {
	const files = ledger.files.map(({ file, claims }) => ({
		file,
		claims: {
			'typescript-path': claims
				.filter((claim) => claim.kind === 'typescript-path')
				.map((claim) => ({
					path: claim.path,
					...(claim.lineRange === undefined
						? {}
						: { lineRange: claim.lineRange }),
					line: claim.line,
				})),
			'method-mention': claims
				.filter((claim) => claim.kind === 'method-mention')
				.map((claim) => ({
					token: claim.token,
					raw: claim.raw,
					line: claim.line,
				})),
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
