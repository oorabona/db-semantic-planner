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

export interface LedgerFile {
	file: string;
	fences: number;
	bypasses: BypassCounts;
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
		const bypasses = emptyCounts();
		const blocks = extractBlocks(absolute);
		for (const block of blocks) {
			const markers: Array<{ kind: BypassKind; line: number }> = [];
			for (const [lineIndex, rawLine] of block.code
				.split(/\r\n?|\n/)
				.entries()) {
				// Keep marker recognition aligned with parseAnnotations(), including all line endings.
				const marker = rawLine.trim().match(MARKER);
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
				continue;
			}

			// extractBlocks has already made the generator's marker decision.
			if (block.annotations.skip) {
				bypasses['explicit-skip'] += 1;
			} else if (
				block.annotations.realDbOnly &&
				!looksLikeFragment(block.code)
			) {
				bypasses['real-db-only'] += 1;
			} else if (looksLikeFragment(block.code)) {
				bypasses['heuristic-fragment'] += 1;
			}
		}

		for (const kind of BYPASS_KINDS) totals[kind] += bypasses[kind];
		totals.fences += blocks.length;
		files.push({
			file,
			fences: blocks.length,
			bypasses,
		});
	}

	return { ledger: { files, totals }, missingReasons, markerConflicts };
}
