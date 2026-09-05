#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	BYPASS_KINDS,
	type BypassCounts,
	inventory,
	scanDocs,
} from './claim-ledger.js';

const arguments_ = process.argv.slice(2);
const rootArgument = arguments_.find((argument) => !argument.startsWith('--'));
const ROOT = resolve(
	rootArgument ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
);
const BASELINE = resolve(
	ROOT,
	'tests/docs-verification/bypass-ledger-baseline.json',
);
const INVENTORY = resolve(ROOT, 'tests/docs-verification/claim-inventory.json');
const writeBaseline = arguments_.includes('--write-baseline');
const writeInventory = arguments_.includes('--write-inventory');
const { ledger, missingReasons } = scanDocs(ROOT);
const renderedInventory = `${JSON.stringify(inventory(ledger), null, '\t')}\n`;
const failures: string[] = [];

if (missingReasons.length > 0) {
	for (const location of missingReasons) {
		failures.push(
			`bypass marker has no reason after an em dash at ${location}`,
		);
	}
}

if (writeBaseline) {
	const files = Object.fromEntries(
		ledger.files.map(({ file, bypasses }) => [file, bypasses]),
	);
	writeFileSync(
		BASELINE,
		`${JSON.stringify({ version: 1, files }, null, '\t')}\n`,
	);
} else {
	let baseline: {
		version?: unknown;
		files?: Record<string, Partial<BypassCounts>>;
	};
	try {
		baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
	} catch (error) {
		failures.push(
			`cannot read baseline ${BASELINE}: ${error instanceof Error ? error.message : String(error)}`,
		);
		baseline = {};
	}
	for (const entry of ledger.files) {
		const expected = baseline.files?.[entry.file];
		if (expected === undefined) {
			failures.push(`${entry.file}: baseline has no per-file entry`);
			continue;
		}
		for (const kind of BYPASS_KINDS) {
			if (typeof expected[kind] !== 'number') {
				failures.push(`${entry.file}: baseline has no ${kind} count`);
				continue;
			}
			if (entry.bypasses[kind] > expected[kind]) {
				failures.push(
					`${entry.file}: ${kind} baseline ${expected[kind]}, actual ${entry.bypasses[kind]}`,
				);
			}
			if (entry.bypasses[kind] < expected[kind]) {
				console.log(
					`docs ledger: ${entry.file}: ${kind} is below baseline (${entry.bypasses[kind]} < ${expected[kind]}); lower the baseline.`,
				);
			}
		}
	}
	for (const file of Object.keys(baseline.files ?? {})) {
		if (!ledger.files.some((entry) => entry.file === file))
			failures.push(
				`${file}: baseline names a file outside the doctest source list`,
			);
	}
}

if (writeInventory) {
	writeFileSync(INVENTORY, renderedInventory);
} else {
	try {
		if (readFileSync(INVENTORY, 'utf8') !== renderedInventory) {
			failures.push(
				`claim inventory differs from ${INVENTORY}; run pnpm generate:docs-claim-inventory`,
			);
		}
	} catch (error) {
		failures.push(
			`cannot read claim inventory ${INVENTORY}: ${error instanceof Error ? error.message : String(error)}`,
		);
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
	`docs ledger: ${ledger.files.length} files, ${ledger.totals.fences} fences; explicit-skip=${ledger.totals['explicit-skip']}, dry-run=${ledger.totals['dry-run']}, heuristic-fragment=${ledger.totals['heuristic-fragment']}, deferred real-db-only=${ledger.totals['real-db-only']}.`,
);
const claims = inventory(ledger).totals;
console.log(
	`claim inventory: ${claims['typescript-path']} typescript-path tokens and ${claims['method-mention']} method-mention tokens in ${INVENTORY}. Claims are recorded, not resolved.`,
);

if (failures.length > 0) {
	for (const failure of failures) console.error(`docs ledger: ${failure}`);
	process.exit(1);
}
