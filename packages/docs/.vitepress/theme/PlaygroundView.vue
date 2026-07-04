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

import type { Dump } from '@dbsp/core';
import { useData } from 'vitepress';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import ErrorBanner from './playground/ErrorBanner.vue';
import { generateBuilderTs } from './playground/generate-builder-ts';
import {
	decodeHash,
	encodeHash,
	isHashLengthOk,
} from './playground/hash-codec';
import OutputSection from './playground/OutputSection.vue';
import PlanSection from './playground/PlanSection.vue';
import QuerySection from './playground/QuerySection.vue';
import SchemaSection from './playground/SchemaSection.vue';
import {
	buildMermaidCode,
	buildSchemaFromParsed,
	generateTypeScript,
	type ParsedSchema,
	type ParseWarning,
	parseSchemaDsl,
} from './playground/schema-dsl';
import type { ErrorBannerData } from './playground/types';

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
	'',
	'table order_items {',
	'  id: uuid pk',
	'  order_id: -> orders',
	'  product_id: -> products',
	'  quantity: integer',
	'}',
].join('\n');

const ALL_EXAMPLES: ReadonlyArray<{
	name: string;
	code: string;
	requires: readonly string[];
}> = [
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
		code: 'users | where active = true | order by created_at desc | limit 10 | offset 20',
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
	{
		name: 'M-N relation',
		code: 'order_items | select product.name, product.price, quantity, order.status',
		requires: ['order_items'],
	},
	{
		name: 'Top products sold',
		code: 'order_items | group by product_id | select product.name, sum(quantity) as total_sold | order by total_sold desc',
		requires: ['order_items'],
	},
];

interface NqlBuilder {
	dump(): Dump;
	toIntentIR(): import('@dbsp/core').QueryIntent;
}
type NqlTag = (
	strings: TemplateStringsArray,
	...values: unknown[]
) => NqlBuilder;

// ---------------------------------------------------------------------------
// VitePress theme integration
// ---------------------------------------------------------------------------

const { isDark } = useData();

// ---------------------------------------------------------------------------
// Module-scope state (single-instance)
// ---------------------------------------------------------------------------

let coreModule: typeof import('@dbsp/core') | null = null;
let adapterModule: typeof import('@dbsp/adapter-pgsql') | null = null;
let mermaidInstance: typeof import('mermaid').default | null = null;
let mermaidThemeDirty = false;
let nqlTag: NqlTag | null = null;
const nqlTagReady = ref(false);

let schemaDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let nqlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let hashWriteTimer: ReturnType<typeof setTimeout> | null = null;

let suppressNextNqlWatch = false;
let isHydrating = false;
let pendingManualCompile = false;
let rebuildGeneration = 0;
let lastEmittedHash: string | null = null;
let disposed = false;
// True only once rebuildOrm() has actually built + createOrm()'d the
// CURRENT schema successfully. The panel-expand and theme-toggle watchers
// re-parse+render the diagram independently of rebuildOrm — gating their
// render call on this flag stops them from drawing a diagram for a schema
// that parses but FAILED to build (self-ref without roles, duplicate FK
// targets, ...), which rebuildOrm's own error path already surfaces as an
// error with mermaidSvg cleared.
let lastSchemaBuildOk = false;
// The exact banner OBJECT INSTANCE currently shown for schema-parser
// warnings, if any — a plain boolean flag isn't bound to which banner is
// actually displayed (a later unrelated banner — oversize URL, shared-link
// restore failure, fatal load — would silently desync it), so clearing
// logic instead compares this reference against errorBanner.value by
// IDENTITY and only ever touches errorBanner.value when they match.
let currentSchemaWarningsBanner: ErrorBannerData | null = null;

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
const generatedBuilderTs = ref('');

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
	return ALL_EXAMPLES.filter((ex) =>
		ex.requires.every((t) => tableNames.has(t)),
	);
});

const ready = computed(
	() => !disposed && nqlTagReady.value && !schemaError.value,
);

const hasChanges = computed(
	() =>
		schemaDsl.value !== DEFAULT_SCHEMA_DSL ||
		nqlCode.value !== (ALL_EXAMPLES[0]?.code ?? ''),
);

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
		// Generate the builder TS preview from the IntentAST
		try {
			const intent = builder.toIntentIR();
			generatedBuilderTs.value = generateBuilderTs(intent);
		} catch (e) {
			generatedBuilderTs.value =
				'// Could not generate builder TS for this query.\n' +
				`// Reason: ${e instanceof Error ? e.message : String(e)}`;
		}
	} catch (e) {
		compileError.value = e instanceof Error ? e.message : String(e);
		result.value = null;
		generatedBuilderTs.value = '';
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
	lastSchemaBuildOk = false;

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
		clearSchemaWarningsBanner();
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
		clearSchemaWarningsBanner();
		return;
	}

	if (myGen !== rebuildGeneration || disposed) return;

	// Derived UI state (table count, generated TS, diagram) and the
	// warnings banner are published ONLY after the schema has ACTUALLY
	// built successfully below — a core-invalid schema (a self-ref without
	// `roles`, multiple FKs to the same target, ...) parses fine but fails
	// schema()/createOrm(), and publishing this state beforehand left it
	// stale (or, for the diagram, carried over from a PREVIOUS successful
	// build) sitting next to the fatal error.
	try {
		const builtSchema = buildSchemaFromParsed(parsed, coreModule);
		const orm = coreModule.createOrm({
			schema: builtSchema,
			adapter: adapterModule.createPgsqlCompileOnlyAdapter(),
		});
		nqlTag = orm.nql as NqlTag;
		nqlTagReady.value = true;
	} catch (e) {
		if (myGen !== rebuildGeneration || disposed) return;
		schemaError.value = `Schema error: ${e instanceof Error ? e.message : String(e)}`;
		tableCount.value = 0;
		generatedTs.value = '';
		mermaidSvg.value = '';
		nqlTag = null;
		nqlTagReady.value = false;
		clearSchemaWarningsBanner();
		return;
	}

	if (myGen !== rebuildGeneration || disposed) return;
	lastSchemaBuildOk = true;
	tableCount.value = parsed.tables.length;
	generatedTs.value = generateTypeScript(parsed);

	if (parsed.warnings.length > 0) {
		showSchemaWarningsBanner(parsed.warnings);
	} else {
		clearSchemaWarningsBanner();
	}

	if (schemaExpanded.value) {
		await ensureMermaid();
		await renderDiagram(parsed, myGen);
	}
}

function getMermaidThemeVariables(dark: boolean): Record<string, string> {
	if (dark) {
		return {
			primaryColor: '#1b1b1f',
			primaryTextColor: '#dfdfd6',
			primaryBorderColor: '#a8b1ff',
			lineColor: '#dfdfd6',
			textColor: '#dfdfd6',
			nodeBkg: '#1b1b1f',
		};
	}
	return {
		primaryColor: '#ffffff',
		primaryTextColor: '#1a1a1a',
		primaryBorderColor: '#3451b2',
		lineColor: '#1a1a1a',
		textColor: '#1a1a1a',
		nodeBkg: '#ffffff',
	};
}

async function ensureMermaid() {
	if (mermaidInstance) return;
	const m = await import('mermaid');
	if (disposed) return;
	mermaidInstance = m.default;
	mermaidInstance.initialize({
		startOnLoad: false,
		theme: 'base',
		themeVariables: getMermaidThemeVariables(isDark.value),
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
		const nextHash = `#${encoded}`;
		if (!isHashLengthOk(encoded)) {
			if (errorBanner.value?.title !== 'URL sharing paused') {
				showOversizeBanner();
			}
			return;
		}
		if (nextHash === lastEmittedHash) return;
		lastEmittedHash = nextHash;
		const nextUrl =
			window.location.pathname + window.location.search + nextHash;
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
		title:
			reason === 'version'
				? 'Shared link from a newer version'
				: "Couldn't restore the shared link",
		message:
			reason === 'version'
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
		message:
			'This link needs CompressionStream (Firefox 113+, Safari 16.4+, Chrome 80+). Loaded the default state.',
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
		message:
			'The current playground state is too large to share via URL. The page still works locally; URL sharing will resume when state shrinks below the limit.',
		actions: [{ label: 'Got it', handler: () => (errorBanner.value = null) }],
	};
}

/**
 * Surfaces non-fatal parser warnings (e.g. `pk`/`default` ignored on a
 * foreign-key column) — called only AFTER the schema has actually built
 * successfully (see rebuildOrm): showing it right after parse, before
 * schema()/createOrm() are known to succeed, risked a stale warning
 * banner sitting alongside — or getting clobbered by — a later fatal
 * build error. 'warn' severity, distinct from schemaError (which blocks
 * compilation).
 */
function showSchemaWarningsBanner(warnings: readonly ParseWarning[]): void {
	const lines = warnings.map((w) => {
		const where = w.table
			? `${w.table}${w.column ? `.${w.column}` : ''}: `
			: '';
		return `${where}${w.message}`;
	});
	const banner: ErrorBannerData = {
		severity: 'warn',
		title:
			warnings.length === 1
				? 'Schema warning'
				: `${warnings.length} schema warnings`,
		// KNOWN LIMITATION (deferred, not restyled here): multiple warnings
		// are joined with '\n', but ErrorBanner.vue renders `message` in a
		// plain <p> with no whitespace-preserving CSS (white-space: pre-line
		// or similar) — the newlines currently collapse visually, running
		// all warnings together on one line for anything beyond a single
		// warning. TODO: either preserve whitespace in ErrorBanner.vue's
		// `.error-banner-message` style, or render `message` as a list when
		// there's more than one warning.
		message: lines.join('\n'),
		actions: [
			{
				label: 'Got it',
				handler: () => {
					if (errorBanner.value === currentSchemaWarningsBanner) {
						errorBanner.value = null;
					}
					currentSchemaWarningsBanner = null;
				},
			},
		],
	};
	currentSchemaWarningsBanner = banner;
	errorBanner.value = banner;
}

/**
 * Clears the schema-warnings banner — but ONLY if it's still the banner
 * actually shown (errorBanner.value may have since been replaced by an
 * unrelated banner — oversize URL, shared-link restore failure, fatal
 * load — via referential identity, never a boolean flag that could desync
 * from what's really on screen).
 */
function clearSchemaWarningsBanner(): void {
	if (errorBanner.value === currentSchemaWarningsBanner) {
		errorBanner.value = null;
	}
	currentSchemaWarningsBanner = null;
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
			{
				label: 'Reset URL',
				handler: () =>
					window.location.assign(
						window.location.pathname + window.location.search,
					),
			},
		],
	};
}

function softResetUrl(): void {
	isHydrating = true;
	try {
		clearHashFromUrl();
		schemaDsl.value = DEFAULT_SCHEMA_DSL;
		selectedExampleIndex.value = 0;
		suppressNextNqlWatch = true;
		nqlCode.value = ALL_EXAMPLES[0]?.code ?? '';
		queryMode.value = 'nql';
		errorBanner.value = null;
	} finally {
		isHydrating = false;
	}
	void rebuildOrm(schemaDsl.value).then(() => {
		if (!disposed && ready.value) compile();
	});
}

// ---------------------------------------------------------------------------
// Init flow
// ---------------------------------------------------------------------------

async function runInitFlow(): Promise<void> {
	isInitializing.value = true;
	isHydrating = true;
	try {
		await _runInitFlowInner();
	} finally {
		isHydrating = false;
	}
}

function applyDefaults(): void {
	schemaDsl.value = DEFAULT_SCHEMA_DSL;
	nqlCode.value = ALL_EXAMPLES[0]?.code ?? '';
	selectedExampleIndex.value = 0;
	queryMode.value = 'nql';
	lastEmittedHash = null;
}

async function _runInitFlowInner(): Promise<void> {
	if (window.location.hash) {
		const decoded = await decodeHash(window.location.hash);
		if (disposed) return;
		if (decoded.ok) {
			schemaDsl.value = decoded.payload.s;
			nqlCode.value = decoded.payload.n;
			queryMode.value = decoded.payload.m;
			lastEmittedHash = window.location.hash;
		} else if (decoded.reason === 'no-compression-stream') {
			applyDefaults();
			showNoCompressionStreamBanner();
		} else if (decoded.reason === 'version') {
			applyDefaults();
			showVersionBanner('version');
		} else if (
			decoded.reason === 'decode-error' ||
			decoded.reason === 'shape' ||
			decoded.reason === 'size' ||
			decoded.reason === 'identifier'
		) {
			applyDefaults();
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
	if (isHydrating) return;
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
	if (isHydrating) return;
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
	if (!expanded) return;
	if (!mermaidInstance) {
		await ensureMermaid();
	} else if (mermaidThemeDirty) {
		// Theme changed while panel was collapsed — re-initialize with current theme
		mermaidInstance.initialize({
			startOnLoad: false,
			theme: 'base',
			themeVariables: getMermaidThemeVariables(isDark.value),
			er: { diagramPadding: 20, layoutDirection: 'TB', minEntityWidth: 100 },
		});
		mermaidThemeDirty = false;
	}
	// Only re-render for a schema that actually BUILT — re-parsing here
	// doesn't re-validate against schema()/createOrm(), so without this
	// guard, expanding the panel while the current DSL fails to build
	// would draw a diagram for a schema rebuildOrm() already reported as
	// broken (and already cleared mermaidSvg for).
	if (!disposed && lastSchemaBuildOk) {
		try {
			const parsed = parseSchemaDsl(schemaDsl.value);
			const myGen = ++rebuildGeneration;
			await renderDiagram(parsed, myGen);
		} catch {
			/* schema error already surfaced */
		}
	}
});

watch(isDark, async (dark) => {
	if (!mermaidInstance) return;
	mermaidInstance.initialize({
		startOnLoad: false,
		theme: 'base',
		themeVariables: getMermaidThemeVariables(dark),
		er: { diagramPadding: 20, layoutDirection: 'TB', minEntityWidth: 100 },
	});
	// Re-render the diagram with the new theme if the schema panel is open
	// AND the current DSL actually built successfully (same guard as the
	// schemaExpanded watcher above — re-parsing alone doesn't confirm the
	// schema builds); otherwise mark the theme as dirty so the
	// schemaExpanded watcher re-initializes it when the panel next expands.
	if (schemaExpanded.value && lastSchemaBuildOk) {
		try {
			const parsed = parseSchemaDsl(schemaDsl.value);
			const myGen = ++rebuildGeneration;
			await renderDiagram(parsed, myGen);
		} catch {
			/* schema error already surfaced */
		}
	} else if (!schemaExpanded.value) {
		mermaidThemeDirty = true;
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
	try {
		await navigator.clipboard.writeText(generatedTs.value);
	} catch (e) {
		console.warn('Playground: clipboard write failed', e);
		return;
	}
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
      :has-changes="hasChanges"
      @update:dsl="schemaDsl = $event"
      @update:expanded="schemaExpanded = $event"
      @reset="softResetUrl"
      @copy-ts="onCopyTs"
    />

    <QuerySection
      :nql-code="nqlCode"
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
        <OutputSection :result="result" :generated-builder-ts="generatedBuilderTs" />
      </template>
      <div v-else class="output-placeholder">
        <span>Click "Compile" to see the output.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playground {
  margin: var(--dbsp-space-2xl, 2rem) 0;
  padding: var(--dbsp-space-xl, 1.5rem);
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
