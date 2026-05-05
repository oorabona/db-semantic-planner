<script setup lang="ts">
import type { ErrorBannerData } from './types';

defineProps<{ data: ErrorBannerData | null }>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div
    v-if="data"
    class="playground-error-banner"
    :class="`error-banner--${data.severity}`"
    :role="data.severity === 'fatal' ? 'alertdialog' : 'alert'"
    :aria-modal="data.severity === 'fatal' ? 'true' : undefined"
  >
    <div class="error-banner-icon" aria-hidden="true">
      {{ data.severity === 'fatal' ? '✕' : '⚠' }}
    </div>
    <div class="error-banner-text">
      <strong class="error-banner-title">{{ data.title }}</strong>
      <p class="error-banner-message">{{ data.message }}</p>
    </div>
    <div class="error-banner-actions">
      <button
        v-for="action in data.actions"
        :key="action.label"
        type="button"
        class="error-banner-action"
        @click="action.handler"
      >
        {{ action.label }}
      </button>
    </div>
    <button
      type="button"
      class="error-banner-close"
      aria-label="Dismiss banner"
      @click="$emit('dismiss')"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.playground-error-banner {
  position: sticky;
  top: var(--vp-nav-height, 64px);
  z-index: calc(var(--vp-z-index-nav, 30) - 1);
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: start;
  gap: var(--dbsp-space-md, 0.75rem);
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  border: 1px solid var(--vp-c-divider);
  border-left-width: 3px;
  border-radius: var(--dbsp-radius-md, 8px);
  margin-bottom: var(--dbsp-space-md, 0.75rem);
  font-size: var(--dbsp-text-sm, 0.875rem);
}

.error-banner--warn {
  background: color-mix(in srgb, var(--dbsp-c-warning) 8%, transparent);
  border-left-color: var(--dbsp-c-warning);
  color: var(--vp-c-text-1);
}

.error-banner--fatal {
  background: color-mix(in srgb, var(--dbsp-c-error) 10%, transparent);
  border-left-color: var(--dbsp-c-error);
  color: var(--vp-c-text-1);
}

.error-banner-icon {
  font-size: 1.1rem;
  line-height: 1.5;
}

.error-banner--warn .error-banner-icon {
  color: var(--dbsp-c-warning);
}

.error-banner--fatal .error-banner-icon {
  color: var(--dbsp-c-error);
}

.error-banner-text {
  min-width: 0;
}

.error-banner-title {
  display: block;
  font-weight: 600;
  margin-bottom: var(--dbsp-space-xs, 0.25rem);
}

.error-banner-message {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}

.error-banner-actions {
  display: flex;
  gap: var(--dbsp-space-xs, 0.25rem);
  flex-wrap: wrap;
}

.error-banner-action {
  font-size: 0.8rem;
  padding: 0.25rem 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: all 0.15s;
}

.error-banner-action:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.error-banner-action:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.error-banner-close {
  background: transparent;
  border: 0;
  font-size: 1.2rem;
  line-height: 1;
  color: var(--vp-c-text-3);
  cursor: pointer;
  padding: 0 0.25rem;
}

.error-banner-close:hover {
  color: var(--vp-c-text-1);
}
</style>
