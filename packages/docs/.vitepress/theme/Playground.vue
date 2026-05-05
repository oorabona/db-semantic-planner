<template>
  <div class="playground">
    <!-- Section 1: Schema (collapsible) -->
    <div class="section-header" @click="schemaOpen = !schemaOpen">
      <span class="section-toggle">{{ schemaOpen ? '▾' : '▸' }}</span>
      <span class="section-title">Schema</span>
      <span v-if="schemaError" class="schema-status error">Parse error</span>
      <span v-else-if="tableCount > 0" class="schema-status ok">{{ tableCount }} tables</span>
    </div>

    <div v-show="schemaOpen" class="schema-panels">
      <div class="schema-editor">
        <textarea
          v-model="schemaDsl"
          class="schema-textarea"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          placeholder="Define your schema..."
          aria-label="Schema definition (custom DSL)"
        />
      </div>
      <div class="schema-output">
        <div class="schema-tabs">
          <button class="tab-btn" :class="{ active: schemaTab === 'diagram' }" @click="schemaTab = 'diagram'">Diagram</button>
          <button class="tab-btn" :class="{ active: schemaTab === 'typescript' }" @click="schemaTab = 'typescript'">TypeScript</button>
          <button v-if="schemaTab === 'typescript'" class="copy-btn" @click="copyTypeScript">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>

        <div v-if="schemaError" class="diagram-error">
          <pre>{{ schemaError }}</pre>
        </div>

        <template v-else-if="schemaTab === 'diagram'">
          <div
            v-if="mermaidSvg"
            class="mermaid-viewport"
            @wheel.prevent="onDiagramWheel"
            @mousedown="onDiagramDragStart"
            @mousemove="onDiagramDrag"
            @mouseup="onDiagramDragEnd"
            @mouseleave="onDiagramDragEnd"
          >
            <div class="mermaid-canvas" :style="diagramTransform" v-html="mermaidSvg" />
            <div class="zoom-controls">
              <button class="zoom-btn" @click="diagramZoom = Math.min(3, diagramZoom + 0.2)" title="Zoom in">+</button>
              <button class="zoom-btn" @click="diagramZoom = Math.max(0.3, diagramZoom - 0.2)" title="Zoom out">-</button>
              <button class="zoom-btn" @click="resetDiagramView" title="Reset view">R</button>
            </div>
          </div>
          <div v-else class="diagram-placeholder">Rendering diagram...</div>
        </template>

        <template v-else>
          <pre class="generated-pre"><code v-html="highlightTS(generatedTs)"></code></pre>
        </template>
      </div>
    </div>

    <!-- Section 2: Query (always visible) -->
    <div class="section-header query-section-header">
      <span class="section-title">Query</span>
    </div>

    <div class="query-panels">
      <div class="playground-input">
        <div class="panel-header">
          <label for="example-select" class="panel-label">Example</label>
          <select
            id="example-select"
            v-model="selectedExampleIndex"
            class="example-select"
            @change="loadExample"
          >
            <option v-for="(ex, i) in visibleExamples" :key="i" :value="i">
              {{ ex.name }}
            </option>
          </select>
        </div>
        <textarea
          v-model="nqlCode"
          class="nql-textarea"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          placeholder="Enter NQL query..."
          aria-label="NQL query"
          @keydown.ctrl.enter.prevent="compile"
          @keydown.meta.enter.prevent="compile"
        />
        <div class="compile-row">
          <button class="compile-btn" @click="compile">Compile</button>
          <span class="hint">Ctrl+Enter / Cmd+Enter</span>
        </div>
      </div>

      <div class="playground-output">
        <div class="tabs" role="group" aria-label="Query output format">
          <button
            v-for="tab in tabs"
            :key="tab"
            class="tab-btn"
            :class="{ active: activeTab === tab }"
            type="button"
            @click="activeTab = tab"
          >
            {{ tab }}
          </button>
        </div>

        <div v-if="error" class="output-error">
          <pre>{{ error }}</pre>
        </div>

        <div v-else-if="result" class="output-content">
          <div v-if="activeTab === 'SQL'" class="output-pane">
            <button
              type="button"
              class="copy-btn output-copy-btn"
              aria-label="Copy SQL to clipboard"
              @click="copySQL"
            >
              {{ sqlCopied ? 'Copied' : 'Copy' }}
            </button>
            <pre><code v-html="highlightSQL(result.sql)"></code></pre>
          </div>
          <div v-else-if="activeTab === 'Parameters'" class="output-pane">
            <button
              type="button"
              class="copy-btn output-copy-btn"
              aria-label="Copy parameters to clipboard"
              @click="copyParams"
            >
              {{ paramsCopied ? 'Copied' : 'Copy' }}
            </button>
            <pre><code>{{ formatParams(result.params) }}</code></pre>
          </div>
          <div v-else-if="activeTab === 'Plan'" class="plan-pane">
            <div class="plan-meta">
              <span v-if="planMeta.planningTimeMs !== undefined" class="plan-meta-item">
                <span class="plan-meta-label">Planned in</span>
                <span class="plan-meta-value">{{ planMeta.planningTimeMs.toFixed(2) }}ms</span>
              </span>
              <span v-if="planMeta.relationsAnalyzed !== undefined" class="plan-meta-item">
                <span class="plan-meta-label">Relations</span>
                <span class="plan-meta-value">{{ planMeta.relationsAnalyzed }}</span>
              </span>
              <span v-if="planMeta.isAmbiguous" class="plan-meta-item plan-meta-warn">
                Ambiguous plan
              </span>
            </div>

            <div v-if="planWarnings.length > 0" class="plan-warnings">
              <div class="plan-section-title">Warnings ({{ planWarnings.length }})</div>
              <div
                v-for="(w, i) in planWarnings"
                :key="i"
                class="plan-warning-card"
              >
                <div class="plan-warning-code">{{ w.code }}</div>
                <div class="plan-warning-message">{{ w.message }}</div>
                <div v-if="w.suggestion" class="plan-warning-suggestion">
                  → {{ w.suggestion }}
                </div>
              </div>
            </div>

            <div v-if="planDecisions.length > 0" class="plan-decisions">
              <div class="plan-section-title">
                Decisions ({{ planDecisions.length }})
              </div>
              <div
                v-for="d in planDecisions"
                :key="d.id"
                class="plan-decision-card"
                :class="`plan-decision-card--${d.type}`"
              >
                <button
                  type="button"
                  class="plan-decision-header"
                  :aria-expanded="isDecisionExpanded(d.id)"
                  @click="toggleDecision(d.id)"
                >
                  <span class="plan-decision-type">
                    {{ formatDecisionType(d.type) }}
                  </span>
                  <span class="plan-decision-context">
                    {{ formatDecisionContext(d.context) }}
                  </span>
                  <span class="plan-decision-choice">{{ d.choice }}</span>
                  <span
                    class="plan-decision-chevron"
                    :class="{ open: isDecisionExpanded(d.id) }"
                    aria-hidden="true"
                  >▸</span>
                </button>
                <div v-if="isDecisionExpanded(d.id)" class="plan-decision-body">
                  <div class="plan-decision-row">
                    <span class="plan-decision-label">Reasoning</span>
                    <span class="plan-decision-value">{{ d.reasoning }}</span>
                  </div>
                  <div v-if="d.alternatives.length > 0" class="plan-decision-row">
                    <span class="plan-decision-label">Alternatives considered</span>
                    <ul class="plan-decision-alternatives">
                      <li v-for="(alt, j) in d.alternatives" :key="j">{{ alt }}</li>
                    </ul>
                  </div>
                  <div v-if="d.joinType" class="plan-decision-row">
                    <span class="plan-decision-label">Join type</span>
                    <span class="plan-decision-value">{{ d.joinType }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div
              v-else-if="planWarnings.length === 0"
              class="plan-empty"
            >
              <span>No planning decisions for this query.</span>
            </div>
          </div>
        </div>

        <div v-else class="output-placeholder">
          <span>Click "Compile" to see the output.</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanDecision {
	readonly id: string;
	readonly type: string;
	readonly context: {
		readonly sourceTable: string;
		readonly target?: string;
		readonly relation?: string;
		readonly relationType?: string;
		readonly intentPath?: string;
		readonly relationPath?: string;
		readonly includeAlias?: string;
		readonly foreignKey?: string | readonly string[];
		readonly isSelfRef?: boolean;
	};
	readonly choice: string;
	readonly joinType?: 'inner' | 'left';
	readonly reasoning: string;
	readonly alternatives: readonly string[];
}

interface PlanWarning {
	readonly code: string;
	readonly message: string;
	readonly suggestion?: string;
	readonly relatedDecision?: string;
}

interface PlanReport {
	readonly rootTable?: string;
	readonly decisions: readonly PlanDecision[];
	readonly warnings: readonly PlanWarning[];
	readonly metadata?: {
		readonly planningTimeMs?: number;
		readonly relationsAnalyzed?: number;
		readonly isAmbiguous?: boolean;
	};
}

interface CompileResult {
	sql: string;
	params: readonly unknown[];
	plan: PlanReport;
}

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
// Default schema DSL
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

// ---------------------------------------------------------------------------
// Schema DSL parser
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
// Mermaid ER generation
// ---------------------------------------------------------------------------

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
// NQL tag type
// ---------------------------------------------------------------------------

type NqlTag = (
	strings: TemplateStringsArray,
	...values: unknown[]
) => { dump(): CompileResult };

// ---------------------------------------------------------------------------
// All examples (filtered by available tables)
// ---------------------------------------------------------------------------

const ALL_EXAMPLES = [
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

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const tabs = ['SQL', 'Parameters', 'Plan'] as const;
type Tab = (typeof tabs)[number];

const schemaOpen = ref(true);
const schemaTab = ref<'diagram' | 'typescript'>('diagram');
const schemaDsl = ref(DEFAULT_SCHEMA_DSL);
const schemaError = ref<string | null>(null);
const mermaidSvg = ref<string>('');
const tableCount = ref(0);

// Diagram pan/zoom state
const diagramZoom = ref(1);
const diagramPanX = ref(0);
const diagramPanY = ref(0);
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let panStartX = 0;
let panStartY = 0;

const diagramTransform = computed(() => ({
	transform:
		'translate(' +
		diagramPanX.value +
		'px, ' +
		diagramPanY.value +
		'px) scale(' +
		diagramZoom.value +
		')',
	transformOrigin: 'center center',
	cursor: isDragging ? 'grabbing' : 'grab',
}));

function onDiagramWheel(e: WheelEvent) {
	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	diagramZoom.value = Math.max(0.3, Math.min(3, diagramZoom.value + delta));
}

function onDiagramDragStart(e: MouseEvent) {
	isDragging = true;
	dragStartX = e.clientX;
	dragStartY = e.clientY;
	panStartX = diagramPanX.value;
	panStartY = diagramPanY.value;
}

function onDiagramDrag(e: MouseEvent) {
	if (!isDragging) return;
	diagramPanX.value = panStartX + (e.clientX - dragStartX);
	diagramPanY.value = panStartY + (e.clientY - dragStartY);
}

function onDiagramDragEnd() {
	isDragging = false;
}

function resetDiagramView() {
	diagramZoom.value = 1;
	diagramPanX.value = 0;
	diagramPanY.value = 0;
}

const selectedExampleIndex = ref(0);
const nqlCode = ref(ALL_EXAMPLES[0].code);
const activeTab = ref<Tab>('SQL');
const result = ref<CompileResult | null>(null);
const error = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Computed: visible examples based on available tables
// ---------------------------------------------------------------------------

const availableTableNames = computed<Set<string>>(() => {
	if (schemaError.value) return new Set<string>();
	try {
		const parsed = parseSchemaDsl(schemaDsl.value);
		return new Set(parsed.tables.map((t) => t.name));
	} catch {
		return new Set<string>();
	}
});

const visibleExamples = computed(() => {
	const names = availableTableNames.value;
	return ALL_EXAMPLES.filter((ex) => ex.requires.every((t) => names.has(t)));
});

// ---------------------------------------------------------------------------
// Module references (populated on mount)
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: dynamic import reference
let coreModule: any = null;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import reference
let adapterModule: any = null;
// biome-ignore lint/suspicious/noExplicitAny: mermaid dynamic import
let mermaidInstance: any = null;
let nqlTag: NqlTag | null = null;

let schemaDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let nqlDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Schema rebuild logic
// ---------------------------------------------------------------------------

function buildSchemaFromParsed(parsed: ParsedSchema): unknown {
	const { schema, ref: dbRef } = coreModule;
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

async function renderDiagram(parsed: ParsedSchema): Promise<void> {
	if (!mermaidInstance) return;
	try {
		const code = buildMermaidCode(parsed);
		const id = `er-${Date.now()}`;
		const { svg } = await mermaidInstance.render(id, code);
		mermaidSvg.value = svg;
	} catch {
		mermaidSvg.value = '';
	}
}

async function rebuildOrm(dsl: string): Promise<void> {
	if (!coreModule || !adapterModule) return;

	schemaError.value = null;

	let parsed: ParsedSchema;
	try {
		parsed = parseSchemaDsl(dsl);
	} catch (e) {
		schemaError.value = e instanceof Error ? e.message : String(e);
		tableCount.value = 0;
		mermaidSvg.value = '';
		nqlTag = null;
		return;
	}

	if (parsed.tables.length === 0) {
		schemaError.value = 'No tables defined';
		tableCount.value = 0;
		mermaidSvg.value = '';
		nqlTag = null;
		return;
	}

	tableCount.value = parsed.tables.length;
	generatedTs.value = generateTypeScript(parsed);

	try {
		const builtSchema = buildSchemaFromParsed(parsed);
		const orm = coreModule.createOrm({
			schema: builtSchema,
			adapter: adapterModule.createPgsqlCompileOnlyAdapter(),
		});
		nqlTag = orm.nql as NqlTag;
	} catch (e) {
		schemaError.value = `Schema error: ${e instanceof Error ? e.message : String(e)}`;
		nqlTag = null;
	}

	await renderDiagram(parsed);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

onMounted(async () => {
	try {
		const [core, adapter, mermaidLib] = await Promise.all([
			import('@dbsp/core'),
			import('@dbsp/adapter-pgsql'),
			import('mermaid'),
		]);

		coreModule = core;
		adapterModule = adapter;

		mermaidLib.default.initialize({
			startOnLoad: false,
			theme: 'dark',
			er: { diagramPadding: 20, layoutDirection: 'TB', minEntityWidth: 100 },
		});
		mermaidInstance = mermaidLib.default;

		await rebuildOrm(schemaDsl.value);
	} catch (e) {
		error.value = `Initialization error: ${e instanceof Error ? e.message : String(e)}`;
	}
});

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

watch(schemaDsl, (newDsl) => {
	if (schemaDebounceTimer !== null) clearTimeout(schemaDebounceTimer);
	schemaDebounceTimer = setTimeout(() => {
		rebuildOrm(newDsl);
		schemaDebounceTimer = null;
	}, 500);
});

// Auto-compile on NQL textarea change. Preserves activeTab (no reset) so the
// user can stay on Plan tab while iterating. Manual button + Ctrl/Cmd+Enter
// + example dropdown keep the reset-to-SQL behaviour.
watch(nqlCode, () => {
	if (nqlDebounceTimer !== null) clearTimeout(nqlDebounceTimer);
	nqlDebounceTimer = setTimeout(() => {
		performCompile({ resetTab: false });
		nqlDebounceTimer = null;
	}, 300);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function loadExample(): void {
	const ex = visibleExamples.value[selectedExampleIndex.value];
	if (ex) {
		nqlCode.value = ex.code;
		// Manual semantics: jump to SQL tab on example change. The nqlCode watcher
		// will also fire 300ms later but that auto-compile is idempotent.
		compile();
	}
}

function performCompile(opts: { resetTab: boolean }): void {
	if (!nqlTag) {
		error.value = schemaError.value
			? `Schema error: ${schemaError.value}`
			: 'Compiler not ready — please wait a moment and try again.';
		result.value = null;
		return;
	}

	const query = nqlCode.value.trim();
	if (!query) {
		error.value = 'Please enter an NQL query.';
		result.value = null;
		return;
	}

	try {
		const builder = nqlTag`${query}`;
		result.value = builder.dump();
		error.value = null;
		if (opts.resetTab) activeTab.value = 'SQL';
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
		result.value = null;
	}
}

function compile(): void {
	performCompile({ resetTab: true });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatParams(params: readonly unknown[]): string {
	if (params.length === 0) return '(no parameters)';
	return params.map((p, i) => `${i + 1}: ${JSON.stringify(p)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Plan tab — structured rendering
// ---------------------------------------------------------------------------

const planDecisions = computed<readonly PlanDecision[]>(
	() => result.value?.plan.decisions ?? [],
);
const planWarnings = computed<readonly PlanWarning[]>(
	() => result.value?.plan.warnings ?? [],
);
const planMeta = computed<NonNullable<PlanReport['metadata']>>(
	() => result.value?.plan.metadata ?? {},
);

const expandedDecisions = ref<Set<string>>(new Set());

// Default-expand every decision when the plan changes so the explainability
// is visible at first glance. Users can collapse what they don't need.
watch(planDecisions, (decisions) => {
	expandedDecisions.value = new Set(decisions.map((d) => d.id));
});

function isDecisionExpanded(id: string): boolean {
	return expandedDecisions.value.has(id);
}

function toggleDecision(id: string): void {
	const next = new Set(expandedDecisions.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expandedDecisions.value = next;
}

function formatDecisionType(type: string): string {
	return type.replace(/-/g, ' ').toUpperCase();
}

function formatDecisionContext(ctx: PlanDecision['context']): string {
	const parts: string[] = [ctx.sourceTable];
	const target = ctx.relation ?? ctx.target;
	if (target) parts.push(`→ ${target}`);
	return parts.join(' ');
}

// SQL_KEYWORDS regex — kept as a variable to avoid repeating the long pattern
const SQL_KEYWORDS = new RegExp(
	'\\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|LATERAL|ON|AND|OR|NOT|IN|EXISTS|AS' +
		'|ORDER\\s+BY|GROUP\\s+BY|HAVING|LIMIT|OFFSET|INSERT\\s+INTO|VALUES|UPDATE|SET|DELETE|RETURNING' +
		'|WITH|RECURSIVE|UNION|ALL|INTERSECT|EXCEPT|DISTINCT|CASE|WHEN|THEN|ELSE|END' +
		'|IS|NULL|TRUE|FALSE|ASC|DESC|BETWEEN|LIKE|ILIKE|CAST|OVER|PARTITION\\s+BY' +
		'|CONFLICT|DO|NOTHING|FETCH|FIRST|NEXT|ROWS|ONLY|FOR|SHARE|SKIP|LOCKED|NOWAIT)\\b',
	'g',
);

function highlightSQL(sql: string): string {
	const escaped = sql
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return (
		escaped
			.replace(/("(?:[^"\\]|\\.)*")/g, '\x00IDENT$1\x00')
			.replace(SQL_KEYWORDS, '<span class="sql-kw">$1</span>')
			.replace(/(\$\d+)/g, '<span class="sql-param">$1</span>')
			// biome-ignore lint/suspicious/noControlCharactersInRegex: \x00 sentinel removal — matches the insertion two lines above
			.replace(/\x00IDENT(.*?)\x00/g, '<span class="sql-ident">$1</span>')
	);
}

// ---------------------------------------------------------------------------
// TypeScript code generation
// ---------------------------------------------------------------------------

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

function highlightTS(code: string): string {
	const escaped = code
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return escaped
		.replace(
			/\b(import|from|const|true|false)\b/g,
			'<span class="ts-kw">$1</span>',
		)
		.replace(/(schema|ref|createOrm)\b/g, '<span class="ts-fn">$1</span>')
		.replace(/('(?:[^'\\]|\\.)*')/g, '<span class="ts-str">$1</span>');
}

// ---------------------------------------------------------------------------
// Generated TypeScript reactive state
// ---------------------------------------------------------------------------

const generatedTs = ref('');
const copied = ref(false);
const sqlCopied = ref(false);
const paramsCopied = ref(false);

async function copyTypeScript() {
	await navigator.clipboard.writeText(generatedTs.value);
	copied.value = true;
	setTimeout(() => {
		copied.value = false;
	}, 2000);
}

async function copySQL(): Promise<void> {
	if (!result.value) return;
	await navigator.clipboard.writeText(result.value.sql);
	sqlCopied.value = true;
	setTimeout(() => {
		sqlCopied.value = false;
	}, 2000);
}

async function copyParams(): Promise<void> {
	if (!result.value) return;
	await navigator.clipboard.writeText(formatParams(result.value.params));
	paramsCopied.value = true;
	setTimeout(() => {
		paramsCopied.value = false;
	}, 2000);
}
</script>

<style scoped>
/* ============================================================
   Container
   ============================================================ */
.playground {
  margin: var(--dbsp-space-xl) 0;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: var(--dbsp-radius-lg);
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
  background: var(--vp-c-bg-soft);
}

/* ============================================================
   Section headers
   ============================================================ */
.section-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 1rem;
  background: var(--vp-c-bg);
  background-image: linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(34, 211, 238, 0.04) 100%);
  border-bottom: 1px solid var(--vp-c-divider);
  cursor: pointer;
  user-select: none;
}

.section-header.query-section-header {
  cursor: default;
  border-top: 1px solid var(--vp-c-divider);
}

.section-toggle {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  line-height: 1;
  width: 12px;
  text-align: center;
}

.section-title {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--vp-c-text-2);
}

.schema-status {
  font-size: 0.72rem;
  font-family: var(--vp-font-family-mono);
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
}

.schema-status.ok {
  background: rgba(34, 197, 94, 0.12);
  color: #4ade80;
}

.schema-status.error {
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
}

/* ============================================================
   Schema panels (two-column)
   ============================================================ */
.schema-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 320px;
  overflow: hidden;
  border-bottom: 1px solid var(--vp-c-divider);
}

@media (max-width: 900px) {
  .schema-panels {
    grid-template-columns: 1fr;
    height: auto;
    max-height: 500px;
  }

  .schema-editor {
    border-right: none;
    border-bottom: 1px solid var(--vp-c-divider);
  }
}

.schema-editor {
  border-right: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.schema-textarea {
  flex: 1;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.65;
  padding: 1rem;
  min-height: 0;
  height: 100%;
  caret-color: var(--vp-c-brand-1);
  overflow-y: auto;
}

.schema-textarea:focus {
  box-shadow: inset 0 0 0 2px rgba(99, 102, 241, 0.25);
}

.schema-textarea::placeholder {
  color: var(--vp-c-text-3);
}

/* ============================================================
   Mermaid diagram
   ============================================================ */
.schema-output {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--vp-c-bg-alt, var(--vp-c-bg));
}

.schema-tabs {
  display: flex;
  gap: 2px;
  padding: 0.4rem 0.75rem 0;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  align-items: center;
}

.schema-tabs .copy-btn {
  margin-left: auto;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s;
}

.schema-tabs .copy-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.mermaid-viewport {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  user-select: none;
}

.mermaid-canvas {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.05s linear;
}

.mermaid-canvas :deep(svg) {
  max-width: none;
  height: auto;
  display: block;
}

.zoom-controls {
  position: absolute;
  bottom: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
}

.zoom-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-2);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  opacity: 0.7;
}

.zoom-btn:hover {
  opacity: 1;
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.diagram-error {
  width: 100%;
  padding: 0.75rem;
}

.diagram-error pre {
  color: #f87171;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.diagram-placeholder {
  color: var(--vp-c-text-3);
  font-size: 0.8rem;
}

/* ============================================================
   Query panels (two-column)
   ============================================================ */
.query-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 360px;
}

@media (max-width: 900px) {
  .query-panels {
    grid-template-columns: 1fr;
  }

  .playground-input {
    border-right: none;
    border-bottom: 1px solid var(--vp-c-divider);
  }
}

/* ============================================================
   Left panel (NQL input)
   ============================================================ */
.playground-input {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--vp-c-divider);
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  background-image: linear-gradient(135deg, rgba(99, 102, 241, 0.04) 0%, rgba(34, 211, 238, 0.04) 100%);
}

.panel-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--vp-c-text-2);
  white-space: nowrap;
}

.example-select {
  flex: 1;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: border-color 0.15s;
}

.example-select:hover {
  border-color: var(--vp-c-brand-soft);
}

.example-select:focus {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

.nql-textarea {
  flex: 1;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  line-height: 1.7;
  padding: 1.25rem;
  min-height: 180px;
  letter-spacing: 0.02em;
  caret-color: var(--vp-c-brand-1);
  transition: box-shadow 0.2s;
}

.nql-textarea:focus {
  box-shadow: inset 0 0 0 2px rgba(99, 102, 241, 0.3);
}

.nql-textarea::placeholder {
  color: var(--vp-c-text-3);
}

.compile-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}

.compile-btn {
  background: linear-gradient(135deg, #6366F1 0%, #4F46E5 100%);
  color: #fff;
  border: none;
  border-radius: 6px; /* between radius-sm 4px and radius-md 8px */
  padding: var(--dbsp-space-sm) 1.4rem;
  font-size: var(--dbsp-text-sm);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
  letter-spacing: 0.02em;
}

.compile-btn:hover {
  background: linear-gradient(135deg, #818CF8 0%, #6366F1 100%);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
  transform: translateY(-1px);
}

.compile-btn:active {
  transform: translateY(0);
  box-shadow: 0 1px 4px rgba(99, 102, 241, 0.3);
}

.hint {
  font-size: 0.72rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  opacity: 0.7;
}

/* ============================================================
   Right panel (output)
   ============================================================ */
.playground-output {
  display: flex;
  flex-direction: column;
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 0.5rem 0.75rem 0;
  background: var(--vp-c-bg);
}

.tab-btn {
  padding: 0.5rem 1rem;
  font-size: 0.8rem;
  font-weight: 600;
  background: transparent;
  border: none;
  border-radius: 6px 6px 0 0;
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition: all 0.2s;
}

.tab-btn:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
}

.tab-btn.active {
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
  border-bottom: 2px solid var(--vp-c-brand-1);
}

.output-content,
.output-error,
.output-placeholder {
  flex: 1;
  overflow: auto;
  padding: 1.25rem; /* between space-lg 1rem and space-xl 1.5rem */
  background: transparent;
  animation: fadeIn 0.2s ease;
}

.output-pane {
  position: relative;
}

.output-copy-btn {
  position: absolute;
  top: 0;
  right: 0;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s;
  z-index: 1;
}

.output-copy-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.output-copy-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

/* ============================================================
   Plan tab — structured decision cards
   ============================================================ */
.plan-pane {
  display: flex;
  flex-direction: column;
  gap: var(--dbsp-space-lg);
}

.plan-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--dbsp-space-md);
  padding: var(--dbsp-space-sm) var(--dbsp-space-md);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md);
  font-size: var(--dbsp-text-sm);
}

.plan-meta-item {
  display: inline-flex;
  align-items: baseline;
  gap: var(--dbsp-space-xs);
}

.plan-meta-label {
  color: var(--vp-c-text-3);
}

.plan-meta-value {
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-weight: 600;
}

.plan-meta-warn {
  color: var(--dbsp-c-warning);
  font-weight: 600;
}

.plan-section-title {
  font-size: 0.72rem; /* between text-xs 0.75rem and the inline 0.7rem chip */
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-2);
  margin-bottom: var(--dbsp-space-sm);
}

.plan-warnings,
.plan-decisions {
  display: flex;
  flex-direction: column;
}

.plan-warnings > .plan-warning-card + .plan-warning-card,
.plan-decisions > .plan-decision-card + .plan-decision-card {
  margin-top: var(--dbsp-space-sm);
}

.plan-warning-card {
  padding: var(--dbsp-space-md);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--dbsp-c-warning);
  border-radius: var(--dbsp-radius-sm);
  font-size: var(--dbsp-text-sm);
  line-height: 1.5;
}

.plan-warning-code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--dbsp-c-warning);
  margin-bottom: var(--dbsp-space-xs);
}

.plan-warning-message {
  color: var(--vp-c-text-1);
}

.plan-warning-suggestion {
  margin-top: var(--dbsp-space-xs);
  color: var(--vp-c-text-2);
  font-style: italic;
}

.plan-decision-card {
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--dbsp-c-cyan);
  border-radius: var(--dbsp-radius-sm);
  background: var(--vp-c-bg);
  overflow: hidden;
  transition: border-color 0.15s;
}

.plan-decision-card--ambiguity {
  border-left-color: var(--dbsp-c-warning);
}

.plan-decision-header {
  display: flex;
  align-items: center;
  gap: var(--dbsp-space-md);
  width: 100%;
  padding: var(--dbsp-space-sm) var(--dbsp-space-md);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  font-size: var(--dbsp-text-sm);
  color: inherit;
  transition: background 0.15s;
}

.plan-decision-header:hover {
  background: var(--vp-c-bg-soft);
}

.plan-decision-header:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -2px;
}

.plan-decision-type {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem; /* between text-xs 0.75rem and chip baseline */
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--dbsp-c-cyan);
  flex-shrink: 0;
}

.plan-decision-card--ambiguity .plan-decision-type {
  color: var(--dbsp-c-warning);
}

.plan-decision-context {
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
  flex-shrink: 0;
}

.plan-decision-choice {
  flex: 1;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.plan-decision-chevron {
  color: var(--vp-c-text-3);
  transition: transform 0.15s;
  flex-shrink: 0;
}

.plan-decision-chevron.open {
  transform: rotate(90deg);
}

.plan-decision-body {
  padding: var(--dbsp-space-sm) var(--dbsp-space-md) var(--dbsp-space-md);
  border-top: 1px solid var(--vp-c-divider);
  font-size: var(--dbsp-text-sm);
  display: flex;
  flex-direction: column;
  gap: var(--dbsp-space-sm);
}

.plan-decision-row {
  display: flex;
  flex-direction: column;
  gap: var(--dbsp-space-xs);
}

.plan-decision-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-3);
}

.plan-decision-value {
  color: var(--vp-c-text-1);
  line-height: 1.5;
}

.plan-decision-alternatives {
  margin: 0;
  padding-left: var(--dbsp-space-lg);
  color: var(--vp-c-text-2);
}

.plan-decision-alternatives li {
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem; /* between text-sm 0.875rem and 0.75rem for compact list */
  line-height: 1.6;
}

.plan-empty {
  padding: var(--dbsp-space-xl);
  text-align: center;
  color: var(--vp-c-text-3);
  font-size: var(--dbsp-text-sm);
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.output-content pre,
.output-error pre {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--dbsp-text-sm);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}

.output-content code {
  color: var(--vp-c-text-1);
}

/* SQL highlighting — WCAG AA contrast for both modes */
.dark .output-content :deep(.sql-kw) { color: #A5B4FC; font-weight: 600; }
.dark .output-content :deep(.sql-param) { color: #67E8F9; }
.dark .output-content :deep(.sql-ident) { color: #86EFAC; }

.output-content :deep(.sql-kw) { color: #4338CA; font-weight: 600; }
.output-content :deep(.sql-param) { color: #0E7490; }
.output-content :deep(.sql-ident) { color: #15803D; }

.output-error pre {
  color: #F87171;
}

.output-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  font-size: 0.875rem;
  min-height: 200px;
}

/* ============================================================
   Generated TypeScript (in schema-output tab)
   ============================================================ */
.generated-pre {
  margin: 0;
  padding: 1rem;
  font-family: var(--vp-font-family-mono);
  font-size: 0.82rem;
  line-height: 1.65;
  overflow: auto;
  flex: 1;
}

/* WCAG AA contrast — dark mode: light on dark, light mode: dark on light */
.dark .generated-pre :deep(.ts-kw) { color: #A5B4FC; font-weight: 600; }
.dark .generated-pre :deep(.ts-fn) { color: #67E8F9; }
.dark .generated-pre :deep(.ts-str) { color: #86EFAC; }

.generated-pre :deep(.ts-kw) { color: #4338CA; font-weight: 600; }
.generated-pre :deep(.ts-fn) { color: #0E7490; }
.generated-pre :deep(.ts-str) { color: #15803D; }
</style>
