<script setup lang="ts">
import { computed, type PropType } from 'vue';
import type { Dump } from '@dbsp/core';
import PlanDecisions from './PlanDecisions.vue';

const props = defineProps({
	result: { type: Object as PropType<Dump | null>, default: null },
});

const planMeta = computed(() => props.result?.plan?.metadata);
const planRootTable = computed(() => props.result?.plan?.rootTable);
const planWarnings = computed(() => props.result?.plan?.warnings ?? []);
const planCtes = computed(() => props.result?.plan?.ctes ?? []);
const planDecisions = computed(() => props.result?.plan?.decisions ?? []);
</script>

<template>
  <section v-if="result" class="plan-section">
    <div v-if="planMeta || planRootTable" class="plan-meta">
      <span v-if="planRootTable" class="plan-meta-item">
        <span class="plan-meta-label">Root</span>
        <span class="plan-meta-value">{{ planRootTable }}</span>
      </span>
      <span v-if="planMeta" class="plan-meta-item">
        <span class="plan-meta-label">Planned in</span>
        <span class="plan-meta-value">{{ planMeta.planningTimeMs.toFixed(2) }}ms</span>
      </span>
      <span v-if="planMeta" class="plan-meta-item">
        <span class="plan-meta-label">Relations</span>
        <span class="plan-meta-value">{{ planMeta.relationsAnalyzed }}</span>
      </span>
      <span v-if="planMeta?.isAmbiguous" class="plan-meta-item plan-meta-warn">
        Ambiguous plan
      </span>
    </div>

    <div v-if="planWarnings.length > 0" class="plan-warnings">
      <div class="plan-section-title">Warnings ({{ planWarnings.length }})</div>
      <div v-for="(w, i) in planWarnings" :key="i" class="plan-warning-card">
        <div class="plan-warning-code">{{ w.code }}</div>
        <div class="plan-warning-message">{{ w.message }}</div>
        <div v-if="w.suggestion" class="plan-warning-suggestion">→ {{ w.suggestion }}</div>
      </div>
    </div>

    <div v-if="planCtes.length > 0" class="plan-ctes">
      <div class="plan-section-title">CTEs ({{ planCtes.length }})</div>
      <div v-for="cte in planCtes" :key="cte.name" class="plan-cte-card">
        <div class="plan-cte-header">
          <span class="plan-cte-name">{{ cte.name }}</span>
          <span v-if="cte.recursive" class="plan-cte-recursive">WITH RECURSIVE</span>
          <span v-if="cte.referencedBy.length > 0" class="plan-cte-refs">
            referenced by {{ cte.referencedBy.join(', ') }}
          </span>
        </div>
        <div class="plan-cte-purpose">{{ cte.purpose }}</div>
      </div>
    </div>

    <PlanDecisions :decisions="planDecisions" />
  </section>
</template>

<style scoped>
.plan-section {
  display: flex;
  flex-direction: column;
  gap: var(--dbsp-space-lg, 1rem);
  padding: var(--dbsp-space-md, 0.75rem);
  background: rgba(99, 102, 241, 0.04);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  margin-bottom: var(--dbsp-space-lg, 1rem);
}

.plan-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--dbsp-space-md, 0.75rem);
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-size: 0.85rem;
}

.plan-meta-item { display: inline-flex; align-items: baseline; gap: var(--dbsp-space-xs, 0.25rem); }
.plan-meta-label { color: var(--vp-c-text-3); }
.plan-meta-value { color: var(--vp-c-text-1); font-family: var(--vp-font-family-mono); font-weight: 600; }
.plan-meta-warn { color: var(--dbsp-c-warning); font-weight: 600; }

.plan-section-title {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-2);
  margin-bottom: var(--dbsp-space-sm, 0.5rem);
}

.plan-warnings, .plan-ctes { display: flex; flex-direction: column; }
.plan-warnings > .plan-warning-card + .plan-warning-card,
.plan-ctes > .plan-cte-card + .plan-cte-card { margin-top: var(--dbsp-space-sm, 0.5rem); }

.plan-warning-card {
  padding: var(--dbsp-space-md, 0.75rem);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--dbsp-c-warning);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-size: 0.875rem;
  line-height: 1.5;
}
.plan-warning-code { font-family: var(--vp-font-family-mono); font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; color: var(--dbsp-c-warning); margin-bottom: var(--dbsp-space-xs, 0.25rem); }
.plan-warning-message { color: var(--vp-c-text-1); }
.plan-warning-suggestion { margin-top: var(--dbsp-space-xs, 0.25rem); color: var(--vp-c-text-2); font-style: italic; }

.plan-cte-card {
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--dbsp-c-cyan);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-size: 0.875rem;
}
.plan-cte-header { display: flex; align-items: baseline; gap: var(--dbsp-space-md, 0.75rem); flex-wrap: wrap; }
.plan-cte-name { font-family: var(--vp-font-family-mono); font-weight: 700; color: var(--dbsp-c-cyan); }
.plan-cte-recursive {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0.05rem 0.4rem;
  border-radius: var(--dbsp-radius-sm, 4px);
  background: color-mix(in srgb, var(--dbsp-c-warning) 12%, transparent);
  color: var(--dbsp-c-warning);
}
.plan-cte-refs { font-size: 0.72rem; color: var(--vp-c-text-3); }
.plan-cte-purpose { margin-top: var(--dbsp-space-xs, 0.25rem); color: var(--vp-c-text-2); line-height: 1.5; }
</style>
