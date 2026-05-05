<script setup lang="ts">
import { ref, watch, type PropType } from 'vue';
import type { PlanDecision } from '@dbsp/core';

const props = defineProps({
	decisions: {
		type: Array as PropType<readonly PlanDecision[]>,
		required: true,
	},
});

const expanded = ref<Set<string>>(new Set());

function decisionSignature(d: PlanDecision): string {
	const c = d.context;
	const target = c.relation ?? c.target ?? '';
	const path = c.relationPath ?? c.intentPath ?? '';
	const alias = c.includeAlias ?? '';
	const join = d.joinType ?? '';
	return `${d.type}:${c.sourceTable}:${target}:${path}:${alias}:${join}:${d.choice}`;
}

let lastSignatures = new Map<string, string>();

watch(
	() => props.decisions,
	(decisions) => {
		// Empty = transient compile error; preserve state, do nothing.
		if (decisions.length === 0) return;

		const currentSigs = new Map<string, string>();
		for (const d of decisions) currentSigs.set(d.id, decisionSignature(d));

		// Same shape? Nothing to update.
		let unchanged = currentSigs.size === lastSignatures.size;
		if (unchanged) {
			for (const [id, sig] of currentSigs) {
				if (lastSignatures.get(id) !== sig) {
					unchanged = false;
					break;
				}
			}
		}
		if (unchanged) return;

		// Per-id signature comparison: keep collapse choice for ids whose
		// signature still matches; default-expand new or repurposed ids.
		const next = new Set<string>();
		for (const [id, sig] of currentSigs) {
			if (lastSignatures.get(id) === sig) {
				if (expanded.value.has(id)) next.add(id);
			} else {
				next.add(id);
			}
		}
		expanded.value = next;
		lastSignatures = currentSigs;
	},
	{ immediate: true },
);

function isExpanded(id: string): boolean {
	return expanded.value.has(id);
}

function toggle(id: string) {
	const next = new Set(expanded.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expanded.value = next;
}

function formatType(type: string): string {
	return type.replace(/-/g, ' ').toUpperCase();
}

function formatContext(ctx: PlanDecision['context']): string {
	const parts: string[] = [ctx.sourceTable];
	const target = ctx.relation ?? ctx.target;
	if (target) parts.push(`→ ${target}`);
	return parts.join(' ');
}
</script>

<template>
  <div v-if="decisions.length > 0" class="plan-decisions">
    <div class="plan-section-title">Decisions ({{ decisions.length }})</div>
    <div
      v-for="d in decisions"
      :key="d.id"
      class="plan-decision-card"
      :class="`plan-decision-card--${d.type}`"
    >
      <button
        type="button"
        class="plan-decision-header"
        :aria-expanded="isExpanded(d.id)"
        :aria-controls="`plan-decision-body-${d.id}`"
        @click="toggle(d.id)"
      >
        <span class="plan-decision-type">{{ formatType(d.type) }}</span>
        <span class="plan-decision-context">{{ formatContext(d.context) }}</span>
        <span class="plan-decision-choice">{{ d.choice }}</span>
        <span
          class="plan-decision-chevron"
          :class="{ open: isExpanded(d.id) }"
          aria-hidden="true"
        >▸</span>
      </button>
      <div
        v-show="isExpanded(d.id)"
        :id="`plan-decision-body-${d.id}`"
        class="plan-decision-body"
      >
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
</template>

<style scoped>
.plan-decisions { display: flex; flex-direction: column; }
.plan-decisions > .plan-decision-card + .plan-decision-card { margin-top: var(--dbsp-space-sm, 0.5rem); }

.plan-section-title {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-2);
  margin-bottom: var(--dbsp-space-sm, 0.5rem);
}

.plan-decision-card {
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--dbsp-c-cyan);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg);
  overflow: hidden;
  transition: border-color 0.15s;
}
.plan-decision-card--ambiguity { border-left-color: var(--dbsp-c-warning); }

.plan-decision-header {
  display: flex;
  align-items: center;
  gap: var(--dbsp-space-md, 0.75rem);
  width: 100%;
  padding: var(--dbsp-space-md, 0.75rem) var(--dbsp-space-lg, 1rem);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  font-size: 0.875rem;
  color: inherit;
  transition: background 0.15s;
}
.plan-decision-header:hover { background: var(--vp-c-bg-soft); }
.plan-decision-header:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; }

.plan-decision-type {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--dbsp-c-cyan);
  flex-shrink: 0;
}
.plan-decision-card--ambiguity .plan-decision-type { color: var(--dbsp-c-warning); }

.plan-decision-context { font-family: var(--vp-font-family-mono); color: var(--vp-c-text-2); flex-shrink: 0; }
.plan-decision-choice { flex: 1; font-weight: 600; color: var(--vp-c-text-1); }
.plan-decision-chevron { color: var(--vp-c-text-3); transition: transform 0.15s; flex-shrink: 0; }
.plan-decision-chevron.open { transform: rotate(90deg); }

.plan-decision-body {
  padding: var(--dbsp-space-md, 0.75rem) var(--dbsp-space-lg, 1rem) var(--dbsp-space-lg, 1rem);
  border-top: 1px solid var(--vp-c-divider);
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  gap: var(--dbsp-space-sm, 0.5rem);
}

.plan-decision-row { display: flex; flex-direction: column; gap: var(--dbsp-space-xs, 0.25rem); }
.plan-decision-label { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vp-c-text-3); }
.plan-decision-value { color: var(--vp-c-text-1); line-height: 1.5; }
.plan-decision-alternatives { margin: 0; padding-left: var(--dbsp-space-lg, 1rem); color: var(--vp-c-text-2); }
.plan-decision-alternatives li { font-family: var(--vp-font-family-mono); font-size: 0.82rem; line-height: 1.6; }
</style>
