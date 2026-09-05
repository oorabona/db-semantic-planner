#!/usr/bin/env tsx
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BYPASS_KINDS, type BypassCounts, scanDocs } from './claim-ledger.js';

const arguments_ = process.argv.slice(2);
const rootArgument = arguments_.find((argument) => !argument.startsWith('--'));
const ROOT = resolve(
	rootArgument ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
);
const BASELINE = resolve(
	ROOT,
	'tests/docs-verification/bypass-ledger-baseline.json',
);
const writeBaseline = arguments_.includes('--write-baseline');
const failures: string[] = [];

let ledger: ReturnType<typeof scanDocs>['ledger'];
let missingReasons: string[];
let markerConflicts: string[];
try {
	({ ledger, missingReasons, markerConflicts } = scanDocs(ROOT));
} catch (error) {
	const cause = error instanceof Error ? error.message : String(error);
	console.error(`docs ledger: ${cause}`);
	process.exit(1);
}

function writeAtomically(destination: string, contents: string): void {
	const temporary = resolve(
		dirname(destination),
		`.${basename(destination)}.${process.pid}.${Date.now()}.tmp`,
	);
	let operation = 'write temporary file';
	try {
		writeFileSync(temporary, contents);
		operation = 'rename temporary file';
		renameSync(temporary, destination);
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Preserve the write failure as the actionable diagnostic.
		}
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot ${operation} for ${destination}: ${cause}`);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function validateBaseline(
	value: unknown,
):
	| { valid: true; files: Record<string, BypassCounts> }
	| { valid: false; reason: string } {
	if (!isPlainObject(value))
		return { valid: false, reason: 'must be a plain object' };
	if (value.version !== 1)
		return { valid: false, reason: 'version must be exactly 1' };
	if (!isPlainObject(value.files))
		return { valid: false, reason: 'files must be a plain object' };
	for (const [file, counts] of Object.entries(value.files)) {
		if (!isPlainObject(counts))
			return { valid: false, reason: `${file} must be a plain object` };
		for (const [kind, count] of Object.entries(counts)) {
			if (!(BYPASS_KINDS as readonly string[]).includes(kind))
				return { valid: false, reason: `${file} has unknown kind ${kind}` };
			if (!Number.isSafeInteger(count) || count < 0)
				return {
					valid: false,
					reason: `${file}.${kind} must be a non-negative integer`,
				};
		}
		for (const kind of BYPASS_KINDS) {
			if (!(kind in counts))
				return { valid: false, reason: `${file} has no ${kind} count` };
		}
	}
	return { valid: true, files: value.files as Record<string, BypassCounts> };
}

if (missingReasons.length > 0) {
	for (const location of missingReasons) {
		failures.push(
			`bypass marker has no reason after an em dash at ${location}`,
		);
	}
}
for (const conflict of markerConflicts) {
	failures.push(`conflicting control markers: ${conflict}`);
}

if (!writeBaseline) {
	let baseline: unknown;
	try {
		baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
	} catch (error) {
		failures.push(
			`cannot read baseline ${BASELINE}: ${error instanceof Error ? error.message : String(error)}`,
		);
		baseline = undefined;
	}
	const validated = validateBaseline(baseline);
	if (!validated.valid) {
		failures.push(`baseline schema is invalid: ${validated.reason}`);
	} else {
		for (const entry of ledger.files) {
			const expected = validated.files[entry.file];
			if (expected === undefined) {
				failures.push(`${entry.file}: baseline has no per-file entry`);
				continue;
			}
			for (const kind of BYPASS_KINDS) {
				if (entry.bypasses[kind] !== expected[kind]) {
					failures.push(
						`${entry.file}: ${kind} baseline ${expected[kind]}, actual ${entry.bypasses[kind]}`,
					);
				}
			}
		}
		for (const file of Object.keys(validated.files)) {
			if (!ledger.files.some((entry) => entry.file === file))
				failures.push(
					`${file}: baseline names a file outside the doctest source list`,
				);
		}
	}
}

// A failed scan or malformed baseline must never rewrite the committed artifact.
// Replacement happens only after every guard has run.
if (failures.length === 0) {
	if (writeBaseline) {
		const files = Object.fromEntries(
			ledger.files.map(({ file, bypasses }) => [file, bypasses]),
		);
		try {
			writeAtomically(
				BASELINE,
				`${JSON.stringify({ version: 1, files }, null, '\t')}\n`,
			);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
}

for (const entry of ledger.files) {
	const counts = BYPASS_KINDS.map((kind) => {
		const label = kind === 'real-db-only' ? 'deferred real-db-only' : kind;
		return `${label}=${entry.bypasses[kind]}`;
	}).join(', ');
	console.log(`docs ledger: ${entry.file}: fences=${entry.fences}; ${counts}`);
}
console.log(
	`docs ledger: ${ledger.files.length} files, ${ledger.totals.fences} fences; explicit-skip=${ledger.totals['explicit-skip']}, heuristic-fragment=${ledger.totals['heuristic-fragment']}, deferred real-db-only=${ledger.totals['real-db-only']}.`,
);

if (failures.length > 0) {
	for (const failure of failures) console.error(`docs ledger: ${failure}`);
	process.exit(1);
}
