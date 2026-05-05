<script setup lang="ts">
import { ref, watch, type PropType } from 'vue';
import type { Dump } from '@dbsp/core';

const props = defineProps({
	result: { type: Object as PropType<Dump | null>, default: null },
});

const emit = defineEmits<{
	'copy-sql': [];
	'copy-params': [];
}>();

const activeTab = ref<'sql' | 'params'>('sql');
const sqlCopied = ref(false);
const paramsCopied = ref(false);

let sqlTimer: ReturnType<typeof setTimeout> | null = null;
let paramsTimer: ReturnType<typeof setTimeout> | null = null;

// Reset copied feedback when result changes — clipboard is now stale.
watch(
	() => props.result,
	() => {
		if (sqlTimer !== null) clearTimeout(sqlTimer);
		sqlTimer = null;
		if (paramsTimer !== null) clearTimeout(paramsTimer);
		paramsTimer = null;
		sqlCopied.value = false;
		paramsCopied.value = false;
	},
);

async function copySQL() {
	if (!props.result) return;
	try {
		await navigator.clipboard.writeText(props.result.sql);
	} catch (e) {
		console.warn('Playground: SQL clipboard write failed', e);
		return;
	}
	sqlCopied.value = true;
	if (sqlTimer !== null) clearTimeout(sqlTimer);
	sqlTimer = setTimeout(() => {
		sqlCopied.value = false;
		sqlTimer = null;
	}, 2000);
	emit('copy-sql');
}

async function copyParams() {
	if (!props.result) return;
	try {
		await navigator.clipboard.writeText(formatParams(props.result.params));
	} catch (e) {
		console.warn('Playground: Params clipboard write failed', e);
		return;
	}
	paramsCopied.value = true;
	if (paramsTimer !== null) clearTimeout(paramsTimer);
	paramsTimer = setTimeout(() => {
		paramsCopied.value = false;
		paramsTimer = null;
	}, 2000);
	emit('copy-params');
}

function formatParams(params: readonly unknown[]): string {
	if (params.length === 0) return '(no parameters)';
	return params.map((p, i) => `$${ i + 1 }: ${JSON.stringify(p)}`).join('\n');
}

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
	return escaped
		.replace(/("(?:[^"\\]|\\.)*")/g, '\x00IDENT$1\x00')
		.replace(SQL_KEYWORDS, '<span class="sql-kw">$1</span>')
		.replace(/(\$\d+)/g, '<span class="sql-param">$1</span>')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: \x00 sentinel
		.replace(/\x00IDENT(.*?)\x00/g, '<span class="sql-ident">$1</span>');
}
</script>

<template>
  <section v-if="result" class="output-section">
    <div role="group" aria-label="Output format" class="output-tabs">
      <button
        type="button"
        class="output-tab-btn"
        :class="{ active: activeTab === 'sql' }"
        @click="activeTab = 'sql'"
      >SQL</button>
      <button
        type="button"
        class="output-tab-btn"
        :class="{ active: activeTab === 'params' }"
        @click="activeTab = 'params'"
      >Parameters</button>

      <button
        v-if="activeTab === 'sql'"
        type="button"
        class="output-copy-btn"
        :aria-label="sqlCopied ? 'SQL copied to clipboard' : 'Copy SQL to clipboard'"
        @click="copySQL"
      >{{ sqlCopied ? 'Copied' : 'Copy' }}</button>
      <button
        v-else
        type="button"
        class="output-copy-btn"
        :aria-label="paramsCopied ? 'Parameters copied to clipboard' : 'Copy parameters to clipboard'"
        @click="copyParams"
      >{{ paramsCopied ? 'Copied' : 'Copy' }}</button>
    </div>

    <pre v-if="activeTab === 'sql'" class="output-pre"><code v-html="highlightSQL(result.sql)"></code></pre>
    <pre v-else class="output-pre"><code>{{ formatParams(result.params) }}</code></pre>
  </section>
</template>

<style scoped>
.output-section {
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  padding: var(--dbsp-space-lg, 1rem);
  margin-bottom: var(--dbsp-space-xl, 1.5rem);
}

.output-tabs { display: flex; gap: 2px; padding-bottom: 0.4rem; border-bottom: 1px solid var(--vp-c-divider); margin-bottom: var(--dbsp-space-sm, 0.5rem); align-items: center; }
.output-tab-btn { font-size: 0.85rem; padding: 0.3rem 0.7rem; border: 0; background: transparent; color: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
.output-tab-btn.active { border-bottom-color: var(--vp-c-brand-1); font-weight: 600; }

.output-copy-btn {
  margin-left: auto;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.output-copy-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.output-copy-btn:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }

.output-pre {
  margin: 0;
  padding: var(--dbsp-space-md, 0.75rem);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}

.output-pre :deep(.sql-kw) { color: #4338CA; font-weight: 600; }
.output-pre :deep(.sql-param) { color: #0E7490; }
.output-pre :deep(.sql-ident) { color: #15803D; }
.dark .output-pre :deep(.sql-kw) { color: #A5B4FC; font-weight: 600; }
.dark .output-pre :deep(.sql-param) { color: #67E8F9; }
.dark .output-pre :deep(.sql-ident) { color: #86EFAC; }
</style>
