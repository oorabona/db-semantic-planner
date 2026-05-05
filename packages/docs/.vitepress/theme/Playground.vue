<script setup lang="ts">
/**
 * Playground orchestrator.
 *
 * Owns all stateful refs and the lifecycle. Sub-components in
 * theme/playground/ are presentational — they receive data via props and
 * signal user gestures via emits. Module-scope `let` state means this
 * component is single-instance per page; that is an accepted v1 limitation.
 * If a future requirement embeds the playground in guides, refactor the
 * `let` declarations into a `useState`-style composable.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Dump } from '@dbsp/core';

import ErrorBanner from './playground/ErrorBanner.vue';
import SchemaSection from './playground/SchemaSection.vue';
import QuerySection from './playground/QuerySection.vue';
import PlanSection from './playground/PlanSection.vue';
import OutputSection from './playground/OutputSection.vue';
import {
	decodeHash,
	encodeHash,
	isHashLengthOk,
} from './playground/hash-codec';
import type { ErrorBannerData } from './playground/types';

// ---------------------------------------------------------------------------
// Local interfaces (migrated from old Playground.vue)
// ---------------------------------------------------------------------------

interface ParsedColumn {
	name: string;
	type: string;
	nullable?: boolean;
	pk?: boolean;
	unique?: boolean;
	ref?: string;
	refNullable?: boolean;
	refUnique?: boolean;
	onDelete?: string;
	defaultValue?: string;
}

interface ParsedTable {
	name: string;
	columns: ParsedColumn[];
}

interface ParsedSchema {
	tables: ParsedTable[];
	relations: { from: string; fromCol: string; to: string }[];
}

// ---------------------------------------------------------------------------
// Default schema + examples (migrated verbatim from old Playground.vue)
// ---------------------------------------------------------------------------

const DEFAULT_SCHEMA_DSL = [
	'table users {',
	'  id: uuid pk',
	'  name: string',
	'  email: string unique',
	'  active: boolean',
	'  last_login: timestamp',
	'  created_at: timestamp',
	'}',
	'',
	'table posts {',
	'  id: uuid pk',
	'  title: string',
	'  content: text?',
	'  published: boolean',
	'  author_id: -> users',
	'  created_at: timestamp',
	'}',
	'',
	'table comments {',
	'  id: uuid pk',
	'  text: string',
	'  post_id: -> posts',
	'  author_id: -> users',
	'  created_at: timestamp',
	'}',
	'',
	'table orders {',
	'  id: uuid pk',
	'  user_id: -> users',
	'  status: string',
	'  amount: integer',
	'  created_at: timestamp',
	'}',
	'',
	'table products {',
	'  id: uuid pk',
	'  name: string',
	'  category: string',
	'  price: integer',
	'}',
].join('\n');

const ALL_EXAMPLES: ReadonlyArray<{ name: string; code: string; requires: readonly string[] }> = [
	{
		name: 'Simple query',
		code: 'users | where active = true | select id, name',
		requires: ['users'],
	},
	{
		name: 'With relations',
		code: 'posts | where published = true | select title, author.*',
		requires: ['posts'],
	},
	{
		name: 'Aggregation',
		code: 'orders | group by status | select status, count(*), sum(amount)',
		requires: ['orders'],
	},
	{
		name: 'Pagination',
		code: 'users | where active = true | order by created_at desc | limit 10 offset 20',
		requires: ['users'],
	},
	{
		name: 'Window function',
		code: 'products | select name, rank() over (partition by category order by price) as price_rank',
		requires: ['products'],
	},
	{
		name: 'Insert',
		code: "insert into users set name = 'Alice', email = 'alice@example.com'",
		requires: ['users'],
	},
	{
		name: 'Update',
		code: "update users set active = false where last_login < '2024-01-01'",
		requires: ['users'],
	},
];

interface NqlBuilder { dump(): Dump }
type NqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => NqlBuilder;

// ---------------------------------------------------------------------------
// Module-scope state (single-instance)
// ---------------------------------------------------------------------------

let coreModule: typeof import('@dbsp/core') | null = null;
let adapterModule: typeof import('@dbsp/adapter-pgsql') | null = null;
let mermaidInstance: typeof import('mermaid').default | null = null;
let nqlTag: NqlTag | null = null;
const nqlTagReady = ref(false);

let schemaDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let nqlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let hashWriteTimer: ReturnType<typeof setTimeout> | null = null;

let suppressNextNqlWatch = false;
let pendingManualCompile = false;
let rebuildGeneration = 0;
let lastEmittedHash: string | null = null;
let disposed = false;

// ---------------------------------------------------------------------------
// Reactive state (parent owns)
// ---------------------------------------------------------------------------

const schemaDsl = ref(DEFAULT_SCHEMA_DSL);
const schemaError = ref<string | null>(null);
const tableCount = ref(0);
const mermaidSvg = ref('');
const generatedTs = ref('');
const schemaExpanded = ref(false);

const nqlCode = ref(ALL_EXAMPLES[0]?.code ?? '');
const selectedExampleIndex = ref(0);
const queryMode = ref<'nql'>('nql'); // 'ts' lands in v2 with T3.

const result = ref<Dump | null>(null);
const compileError = ref<string | null>(null);

const errorBanner = ref<ErrorBannerData | null>(null);
const isInitializing = ref(true);
const initFatal = ref(false);

const tsCopied = ref(false);
let tsCopiedTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const visibleExamples = computed(() => {
	if (schemaError.value) return [];
	const tableNames = new Set<string>();
	for (const m of schemaDsl.value.matchAll(/^\s*table\s+(\w+)/gm)) {
		tableNames.add(m[1]);
	}
	return ALL_EXAMPLES.filter((ex) => ex.requires.every((t) => tableNames.has(t)));
});

const ready = computed(() => !disposed && nqlTagReady.value && !schemaError.value);

// ---------------------------------------------------------------------------
// Schema DSL parser (migrated verbatim from old Playground.vue)
// ---------------------------------------------------------------------------

function stripLineComments(text: string): string {
	return text
		.split('\n')
		.map((l) => l.replace(/\/\/.*/, ''))
		.join('\n');
}

function parseSchemaDsl(text: string): ParsedSchema {
	const tables: ParsedTable[] = [];
	const relations: { from: string; fromCol: string; to: string }[] = [];

	const stripped = stripLineComments(text);
	const tableMatches = [...stripped.matchAll(/table\s+(\w+)\s*\{([^}]*)\}/g)];

	for (const tMatch of tableMatches) {
		const tableName = tMatch[1];
		const body = tMatch[2];
		const columns: ParsedColumn[] = [];

		for (const rawLine of body.split('\n')) {
			const line = rawLine.trim();
			if (!line) continue;

			const colonIdx = line.indexOf(':');
			if (colonIdx === -1) continue;

			const colName = line.slice(0, colonIdx).trim();
			const rest = line.slice(colonIdx + 1).trim();
			const parts = rest.split(/\s+/);

			if (!colName || parts.length === 0) continue;

			let typeRaw = parts[0];
			const nullable = typeRaw.endsWith('?');
			if (nullable) typeRaw = typeRaw.slice(0, -1);
			const modifiers = parts.slice(1);

			// Parse default(value) modifier
			const defaultMatch = rest.match(/\bdefault\(([^)]*)\)/);
			const defaultValue = defaultMatch ? defaultMatch[1].trim() : undefined;

			const col: ParsedColumn = {
				name: colName,
				type: typeRaw,
				...(nullable ? { nullable: true } : {}),
				...(modifiers.includes('pk') ? { pk: true } : {}),
				...(modifiers.includes('unique') ? { unique: true } : {}),
				...(defaultValue !== undefined ? { defaultValue } : {}),
			};

			if (typeRaw === '->') {
				// Syntax: colName: -> target[?] [cascade] [unique]
				let targetRaw = parts[1] ?? '';
				const refNullable = targetRaw.endsWith('?');
				if (refNullable) targetRaw = targetRaw.slice(0, -1);
				if (targetRaw) {
					const refModifiers = parts.slice(2);
					col.type = 'uuid';
					col.ref = targetRaw;
					col.nullable = refNullable || col.nullable;
					if (refNullable) col.refNullable = true;
					if (refModifiers.includes('cascade')) col.onDelete = 'CASCADE';
					if (refModifiers.includes('unique')) col.refUnique = true;
					relations.push({ from: tableName, fromCol: colName, to: targetRaw });
				}
			} else {
				const arrowIdx = modifiers.indexOf('->');
				if (arrowIdx !== -1 && modifiers[arrowIdx + 1]) {
					let targetRaw = modifiers[arrowIdx + 1];
					const refNullable = targetRaw.endsWith('?');
					if (refNullable) targetRaw = targetRaw.slice(0, -1);
					const refModifiers = modifiers.slice(arrowIdx + 2);
					col.type = 'uuid';
					col.ref = targetRaw;
					if (refNullable) {
						col.refNullable = true;
						col.nullable = true;
					}
					if (refModifiers.includes('cascade')) col.onDelete = 'CASCADE';
					if (refModifiers.includes('unique')) col.refUnique = true;
					relations.push({ from: tableName, fromCol: colName, to: targetRaw });
				}
			}

			columns.push(col);
		}

		tables.push({ name: tableName, columns });
	}

	return { tables, relations };
}

// ---------------------------------------------------------------------------
// Schema-derived generators (migrated verbatim from old Playground.vue)
// ---------------------------------------------------------------------------

function buildSchemaFromParsed(parsed: ParsedSchema): unknown {
	const { schema, ref: dbRef } = coreModule!;
	const tableDefs: Record<string, Record<string, unknown>> = {};

	for (const table of parsed.tables) {
		const colDefs: Record<string, unknown> = {};
		for (const col of table.columns) {
			if (col.ref) {
				const refOpts: Record<string, unknown> = {};
				if (col.refNullable) refOpts.nullable = true;
				if (col.refUnique) refOpts.unique = true;
				if (col.onDelete) refOpts.onDelete = col.onDelete;
				colDefs[col.name] =
					Object.keys(refOpts).length > 0
						? dbRef(col.ref, refOpts)
						: dbRef(col.ref);
			} else {
				const def: Record<string, unknown> = { type: col.type };
				if (col.pk) def.primaryKey = true;
				if (col.nullable) def.nullable = true;
				if (col.unique) def.unique = true;
				if (col.defaultValue) def.default = col.defaultValue;
				colDefs[col.name] = Object.keys(def).length === 1 ? col.type : def;
			}
		}
		tableDefs[table.name] = colDefs;
	}

	return schema(tableDefs);
}

function generateTypeScript(parsed: ParsedSchema): string {
	const lines: string[] = [];
	lines.push("import { schema, ref } from '@dbsp/core';");
	lines.push('');
	lines.push('const db = schema({');

	for (const table of parsed.tables) {
		lines.push(`  ${table.name}: {`);
		for (const col of table.columns) {
			if (col.ref) {
				const opts: string[] = [];
				if (col.refNullable) opts.push('nullable: true');
				if (col.refUnique) opts.push('unique: true');
				if (col.onDelete) opts.push(`onDelete: '${col.onDelete}'`);
				const refCall =
					opts.length > 0
						? `ref('${col.ref}', { ${opts.join(', ')} })`
						: `ref('${col.ref}')`;
				lines.push(`    ${col.name}: ${refCall},`);
			} else {
				const extras: string[] = [];
				if (col.pk) extras.push('primaryKey: true');
				if (col.nullable) extras.push('nullable: true');
				if (col.unique) extras.push('unique: true');
				if (col.defaultValue) extras.push(`default: '${col.defaultValue}'`);
				if (extras.length > 0) {
					lines.push(
						'    ' +
							col.name +
							": { type: '" +
							col.type +
							"', " +
							extras.join(', ') +
							' },',
					);
				} else {
					lines.push(`    ${col.name}: '${col.type}',`);
				}
			}
		}
		lines.push('  },');
	}

	lines.push('});');
	return lines.join('\n');
}

function buildMermaidCode(parsed: ParsedSchema): string {
	const lines: string[] = ['erDiagram'];

	for (const table of parsed.tables) {
		lines.push(`    ${table.name} {`);
		for (const col of table.columns) {
			const type = col.type.replace(/[^a-zA-Z0-9_]/g, '_');
			const suffix = col.pk ? ' PK' : col.unique ? ' UK' : '';
			lines.push(`        ${type} ${col.name}${suffix}`);
		}
		lines.push('    }');
	}

	for (const rel of parsed.relations) {
		lines.push(`    ${rel.to} ||--o{ ${rel.from} : ""`);
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Compile flow
// ---------------------------------------------------------------------------

function performCompile(opts: { resetTab: boolean }) {
	if (!nqlTag) {
		compileError.value = schemaError.value
			? `Schema error: ${schemaError.value}`
			: 'Compiler not ready — please wait a moment and try again.';
		result.value = null;
		return;
	}
	const query = nqlCode.value.trim();
	if (!query) {
		compileError.value = 'Please enter an NQL query.';
		result.value = null;
		return;
	}
	try {
		const builder = nqlTag`${query}`;
		result.value = builder.dump();
		compileError.value = null;
		void opts; // resetTab reserved for future TS-mode wiring.
	} catch (e) {
		compileError.value = e instanceof Error ? e.message : String(e);
		result.value = null;
	}
}

function compile() {
	if (nqlDebounceTimer !== null) {
		clearTimeout(nqlDebounceTimer);
		nqlDebounceTimer = null;
	}
	if (schemaDebounceTimer !== null) {
		pendingManualCompile = true;
		return;
	}
	performCompile({ resetTab: true });
}

// ---------------------------------------------------------------------------
// Schema rebuild
// ---------------------------------------------------------------------------

async function rebuildOrm(dsl: string): Promise<void> {
	if (!coreModule || !adapterModule) return;
	const myGen = ++rebuildGeneration;
	schemaError.value = null;

	let parsed: ParsedSchema;
	try {
		parsed = parseSchemaDsl(dsl);
	} catch (e) {
		if (myGen !== rebuildGeneration || disposed) return;
		schemaError.value = e instanceof Error ? e.message : String(e);
		tableCount.value = 0;
		mermaidSvg.value = '';
		generatedTs.value = '';
		nqlTag = null;
		nqlTagReady.value = false;
		return;
	}

	if (parsed.tables.length === 0) {
		if (myGen !== rebuildGeneration || disposed) return;
		schemaError.value = 'No tables defined';
		tableCount.value = 0;
		mermaidSvg.value = '';
		generatedTs.value = '';
		nqlTag = null;
		nqlTagReady.value = false;
		return;
	}

	if (myGen !== rebuildGeneration || disposed) return;
	tableCount.value = parsed.tables.length;
	generatedTs.value = generateTypeScript(parsed);

	try {
		const builtSchema = buildSchemaFromParsed(parsed);
		const orm = coreModule.createOrm({
			schema: builtSchema,
			adapter: adapterModule.createPgsqlCompileOnlyAdapter(),
		});
		nqlTag = orm.nql as NqlTag;
		nqlTagReady.value = true;
	} catch (e) {
		if (myGen !== rebuildGeneration || disposed) return;
		schemaError.value = `Schema error: ${e instanceof Error ? e.message : String(e)}`;
		nqlTag = null;
		nqlTagReady.value = false;
		return;
	}

	if (schemaExpanded.value) {
		await ensureMermaid();
		await renderDiagram(parsed, myGen);
	}
}

async function ensureMermaid() {
	if (mermaidInstance) return;
	const m = await import('mermaid');
	if (disposed) return;
	mermaidInstance = m.default;
	mermaidInstance.initialize({
		startOnLoad: false,
		theme: 'dark',
		er: { diagramPadding: 20, layoutDirection: 'TB', minEntityWidth: 100 },
	});
}

async function renderDiagram(parsed: ParsedSchema, gen: number): Promise<void> {
	if (!mermaidInstance) return;
	try {
		const code = buildMermaidCode(parsed);
		const id = `er-${gen}-${Date.now()}`;
		const { svg } = await mermaidInstance.render(id, code);
		if (gen !== rebuildGeneration || disposed) return;
		mermaidSvg.value = svg;
	} catch {
		if (gen !== rebuildGeneration || disposed) return;
		mermaidSvg.value = '';
	}
}

// ---------------------------------------------------------------------------
// URL hash sync
// ---------------------------------------------------------------------------

async function syncUrlHash() {
	if (disposed) return;
	if (!('CompressionStream' in window)) return;
	try {
		const encoded = await encodeHash({
			v: 1,
			s: schemaDsl.value,
			n: nqlCode.value,
			m: 'nql',
		});
		const nextHash = '#' + encoded;
		if (!isHashLengthOk(encoded)) {
			if (errorBanner.value?.title !== 'URL sharing paused') {
				showOversizeBanner();
			}
			return;
		}
		if (nextHash === lastEmittedHash) return;
		lastEmittedHash = nextHash;
		const nextUrl = window.location.pathname + window.location.search + nextHash;
		history.replaceState(history.state ?? {}, '', nextUrl);
	} catch {
		// Encoding failed (validation rejected). Schema error already surfaces.
	}
}

function scheduleHashSync() {
	if (hashWriteTimer !== null) clearTimeout(hashWriteTimer);
	hashWriteTimer = setTimeout(() => {
		hashWriteTimer = null;
		void syncUrlHash();
	}, 500);
}

function clearHashFromUrl() {
	const nextUrl = window.location.pathname + window.location.search;
	history.replaceState(history.state ?? {}, '', nextUrl);
	lastEmittedHash = null;
}

// ---------------------------------------------------------------------------
// Banner factories
// ---------------------------------------------------------------------------

function showVersionBanner(reason: 'version' | 'unknown'): void {
	errorBanner.value = {
		severity: 'warn',
		title: reason === 'version'
			? 'Shared link from a newer version'
			: "Couldn't restore the shared link",
		message: reason === 'version'
			? "This link uses a version of the playground hash format that isn't supported here. Loaded the default state."
			: 'The URL hash is corrupt, oversized, or contains unsupported content. Loaded the default playground instead.',
		actions: [
			{ label: 'Reset URL', handler: () => softResetUrl() },
			{ label: 'Got it', handler: () => (errorBanner.value = null) },
		],
	};
}

function showNoCompressionStreamBanner(): void {
	errorBanner.value = {
		severity: 'warn',
		title: "Couldn't restore the shared link",
		message: 'This link needs CompressionStream (Firefox 113+, Safari 16.4+, Chrome 80+). Loaded the default state.',
		actions: [
			{ label: 'Reset URL', handler: () => softResetUrl() },
			{ label: 'Got it', handler: () => (errorBanner.value = null) },
		],
	};
}

function showOversizeBanner(): void {
	errorBanner.value = {
		severity: 'warn',
		title: 'URL sharing paused',
		message: 'The current playground state is too large to share via URL. The page still works locally; URL sharing will resume when state shrinks below the limit.',
		actions: [
			{ label: 'Got it', handler: () => (errorBanner.value = null) },
		],
	};
}

function showFatalBanner(error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	initFatal.value = true;
	errorBanner.value = {
		severity: 'fatal',
		title: "Couldn't load the playground",
		message: `A network issue prevented the playground modules from loading. (${detail})`,
		actions: [
			{ label: 'Reload', handler: () => window.location.reload() },
			{ label: 'Reset URL', handler: () => window.location.assign(window.location.pathname + window.location.search) },
		],
	};
}

function softResetUrl(): void {
	clearHashFromUrl();
	schemaDsl.value = DEFAULT_SCHEMA_DSL;
	selectedExampleIndex.value = 0;
	suppressNextNqlWatch = true;
	nqlCode.value = ALL_EXAMPLES[0]?.code ?? '';
	queryMode.value = 'nql';
	errorBanner.value = null;
	void rebuildOrm(schemaDsl.value).then(() => {
		if (!disposed && ready.value) compile();
	});
}

// ---------------------------------------------------------------------------
// Init flow
// ---------------------------------------------------------------------------

async function runInitFlow(): Promise<void> {
	isInitializing.value = true;

	if (window.location.hash) {
		const decoded = await decodeHash(window.location.hash);
		if (disposed) return;
		if (decoded.ok) {
			schemaDsl.value = decoded.payload.s;
			nqlCode.value = decoded.payload.n;
			queryMode.value = decoded.payload.m;
			lastEmittedHash = window.location.hash;
		} else if (decoded.reason === 'no-compression-stream') {
			showNoCompressionStreamBanner();
		} else if (decoded.reason === 'version') {
			showVersionBanner('version');
		} else if (
			decoded.reason === 'decode-error' ||
			decoded.reason === 'shape' ||
			decoded.reason === 'size' ||
			decoded.reason === 'identifier'
		) {
			showVersionBanner('unknown');
		}
	}

	try {
		const [core, adapter] = await Promise.all([
			import('@dbsp/core'),
			import('@dbsp/adapter-pgsql'),
		]);
		if (disposed) return;
		coreModule = core;
		adapterModule = adapter;
	} catch (e) {
		if (disposed) return;
		showFatalBanner(e);
		isInitializing.value = false;
		return;
	}

	await rebuildOrm(schemaDsl.value);
	if (disposed) return;

	if (!schemaError.value && nqlTag && nqlCode.value.trim()) {
		if (nqlDebounceTimer !== null) {
			clearTimeout(nqlDebounceTimer);
			nqlDebounceTimer = null;
		}
		performCompile({ resetTab: false });
	}

	isInitializing.value = false;
}

async function onHashChange() {
	if (disposed) return;
	if (window.location.hash === lastEmittedHash) return;
	if (nqlDebounceTimer !== null) clearTimeout(nqlDebounceTimer);
	nqlDebounceTimer = null;
	if (schemaDebounceTimer !== null) clearTimeout(schemaDebounceTimer);
	schemaDebounceTimer = null;
	rebuildGeneration += 1;
	pendingManualCompile = false;
	errorBanner.value = null;
	await runInitFlow();
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

watch(schemaDsl, (newDsl) => {
	if (schemaDebounceTimer !== null) clearTimeout(schemaDebounceTimer);
	const myTimer: ReturnType<typeof setTimeout> = setTimeout(async () => {
		await rebuildOrm(newDsl);
		if (schemaDebounceTimer !== myTimer || disposed) return;
		schemaDebounceTimer = null;
		if (pendingManualCompile) {
			pendingManualCompile = false;
			performCompile({ resetTab: true });
		} else if (nqlCode.value.trim()) {
			performCompile({ resetTab: false });
		}
		scheduleHashSync();
	}, 500);
	schemaDebounceTimer = myTimer;
});

watch(nqlCode, () => {
	if (suppressNextNqlWatch) {
		suppressNextNqlWatch = false;
		return;
	}
	if (nqlDebounceTimer !== null) clearTimeout(nqlDebounceTimer);
	nqlDebounceTimer = setTimeout(() => {
		nqlDebounceTimer = null;
		if (schemaDebounceTimer !== null) return;
		performCompile({ resetTab: false });
		scheduleHashSync();
	}, 300);
});

watch(schemaExpanded, async (expanded) => {
	if (expanded && !mermaidInstance) {
		await ensureMermaid();
		if (!disposed) {
			try {
				const parsed = parseSchemaDsl(schemaDsl.value);
				const myGen = ++rebuildGeneration;
				await renderDiagram(parsed, myGen);
			} catch {
				/* schema error already surfaced */
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Sub-component event handlers
// ---------------------------------------------------------------------------

function onLoadExample(index: number): void {
	const ex = visibleExamples.value[index];
	if (!ex) return;
	selectedExampleIndex.value = index;
	if (nqlCode.value !== ex.code) {
		suppressNextNqlWatch = true;
		nqlCode.value = ex.code;
	}
	compile();
}

async function onCopyTs() {
	await navigator.clipboard.writeText(generatedTs.value);
	tsCopied.value = true;
	if (tsCopiedTimer !== null) clearTimeout(tsCopiedTimer);
	tsCopiedTimer = setTimeout(() => {
		tsCopied.value = false;
		tsCopiedTimer = null;
	}, 2000);
}

watch(generatedTs, () => {
	if (tsCopiedTimer !== null) clearTimeout(tsCopiedTimer);
	tsCopiedTimer = null;
	tsCopied.value = false;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
	disposed = false;
	await runInitFlow();
	if (!disposed) {
		window.addEventListener('hashchange', onHashChange);
	}
});

onBeforeUnmount(() => {
	disposed = true;
	window.removeEventListener('hashchange', onHashChange);
	if (schemaDebounceTimer !== null) clearTimeout(schemaDebounceTimer);
	if (nqlDebounceTimer !== null) clearTimeout(nqlDebounceTimer);
	if (hashWriteTimer !== null) clearTimeout(hashWriteTimer);
	if (tsCopiedTimer !== null) clearTimeout(tsCopiedTimer);
	rebuildGeneration += 1;
	pendingManualCompile = false;
	suppressNextNqlWatch = false;
	nqlTag = null;
	nqlTagReady.value = false;
});
</script>

<template>
  <div class="playground" :aria-busy="isInitializing">
    <ErrorBanner :data="errorBanner" @dismiss="errorBanner = null" />

    <SchemaSection
      :dsl="schemaDsl"
      :table-count="tableCount"
      :mermaid-svg="mermaidSvg"
      :generated-ts="generatedTs"
      :schema-error="schemaError"
      :expanded="schemaExpanded"
      @update:dsl="schemaDsl = $event"
      @update:expanded="schemaExpanded = $event"
      @reset="softResetUrl"
      @copy-ts="onCopyTs"
    />

    <QuerySection
      :nql-code="nqlCode"
      :query-mode="queryMode"
      :examples="visibleExamples"
      :selected-example-index="selectedExampleIndex"
      :ready="ready"
      @update:nql-code="nqlCode = $event"
      @update:selected-example-index="onLoadExample"
      @compile="compile"
    />

    <div v-if="!initFatal" class="playground-output">
      <div v-if="isInitializing" class="output-skeleton" aria-live="polite">
        <span>Loading playground…</span>
      </div>
      <div v-else-if="compileError" class="output-error" role="alert">
        <pre>{{ compileError }}</pre>
      </div>
      <template v-else-if="result">
        <PlanSection :result="result" />
        <OutputSection :result="result" />
      </template>
      <div v-else class="output-placeholder">
        <span>Click "Compile" to see the output.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playground {
  margin: var(--dbsp-space-xl, 1.5rem) 0;
  padding: var(--dbsp-space-md, 0.75rem);
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: var(--dbsp-radius-lg, 12px);
  background: var(--vp-c-bg-soft);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}

.output-skeleton {
  position: relative;
  min-height: 200px;
  border-radius: var(--dbsp-radius-md, 8px);
  background: linear-gradient(
    90deg,
    var(--vp-c-bg-soft) 0%,
    var(--vp-c-bg) 50%,
    var(--vp-c-bg-soft) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-3);
  font-size: 0.85rem;
}

@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.output-error {
  background: color-mix(in srgb, var(--dbsp-c-error) 8%, transparent);
  border-left: 3px solid var(--dbsp-c-error);
  border-radius: var(--dbsp-radius-sm, 4px);
  padding: var(--dbsp-space-md, 0.75rem);
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  color: var(--dbsp-c-error);
  white-space: pre-wrap;
}

.output-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
  font-size: 0.85rem;
  min-height: 200px;
  padding: var(--dbsp-space-md, 0.75rem);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
}
</style>
