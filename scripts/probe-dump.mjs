#!/usr/bin/env node
// schema exports may be objects or (core) => objects using core.ref().
// Compare built checkouts: node scripts/probe-dump.mjs <checkout-dir> <cases-module>
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function usage(message) {
	console.error(`probe-dump: ${message}`);
	process.exit(2);
}

const [checkout, casesPath, ...extra] = process.argv.slice(2);
if (!checkout) usage('missing <checkout-dir>');
if (!casesPath) usage('missing <cases-module>');
if (extra.length) usage('expected only <checkout-dir> <cases-module>');

const entries = ['core', 'adapter-pgsql'].map((name) => resolve(checkout, 'packages', name, 'dist', 'index.js'));
for (const entry of entries) {
	if (!existsSync(entry)) usage(`missing dist entry: ${entry}`);
}

let inputs;
try {
	inputs = await import(pathToFileURL(resolve(casesPath)).href);
} catch (error) {
	usage(`cannot load cases module ${casesPath}: ${error.message}`);
}
for (const name of ['schema', 'cases']) {
	if (!Object.hasOwn(inputs, name) || inputs[name] === null || (typeof inputs[name] !== 'object' && !(name === 'schema' && typeof inputs[name] === 'function')) || Array.isArray(inputs[name])) {
		usage(`missing or invalid ${name} export in ${casesPath} (expected an object)`);
	}
}

const core = await import(pathToFileURL(entries[0]).href);
const { createPgCompileOnlyAdapter } = await import(pathToFileURL(entries[1]).href);
const db = core.schema(typeof inputs.schema === 'function' ? inputs.schema(core) : inputs.schema);
const orm = core.createOrm({ schema: db, adapter: createPgCompileOnlyAdapter({ model: db.model }) });
for (const [name, build] of Object.entries(inputs.cases)) {
	try {
		const dump = build(orm, core).dump();
		console.log(JSON.stringify({ case: name, sql: dump.sql, params: dump.params ?? dump.parameters }));
	} catch (error) {
		console.log(JSON.stringify({ case: name, error: error instanceof Error ? error.message : String(error) }));
	}
}
