<template>
  <div class="playground">
    <div class="playground-panels">
      <!-- Left panel: input -->
      <div class="playground-input">
        <div class="panel-header">
          <label for="example-select" class="panel-label">Example</label>
          <select
            id="example-select"
            v-model="selectedExampleIndex"
            class="example-select"
            @change="loadExample"
          >
            <option v-for="(ex, i) in examples" :key="i" :value="i">
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
          placeholder="Enter NQL query…"
          @keydown.ctrl.enter.prevent="compile"
          @keydown.meta.enter.prevent="compile"
        />
        <div class="compile-row">
          <button class="compile-btn" @click="compile">Compile</button>
          <span class="hint">Ctrl+Enter / Cmd+Enter</span>
        </div>
      </div>

      <!-- Right panel: output -->
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
import { onMounted, ref } from 'vue';

// ---------------------------------------------------------------------------
// Types (minimal — avoids importing full PlanReport type in browser)
// ---------------------------------------------------------------------------

interface CompileResult {
	sql: string;
	params: readonly unknown[];
	plan: unknown;
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

const examples = [
	{
		name: 'Simple query',
		code: 'users | where active = true | select id, name',
	},
	{
		name: 'With relations',
		code: 'posts | where published = true | select title, author.*',
	},
	{
		name: 'Aggregation',
		code: 'orders | group by status | select status, count(*), sum(amount)',
	},
	{
		name: 'Pagination',
		code: 'users | where active = true | order by created_at desc | limit 10 offset 20',
	},
	{
		name: 'Window function',
		code: 'products | select name, rank() over (partition by category order by price) as price_rank',
	},
	{
		name: 'Insert',
		code: "insert into users set name = 'Alice', email = 'alice@example.com'",
	},
	{
		name: 'Update',
		code: "update users set active = false where last_login < '2024-01-01'",
	},
];

// ---------------------------------------------------------------------------
// Reactive state
// ---------------------------------------------------------------------------

const tabs = ['SQL', 'Parameters', 'Plan'] as const;
type Tab = (typeof tabs)[number];

const selectedExampleIndex = ref(0);
const nqlCode = ref(examples[0].code);
const activeTab = ref<Tab>('SQL');
const result = ref<CompileResult | null>(null);
const error = ref<string | null>(null);

// ---------------------------------------------------------------------------
// ORM initialisation (lazy — runs once on mount)
// ---------------------------------------------------------------------------

let nqlTag: ((strings: TemplateStringsArray, ...values: unknown[]) => { dump(): CompileResult }) | null = null;

onMounted(async () => {
	try {
		// Dynamic imports keep the browser bundle lazy-loaded
		const [coreModule, adapterModule] = await Promise.all([import('@dbsp/core'), import('@dbsp/adapter-pgsql')]);

		const { schema, ref: dbRef, createOrm } = coreModule;
		const { createPgsqlCompileOnlyAdapter } = adapterModule;

		const playgroundSchema = schema({
			users: {
				id: { type: 'uuid', primaryKey: true },
				name: 'string',
				email: 'string',
				active: 'boolean',
				created_at: 'timestamp',
				last_login: 'timestamp',
			},
			posts: {
				id: { type: 'uuid', primaryKey: true },
				title: 'string',
				content: { type: 'text', nullable: true },
				published: 'boolean',
				author_id: dbRef('users'),
				created_at: 'timestamp',
			},
			orders: {
				id: { type: 'uuid', primaryKey: true },
				user_id: dbRef('users'),
				status: 'string',
				amount: 'integer',
				created_at: 'timestamp',
			},
			products: {
				id: { type: 'uuid', primaryKey: true },
				name: 'string',
				category: 'string',
				price: 'integer',
			},
		});

		const orm = createOrm({
			schema: playgroundSchema,
			adapter: createPgsqlCompileOnlyAdapter(),
		});

		// orm.nql is the template tag — we capture it to call with a variable string
		nqlTag = orm.nql as typeof nqlTag;
	} catch (e) {
		error.value = `Initialization error: ${e instanceof Error ? e.message : String(e)}`;
	}
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function loadExample() {
	const ex = examples[selectedExampleIndex.value];
	if (ex) {
		nqlCode.value = ex.code;
		result.value = null;
		error.value = null;
	}
}

function compile() {
	error.value = null;
	result.value = null;

	if (!nqlTag) {
		error.value = 'Compiler not ready yet — please wait a moment and try again.';
		return;
	}

	const query = nqlCode.value.trim();
	if (!query) {
		error.value = 'Please enter an NQL query.';
		return;
	}

	try {
		// Template literal with interpolated variable: strings[0] = '', values[0] = query
		// createNqlTag reconstructs: query = '' + String(query) + '' = query  ✓
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
	return params.map((p, i) => `$${i + 1}: ${JSON.stringify(p)}`).join('\n');
}

function formatPlan(plan: unknown): string {
	return JSON.stringify(plan, null, 2);
}

const SQL_KEYWORDS =
	/\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|LATERAL|ON|AND|OR|NOT|IN|EXISTS|AS|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|INSERT\s+INTO|VALUES|UPDATE|SET|DELETE|RETURNING|WITH|RECURSIVE|UNION|ALL|INTERSECT|EXCEPT|DISTINCT|ON|CASE|WHEN|THEN|ELSE|END|IS|NULL|TRUE|FALSE|ASC|DESC|BETWEEN|LIKE|ILIKE|CAST|OVER|PARTITION\s+BY|CONFLICT|DO|NOTHING|FETCH|FIRST|NEXT|ROWS|ONLY|FOR|SHARE|SKIP|LOCKED|NOWAIT)\b/g;

function highlightSQL(sql: string): string {
	const escaped = sql.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	// Identifiers first (before keyword spans inject double quotes in class attrs)
	return escaped
		.replace(/("(?:[^"\\]|\\.)*")/g, '\x00IDENT$1\x00')
		.replace(SQL_KEYWORDS, '<span class="sql-kw">$1</span>')
		.replace(/(\$\d+)/g, '<span class="sql-param">$1</span>')
		.replace(/\x00IDENT(.*?)\x00/g, '<span class="sql-ident">$1</span>');
}
</script>

<style scoped>
.playground {
  margin: 1.5rem 0;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12);
  background: var(--vp-c-bg-soft);
}

/* Two-column layout on wide screens, stacked on mobile */
.playground-panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: 400px;
}

@media (max-width: 768px) {
  .playground-panels {
    grid-template-columns: 1fr;
  }
}

/* ---------- Left panel ---------- */

.playground-input {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--vp-c-divider);
  padding: 0;
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

/* ---------- Right panel ---------- */

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

/* SQL syntax highlighting */
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
