<script setup lang="ts">
/**
 * CodeEditor — reusable CodeMirror 6 editor component.
 *
 * Supports schema DSL and NQL syntax highlighting. Lazy-loads CodeMirror
 * only when mounted to avoid bloating the initial bundle. Follows VitePress
 * dark-mode via the `isDark` ref from useData(). Two-way binding via
 * v-model (modelValue / update:modelValue).
 *
 * The `language="typescript"` prop value routes to the schema DSL tokenizer
 * (schema-mode.ts) rather than @codemirror/lang-javascript for backward
 * compatibility with SchemaSection.vue's existing prop.
 */

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Module-level constant — defined once, reused in onMounted and rebuildView.
// Colors use VitePress CSS variables that auto-flip between light/dark mode.
const cmHighlightStyle = HighlightStyle.define([
	{ tag: tags.keyword, color: 'var(--vp-c-brand-1)' },
	{ tag: tags.controlKeyword, color: 'var(--vp-c-brand-1)' },
	{ tag: tags.operatorKeyword, color: 'var(--vp-c-brand-1)' },
	{ tag: tags.string, color: 'var(--vp-c-success-1, #18794e)' },
	{ tag: tags.comment, color: 'var(--vp-c-text-3)', fontStyle: 'italic' },
	{ tag: tags.lineComment, color: 'var(--vp-c-text-3)', fontStyle: 'italic' },
	{ tag: tags.blockComment, color: 'var(--vp-c-text-3)', fontStyle: 'italic' },
	{ tag: tags.number, color: 'var(--vp-c-warning-1, #b07d48)' },
	{ tag: tags.bool, color: 'var(--vp-c-brand-1)' },
	{ tag: tags.null, color: 'var(--vp-c-brand-1)' },
	{ tag: tags.operator, color: 'var(--vp-c-text-2)' },
	{ tag: tags.punctuation, color: 'var(--vp-c-text-2)' },
	{ tag: tags.variableName, color: 'var(--vp-c-text-1)' },
	{ tag: tags.propertyName, color: 'var(--vp-c-text-1)' },
	{ tag: tags.typeName, color: 'var(--vp-c-success-1, #16a34a)' },
	{ tag: tags.className, color: 'var(--vp-c-success-1, #16a34a)' },
	{ tag: tags.definition(tags.variableName), color: 'var(--vp-c-text-1)' },
	{ tag: tags.atom, color: 'var(--vp-c-brand-1)' },
]);

import { useData } from 'vitepress';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
	modelValue: string;
	language: 'typescript' | 'nql';
	placeholder?: string;
	ariaLabel: string;
	disabled?: boolean;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: string];
}>();

const { isDark } = useData();

const editorRoot = ref<HTMLDivElement | null>(null);

// Holds the live EditorView instance (null before mount / after unmount).
let view: import('@codemirror/view').EditorView | null = null;

// Suppress the internal update→emit→prop-update echo that would reset the cursor.
let ignoreNextUpdate = false;

// Guard: set to true in onBeforeUnmount to abort any in-flight async mount/rebuild.
const disposed = ref(false);

// Monotonic token: incremented each time rebuildView is called so that stale
// in-flight rebuilds can detect they've been superseded and bail out.
let rebuildToken = 0;

// ---------------------------------------------------------------------------
// Theme helpers
// ---------------------------------------------------------------------------

function buildThemeExtension(
	dark: boolean,
	EditorView: typeof import('@codemirror/view').EditorView,
): import('@codemirror/view').Extension {
	return EditorView.theme(
		{
			'&': {
				background: 'var(--vp-c-bg)',
				color: 'var(--vp-c-text-1)',
				borderRadius: 'var(--dbsp-radius-sm, 4px)',
				border: '1px solid var(--vp-c-divider)',
				fontFamily: 'var(--vp-font-family-mono)',
				fontSize: '0.85rem',
			},
			'.cm-content': {
				padding: '0.5rem',
				minHeight: '9rem',
				caretColor: 'var(--vp-c-brand-1)',
			},
			'&.cm-focused': {
				outline: '2px solid var(--vp-c-brand-1)',
				outlineOffset: '-2px',
			},
			'.cm-placeholder': { color: 'var(--vp-c-text-3)' },
		},
		{ dark },
	);
}

// ---------------------------------------------------------------------------
// Mount / unmount
// ---------------------------------------------------------------------------

onMounted(async () => {
	if (!editorRoot.value) return;

	// Lazy-load all CodeMirror modules in parallel
	const [
		{ EditorView, keymap, placeholder: cmPlaceholder },
		{ EditorState },
		{ history, historyKeymap, defaultKeymap },
		langMod,
		{ nql: nqlLang },
	] = await Promise.all([
		import('@codemirror/view'),
		import('@codemirror/state'),
		import('@codemirror/commands'),
		// 'typescript' prop value kept for backward compat with SchemaSection.vue;
		// internally loads the schema DSL tokenizer instead of @codemirror/lang-javascript.
		props.language === 'typescript'
			? import('./schema-mode').then((m) => ({ ext: m.schemaDsl() }))
			: Promise.resolve({ ext: null }),
		import('./nql-mode'),
	]);

	// Guard: component may have been unmounted while we were awaiting imports.
	if (disposed.value || !editorRoot.value) return;

	const languageExt =
		props.language === 'typescript' && langMod.ext
			? [langMod.ext]
			: props.language === 'nql'
				? [nqlLang()]
				: [];

	const extensions: import('@codemirror/state').Extension[] = [
		history(),
		keymap.of([...defaultKeymap, ...historyKeymap]),
		EditorView.lineWrapping,
		EditorView.contentAttributes.of({
			'aria-label': props.ariaLabel,
			spellcheck: 'false',
			autocomplete: 'off',
			autocorrect: 'off',
			autocapitalize: 'off',
		}),
		buildThemeExtension(isDark.value, EditorView),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				if (ignoreNextUpdate) {
					ignoreNextUpdate = false;
					return;
				}
				emit('update:modelValue', update.state.doc.toString());
			}
		}),
		...languageExt,
		syntaxHighlighting(cmHighlightStyle),
	];

	if (props.placeholder) {
		extensions.push(cmPlaceholder(props.placeholder));
	}

	if (props.disabled) {
		extensions.push(EditorState.readOnly.of(true));
	}

	const state = EditorState.create({
		doc: props.modelValue,
		extensions,
	});

	view = new EditorView({
		state,
		parent: editorRoot.value,
	});
});

onBeforeUnmount(() => {
	disposed.value = true;
	view?.destroy();
	view = null;
});

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

// Sync external value changes into the editor without resetting cursor position
watch(
	() => props.modelValue,
	(newValue) => {
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === newValue) return;
		ignoreNextUpdate = true;
		view.dispatch({
			changes: { from: 0, to: current.length, insert: newValue },
		});
	},
);

// Re-apply the theme when VitePress dark mode toggles.
// Destroy + recreate is the cleanest approach for toggling the dark param
// in the EditorView.theme() call (there is no reconfigure shortcut for it).
watch(isDark, (dark) => {
	rebuildView(dark);
});

async function rebuildView(dark: boolean) {
	if (disposed.value || !editorRoot.value) return;
	const token = ++rebuildToken;
	const currentDoc = view
		? view.state.doc.toString()
		: (props.modelValue ?? '');
	if (view) {
		view.destroy();
		view = null;
	}

	const [
		{ EditorView, keymap, placeholder: cmPlaceholder },
		{ EditorState },
		{ history, historyKeymap, defaultKeymap },
		langMod,
		{ nql: nqlLang },
	] = await Promise.all([
		import('@codemirror/view'),
		import('@codemirror/state'),
		import('@codemirror/commands'),
		// 'typescript' prop value kept for backward compat with SchemaSection.vue;
		// internally loads the schema DSL tokenizer instead of @codemirror/lang-javascript.
		props.language === 'typescript'
			? import('./schema-mode').then((m) => ({ ext: m.schemaDsl() }))
			: Promise.resolve({ ext: null }),
		import('./nql-mode'),
	]);

	// Guard: bail if a newer rebuild was queued or the component was unmounted.
	if (disposed.value || token !== rebuildToken || !editorRoot.value) return;

	const languageExt =
		props.language === 'typescript' && langMod.ext
			? [langMod.ext]
			: props.language === 'nql'
				? [nqlLang()]
				: [];

	const extensions: import('@codemirror/state').Extension[] = [
		history(),
		keymap.of([...defaultKeymap, ...historyKeymap]),
		EditorView.lineWrapping,
		EditorView.contentAttributes.of({
			'aria-label': props.ariaLabel,
			spellcheck: 'false',
			autocomplete: 'off',
			autocorrect: 'off',
			autocapitalize: 'off',
		}),
		buildThemeExtension(dark, EditorView),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				if (ignoreNextUpdate) {
					ignoreNextUpdate = false;
					return;
				}
				emit('update:modelValue', update.state.doc.toString());
			}
		}),
		...languageExt,
		syntaxHighlighting(cmHighlightStyle),
	];

	if (props.placeholder) {
		extensions.push(cmPlaceholder(props.placeholder));
	}

	if (props.disabled) {
		extensions.push(EditorState.readOnly.of(true));
	}

	const state = EditorState.create({ doc: currentDoc, extensions });
	view = new EditorView({ state, parent: editorRoot.value });
}
</script>

<template>
  <div ref="editorRoot" class="code-editor-root" />
</template>

<style scoped>
.code-editor-root {
  width: 100%;
}

/* Let CodeMirror's own generated styles own the editor interior.
   We only set the outer container dimensions here. */
.code-editor-root :deep(.cm-editor) {
  width: 100%;
  min-height: 9rem;
}

.code-editor-root :deep(.cm-scroller) {
  overflow: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.5;
}
</style>
