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
        />
      </div>
      <div class="schema-diagram">
        <div v-if="schemaError" class="diagram-error">
          <pre>{{ schemaError }}</pre>
        </div>
        <div v-else-if="mermaidSvg" class="mermaid-container" v-html="mermaidSvg" />
        <div v-else class="diagram-placeholder">Rendering diagram...</div>
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
          @keydown.ctrl.enter.prevent="compile"
          @keydown.meta.enter.prevent="compile"
        />
        <div class="compile-row">
          <button class="compile-btn" @click="compile">Compile</button>
          <span class="hint">Ctrl+Enter / Cmd+Enter</span>
        </div>
      </div>

      <div class="playground-output">
        <div class="tabs">
          <button
            v-for="tab in tabs"
            :key="tab"
            class="tab-btn"
            :class="{ active: activeTab === tab }"
            @click="activeTab = tab"
          >
            {{ tab }}
          </button>
        </div>

        <div v-if="error" class="output-error">
          <pre>{{ error }}</pre>
        </div>

        <div v-else-if="result" class="output-content">
          <pre v-if="activeTab === 'SQL'"><code v-html="highlightSQL(result.sql)"></code></pre>
          <pre v-else-if="activeTab === 'Parameters'"><code>{{ formatParams(result.params) }}</code></pre>
          <pre v-else-if="activeTab === 'Plan'"><code>{{ formatPlan(result.plan) }}</code></pre>
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

interface CompileResult {
	sql: string;
	params: readonly unknown[];
	plan: unknown;
}

interface ParsedColumn {
	name: string;
	type: string;
	nullable?: boolean;
	pk?: boolean;
	unique?: boolean;
	ref?: string;
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

			const col: ParsedColumn = {
				name: colName,
				type: typeRaw,
				...(nullable ? { nullable: true } : {}),
				...(modifiers.includes('pk') ? { pk: true } : {}),
				...(modifiers.includes('unique') ? { unique: true } : {}),
			};

			if (typeRaw === '->') {
				const targetTable = parts[1];
				if (targetTable) {
					col.type = 'uuid';
					col.ref = targetTable;
					relations.push({ from: tableName, fromCol: colName, to: targetTable });
				}
			} else {
				const arrowIdx = modifiers.indexOf('->');
				if (arrowIdx !== -1 && modifiers[arrowIdx + 1]) {
					const targetTable = modifiers[arrowIdx + 1];
					col.type = 'uuid';
					col.ref = targetTable;
					relations.push({ from: tableName, fromCol: colName, to: targetTable });
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
		lines.push('    ' + table.name + ' {');
		for (const col of table.columns) {
			const type = col.type.replace(/[^a-zA-Z0-9_]/g, '_');
			const suffix = col.pk ? ' PK' : col.unique ? ' UK' : '';
			lines.push('        ' + type + ' ' + col.name + suffix);
		}
		lines.push('    }');
	}

	for (const rel of parsed.relations) {
		lines.push('    ' + rel.to + ' ||--o{ ' + rel.from + ' : ""');
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// NQL tag type
// ---------------------------------------------------------------------------

type NqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => { dump(): CompileResult };

// ---------------------------------------------------------------------------
// All examples (filtered by available tables)
// ---------------------------------------------------------------------------

const ALL_EXAMPLES = [
	{ name: 'Simple query', code: 'users | where active = true | select id, name', requires: ['users'] },
	{ name: 'With relations', code: 'posts | where published = true | select title, author.*', requires: ['posts'] },
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
	{ name: 'Insert', code: "insert into users set name = 'Alice', email = 'alice@example.com'", requires: ['users'] },
	{ name: 'Update', code: "update users set active = false where last_login < '2024-01-01'", requires: ['users'] },
];

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const tabs = ['SQL', 'Parameters', 'Plan'] as const;
type Tab = (typeof tabs)[number];

const schemaOpen = ref(true);
const schemaDsl = ref(DEFAULT_SCHEMA_DSL);
const schemaError = ref<string | null>(null);
const mermaidSvg = ref<string>('');
const tableCount = ref(0);

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
				colDefs[col.name] = dbRef(col.ref);
			} else if (col.pk) {
				colDefs[col.name] = { type: col.type, primaryKey: true };
			} else if (col.nullable) {
				colDefs[col.name] = { type: col.type, nullable: true };
			} else {
				colDefs[col.name] = col.type;
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
		const id = 'er-' + Date.now();
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

	try {
		const builtSchema = buildSchemaFromParsed(parsed);
		const orm = coreModule.createOrm({
			schema: builtSchema,
			adapter: adapterModule.createPgsqlCompileOnlyAdapter(),
		});
		nqlTag = orm.nql as NqlTag;
	} catch (e) {
		schemaError.value = 'Schema error: ' + (e instanceof Error ? e.message : String(e));
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
		error.value = 'Initialization error: ' + (e instanceof Error ? e.message : String(e));
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

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function loadExample(): void {
	const ex = visibleExamples.value[selectedExampleIndex.value];
	if (ex) {
		nqlCode.value = ex.code;
		result.value = null;
		error.value = null;
	}
}

function compile(): void {
	error.value = null;
	result.value = null;

	if (!nqlTag) {
		error.value = schemaError.value
			? 'Schema error: ' + schemaError.value
			: 'Compiler not ready — please wait a moment and try again.';
		return;
	}

	const query = nqlCode.value.trim();
	if (!query) {
		error.value = 'Please enter an NQL query.';
		return;
	}

	try {
		const builder = nqlTag`${query}`;
		result.value = builder.dump();
		activeTab.value = 'SQL';
	} catch (e) {
		error.value = e instanceof Error ? e.message : String(e);
	}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatParams(params: readonly unknown[]): string {
	if (params.length === 0) return '(no parameters)';
	return params.map((p, i) => '$' + (i + 1) + ': ' + JSON.stringify(p)).join('\n');
}

function formatPlan(plan: unknown): string {
	return JSON.stringify(plan, null, 2);
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
	const escaped = sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return escaped
		.replace(/("(?:[^"\\]|\\.)*")/g, '\x00IDENT$1\x00')
		.replace(SQL_KEYWORDS, '<span class="sql-kw">$1</span>')
		.replace(/(\$\d+)/g, '<span class="sql-param">$1</span>')
		.replace(/\x00IDENT(.*?)\x00/g, '<span class="sql-ident">$1</span>');
}
</script>

<style scoped>
/* ============================================================
   Container
   ============================================================ */
.playground {
  margin: 1.5rem 0;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 12px;
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
  min-height: 260px;
  max-height: 420px;
}

@media (max-width: 768px) {
  .schema-panels {
    grid-template-columns: 1fr;
    max-height: none;
  }
}

.schema-editor {
  border-right: 1px solid var(--vp-c-divider);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

@media (max-width: 768px) {
  .schema-editor {
    border-right: none;
    border-bottom: 1px solid var(--vp-c-divider);
  }
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
  min-height: 220px;
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
.schema-diagram {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 0.75rem;
  background: var(--vp-c-bg-alt, var(--vp-c-bg));
}

.mermaid-container {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mermaid-container :deep(svg) {
  max-width: 100%;
  height: auto;
  display: block;
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

@media (max-width: 768px) {
  .query-panels {
    grid-template-columns: 1fr;
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

@media (max-width: 768px) {
  .playground-input {
    border-right: none;
    border-bottom: 1px solid var(--vp-c-divider);
  }
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
  border-radius: 6px;
  padding: 0.5rem 1.4rem;
  font-size: 0.875rem;
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
  padding: 1.25rem;
  background: transparent;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.output-content pre,
.output-error pre {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.875rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}

.output-content code {
  color: var(--vp-c-text-1);
}

.output-content :deep(.sql-kw) {
  color: #818CF8;
  font-weight: 600;
}

.output-content :deep(.sql-param) {
  color: #22D3EE;
}

.output-content :deep(.sql-ident) {
  color: #A5F3FC;
}

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
</style>
