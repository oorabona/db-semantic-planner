<script setup lang="ts">
import { ref } from 'vue';
import CodeEditor from './CodeEditor.vue';

const props = defineProps<{
	dsl: string;
	tableCount: number;
	mermaidSvg: string;
	generatedTs: string;
	schemaError: string | null;
	expanded: boolean;
	hasChanges?: boolean;
}>();

const emit = defineEmits<{
	'update:dsl': [value: string];
	'update:expanded': [value: boolean];
	reset: [];
	'copy-ts': [];
}>();

// Tab inside the expanded body: 'editor' | 'diagram' | 'typescript'
const activeTab = ref<'editor' | 'diagram' | 'typescript'>('editor');

// Local pan/zoom state for the Mermaid diagram.
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let panStartX = 0;
let panStartY = 0;
let activePointerId: number | null = null;

function onPointerDown(e: PointerEvent) {
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	activePointerId = e.pointerId;
	isDragging = true;
	dragStartX = e.clientX;
	dragStartY = e.clientY;
	panStartX = panX.value;
	panStartY = panY.value;
}

function onPointerMove(e: PointerEvent) {
	if (!isDragging || e.pointerId !== activePointerId) return;
	panX.value = panStartX + (e.clientX - dragStartX);
	panY.value = panStartY + (e.clientY - dragStartY);
}

function onPointerUp(e: PointerEvent) {
	if (e.pointerId !== activePointerId) return;
	isDragging = false;
	activePointerId = null;
	(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
}

function onWheel(e: WheelEvent) {
	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	zoom.value = Math.max(0.3, Math.min(3, zoom.value + delta));
}

function resetView() {
	zoom.value = 1;
	panX.value = 0;
	panY.value = 0;
}

function toggleExpand() {
	emit('update:expanded', !props.expanded);
}
</script>

<template>
  <section class="schema-section" :data-expanded="expanded">
    <header class="schema-bar">
      <button
        type="button"
        class="schema-toggle-btn"
        :aria-expanded="expanded"
        aria-controls="schema-body"
        @click="toggleExpand"
      >
        <span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <span class="schema-label">Schema</span>
        <span class="schema-tables">{{ tableCount }} tables</span>
        {{ expanded ? 'Hide schema' : 'Show schema' }}
      </button>
      <div class="schema-actions" v-show="hasChanges">
        <button
          type="button"
          class="schema-action-btn"
          aria-label="Reset playground state (clear URL hash)"
          @click="emit('reset')"
        >
          Reset
        </button>
      </div>
    </header>

    <div v-show="expanded" id="schema-body" class="schema-body">
      <div role="group" aria-label="Schema view" class="schema-tabs">
        <button
          type="button"
          class="schema-tab-btn"
          :class="{ active: activeTab === 'editor' }"
          @click="activeTab = 'editor'"
        >Editor</button>
        <button
          type="button"
          class="schema-tab-btn"
          :class="{ active: activeTab === 'diagram' }"
          @click="activeTab = 'diagram'"
        >Diagram</button>
        <button
          type="button"
          class="schema-tab-btn"
          :class="{ active: activeTab === 'typescript' }"
          @click="activeTab = 'typescript'"
        >TypeScript</button>
        <button
          v-if="activeTab === 'typescript'"
          type="button"
          class="schema-copy-btn"
          aria-label="Copy generated TypeScript to clipboard"
          @click="emit('copy-ts')"
        >Copy</button>
      </div>

      <div v-if="schemaError" class="schema-error" role="alert">
        <pre>{{ schemaError }}</pre>
      </div>

      <CodeEditor
        v-show="activeTab === 'editor'"
        :model-value="dsl"
        language="typescript"
        aria-label="Schema DSL"
        @update:model-value="emit('update:dsl', $event)"
      />

      <div
        v-show="activeTab === 'diagram'"
        class="schema-diagram"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.prevent="onWheel"
      >
        <button
          type="button"
          class="diagram-reset-btn"
          aria-label="Reset diagram pan and zoom"
          @click="resetView"
        >Reset view</button>
        <div
          class="diagram-svg-wrapper"
          :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})` }"
          v-html="mermaidSvg"
        ></div>
      </div>

      <pre
        v-show="activeTab === 'typescript'"
        class="schema-ts"
      ><code>{{ generatedTs }}</code></pre>
    </div>
  </section>
</template>

<style scoped>
.schema-section {
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  margin-bottom: var(--dbsp-space-xl, 1.5rem);
  overflow: hidden;
}

.schema-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--dbsp-space-md, 0.75rem) var(--dbsp-space-lg, 1rem);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(34, 211, 238, 0.04) 100%);
  border-bottom: 1px solid var(--vp-c-divider);
}

.schema-toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--dbsp-space-sm, 0.5rem);
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.schema-toggle-btn:hover { color: var(--vp-c-brand-1); }
.schema-toggle-btn:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; border-radius: 2px; }

.schema-label { font-weight: 600; }
.schema-tables { color: var(--vp-c-text-3); font-size: 0.8rem; }
.schema-actions { display: flex; align-items: center; gap: var(--dbsp-space-sm, 0.5rem); }

.schema-action-btn {
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s;
}

.schema-action-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }

.schema-body { padding: var(--dbsp-space-lg, 1rem); }
.schema-tabs { display: flex; gap: 2px; margin-bottom: var(--dbsp-space-sm, 0.5rem); align-items: center; }

.schema-tab-btn {
  font-size: 0.8rem;
  padding: 0.3rem 0.7rem;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.schema-tab-btn.active { border-bottom-color: var(--vp-c-brand-1); font-weight: 600; }

.schema-copy-btn {
  margin-left: auto;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.schema-copy-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }

.schema-error {
  background: color-mix(in srgb, var(--dbsp-c-error) 8%, transparent);
  border-left: 3px solid var(--dbsp-c-error);
  border-radius: var(--dbsp-radius-sm, 4px);
  padding: var(--dbsp-space-sm, 0.5rem);
  margin-bottom: var(--dbsp-space-sm, 0.5rem);
  font-size: 0.85rem;
  color: var(--dbsp-c-error);
}
.schema-error pre { margin: 0; white-space: pre-wrap; }


.schema-diagram {
  position: relative;
  height: 24rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  overflow: hidden;
  touch-action: none; /* Mobile: don't let the browser claim pinch/drag */
  user-select: none;
  cursor: grab;
}
.schema-diagram:active { cursor: grabbing; }

.diagram-reset-btn {
  position: absolute;
  top: var(--dbsp-space-sm, 0.5rem);
  right: var(--dbsp-space-sm, 0.5rem);
  z-index: 1;
  font-size: 0.72rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
}

.diagram-svg-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  transform-origin: center center;
}
.diagram-svg-wrapper :deep(svg) { max-width: 100%; max-height: 100%; }

.schema-ts {
  margin: 0;
  padding: var(--dbsp-space-sm, 0.5rem);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  color: var(--vp-c-text-1);
  overflow: auto;
  max-height: 20rem;
}
</style>
