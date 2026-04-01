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
          <pre v-if="activeTab === 'SQL'"><code>{{ result.sql }}</code></pre>
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

let nqlTag:
	| ((
			strings: TemplateStringsArray,
			...values: unknown[]
	  ) => { dump(): CompileResult })
	| null = null;

onMounted(async () => {
	try {
		// Dynamic imports keep the browser bundle lazy-loaded
		const [coreModule, adapterModule] = await Promise.all([
			import('@dbsp/core'),
			import('@dbsp/adapter-pgsql'),
		]);

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

function _loadExample() {
	const ex = examples[selectedExampleIndex.value];
	if (ex) {
		nqlCode.value = ex.code;
		result.value = null;
		error.value = null;
	}
}

function _compile() {
	error.value = null;
	result.value = null;

	if (!nqlTag) {
		error.value =
			'Compiler not ready yet — please wait a moment and try again.';
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

function _formatParams(params: readonly unknown[]): string {
	if (params.length === 0) return '(no parameters)';
	return params.map((p, i) => `$${i + 1}: ${JSON.stringify(p)}`).join('\n');
}

function _formatPlan(plan: unknown): string {
	return JSON.stringify(plan, null, 2);
}
</script>

<style scoped>
.playground {
  margin: 1.5rem 0;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 8px;
  overflow: hidden;
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
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  font-size: 0.85rem;
  color: var(--vp-c-text-1);
  cursor: pointer;
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
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.875rem;
  line-height: 1.6;
  padding: 1rem;
  min-height: 160px;
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
  background: var(--vp-c-brand-1);
  color: #fff;
  border: none;
  border-radius: 5px;
  padding: 0.4rem 1.1rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.compile-btn:hover {
  background: var(--vp-c-brand-2);
}

.compile-btn:active {
  opacity: 0.85;
}

.hint {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
}

/* ---------- Right panel ---------- */

.playground-output {
  display: flex;
  flex-direction: column;
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}

.tab-btn {
  padding: 0.55rem 1rem;
  font-size: 0.8rem;
  font-weight: 600;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.tab-btn:hover {
  color: var(--vp-c-text-1);
}

.tab-btn.active {
  color: var(--vp-c-brand-1);
  border-bottom-color: var(--vp-c-brand-1);
}

.output-content,
.output-error,
.output-placeholder {
  flex: 1;
  overflow: auto;
  padding: 1rem;
}

.output-content pre,
.output-error pre {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.output-content code {
  color: var(--vp-c-text-1);
}

.output-error pre {
  color: var(--vp-c-danger-1, #f87171);
}

.output-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-3);
  font-size: 0.875rem;
}
</style>
