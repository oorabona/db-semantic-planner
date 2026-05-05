<script setup lang="ts">
import type { PropType } from 'vue';

defineProps({
	nqlCode: { type: String, required: true },
	queryMode: { type: String as PropType<'nql'>, required: true },
	examples: {
		type: Array as PropType<readonly { readonly name: string; readonly code: string }[]>,
		required: true,
	},
	selectedExampleIndex: { type: Number, required: true },
	ready: { type: Boolean, required: true }, // nqlTag loaded + no schema error
});

const emit = defineEmits<{
	'update:nqlCode': [value: string];
	'update:selectedExampleIndex': [value: number];
	compile: [];
}>();

function onExampleChange(e: Event) {
	const target = e.target as HTMLSelectElement;
	emit('update:selectedExampleIndex', Number(target.value));
}

function onTextareaInput(e: Event) {
	emit('update:nqlCode', (e.target as HTMLTextAreaElement).value);
}

function onCompileShortcut(e: KeyboardEvent) {
	if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
		e.preventDefault();
		emit('compile');
	}
}
</script>

<template>
  <section class="query-section">
    <div class="query-header">
      <span class="query-label">Query</span>
      <div class="query-mode" role="group" aria-label="Query syntax">
        <button
          type="button"
          class="mode-btn active"
          :aria-pressed="queryMode === 'nql'"
        >NQL</button>
        <button
          type="button"
          class="mode-btn"
          aria-pressed="false"
          disabled
          title="TypeScript ORM mode coming in a future release"
        >TypeScript</button>
      </div>
    </div>

    <div class="query-examples">
      <label for="example-select" class="visually-hidden">Example</label>
      <select
        id="example-select"
        :value="selectedExampleIndex"
        class="example-select"
        @change="onExampleChange"
      >
        <option v-for="(ex, i) in examples" :key="i" :value="i">
          {{ ex.name }}
        </option>
      </select>
    </div>

    <textarea
      :value="nqlCode"
      class="nql-textarea"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      placeholder="Enter NQL query..."
      aria-label="NQL query"
      @input="onTextareaInput"
      @keydown="onCompileShortcut"
    />

    <div class="query-actions">
      <button
        type="button"
        class="compile-btn"
        :disabled="!ready"
        @click="emit('compile')"
      >Compile</button>
      <span class="hint">Ctrl+Enter · Cmd+Enter</span>
    </div>
  </section>
</template>

<style scoped>
.query-section {
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  padding: var(--dbsp-space-md, 0.75rem);
  margin-bottom: var(--dbsp-space-lg, 1rem);
}

.query-header { display: flex; align-items: center; gap: var(--dbsp-space-md, 0.75rem); margin-bottom: var(--dbsp-space-sm, 0.5rem); }
.query-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vp-c-text-2); }
.query-mode { display: inline-flex; gap: 2px; padding: 2px; background: var(--vp-c-bg-soft); border-radius: var(--dbsp-radius-sm, 4px); }

.mode-btn {
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border: 0;
  background: transparent;
  color: inherit;
  border-radius: 3px;
  cursor: pointer;
  font-family: var(--vp-font-family-mono);
}
.mode-btn.active { background: var(--vp-c-bg); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.mode-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.query-examples { margin-bottom: var(--dbsp-space-sm, 0.5rem); }

.example-select {
  font-size: 0.85rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  max-width: 24rem;
  width: 100%;
}

.nql-textarea {
  width: 100%;
  min-height: 7rem;
  padding: var(--dbsp-space-sm, 0.5rem);
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  color: var(--vp-c-text-1);
  resize: vertical;
}

.query-actions { display: flex; align-items: center; gap: var(--dbsp-space-md, 0.75rem); margin-top: var(--dbsp-space-sm, 0.5rem); }

.compile-btn {
  font-size: 0.85rem;
  padding: 0.4rem 1rem;
  border: 0;
  border-radius: var(--dbsp-radius-sm, 4px);
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: white;
  font-weight: 600;
  cursor: pointer;
}
.compile-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.hint { font-size: 0.75rem; color: var(--vp-c-text-3); }

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
