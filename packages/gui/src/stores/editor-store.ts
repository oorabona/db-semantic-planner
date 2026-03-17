import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Tab types ───────────────────────────────────────────────────────

export type TabLanguage = 'sql' | 'nql' | 'assert' | 'typescript';

export interface EditorTab {
	readonly id: string;
	readonly title: string;
	readonly language: TabLanguage;
	/** Editor content */
	content: string;
	/** Whether content has been modified since last save */
	dirty: boolean;
	/** File path if opened from filesystem */
	filePath?: string | undefined;
	/** Whether the underlying file has been deleted from disk */
	deleted?: boolean | undefined;
	/** Whether the file is outside all project roots (SC-17) */
	outOfRoot?: boolean | undefined;
}

// ── Store ───────────────────────────────────────────────────────────

interface EditorState {
	tabs: EditorTab[];
	activeTabId: string | null;

	// ── Actions ──
	addTab: (
		language?: TabLanguage,
		content?: string,
		filePath?: string,
	) => string;
	closeTab: (id: string) => void;
	setActiveTab: (id: string) => void;
	updateContent: (id: string, content: string) => void;
	renameTab: (id: string, title: string) => void;
	markSaved: (id: string) => void;
	/** Update filePath + title after Save As */
	setFilePath: (id: string, filePath: string) => void;
	/** Find a tab by its filePath (for dedup on re-open) */
	findTabByFilePath: (filePath: string) => EditorTab | undefined;
	/** Check whether any tab has unsaved changes */
	hasDirtyTabs: () => boolean;
	/** Get all tabs with unsaved changes */
	getDirtyTabs: () => EditorTab[];
	/** Mark a tab's backing file as deleted from disk (D05) */
	markFileDeleted: (id: string) => void;
	/** Set or clear out-of-root warning on a tab (SC-17) */
	setOutOfRoot: (id: string, outOfRoot: boolean) => void;
	/** Update filePath + title for a tab when its backing file is renamed/moved */
	updateTabPath: (oldPath: string, newPath: string) => void;
}

let nextTabCounter = 1;

function makeTabId(): string {
	return `tab-${Date.now()}-${nextTabCounter++}`;
}

function defaultTitle(language: TabLanguage, counter: number): string {
	if (language === 'sql') return `Query ${counter}.sql`;
	if (language === 'assert') return `Test ${counter}.assert.dbsp`;
	if (language === 'typescript') return `Schema ${counter}.ts`;
	return `Query ${counter}.dbsp`;
}

export const useEditorStore = create<EditorState>()(
	persist(
		(set, get) => ({
			tabs: [],
			activeTabId: null,

			addTab: (language = 'sql', content = '', filePath) => {
				const id = makeTabId();
				const title = filePath
					? (filePath.split('/').pop() ??
						`Untitled.${language === 'sql' ? 'sql' : 'dbsp'}`)
					: defaultTitle(language, nextTabCounter - 1);
				const tab: EditorTab = {
					id,
					title,
					language,
					content,
					dirty: false,
					filePath,
				};
				set((state) => ({
					tabs: [...state.tabs, tab],
					activeTabId: id,
				}));
				return id;
			},

			closeTab: (id) => {
				const state = get();
				const idx = state.tabs.findIndex((t) => t.id === id);
				if (idx < 0) return;

				const remaining = state.tabs.filter((t) => t.id !== id);
				let nextActive = state.activeTabId;

				if (state.activeTabId === id) {
					// Activate neighbor tab
					if (remaining.length > 0) {
						const neighborIdx = Math.min(idx, remaining.length - 1);
						nextActive = remaining[neighborIdx]?.id ?? null;
					} else {
						nextActive = null;
					}
				}

				set({ tabs: remaining, activeTabId: nextActive });
			},

			setActiveTab: (id) => set({ activeTabId: id }),

			updateContent: (id, content) =>
				set((state) => ({
					tabs: state.tabs.map((t) =>
						t.id === id ? { ...t, content, dirty: true } : t,
					),
				})),

			renameTab: (id, title) =>
				set((state) => ({
					tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
				})),

			markSaved: (id) =>
				set((state) => ({
					tabs: state.tabs.map((t) =>
						t.id === id ? { ...t, dirty: false } : t,
					),
				})),

			setFilePath: (id, filePath) =>
				set((state) => ({
					tabs: state.tabs.map((t) =>
						t.id === id
							? {
									...t,
									filePath,
									title: filePath.split(/[/\\]/).pop() ?? t.title,
								}
							: t,
					),
				})),

			findTabByFilePath: (filePath) =>
				get().tabs.find((t) => t.filePath === filePath),

			hasDirtyTabs: () => get().tabs.some((t) => t.dirty),

			getDirtyTabs: () => get().tabs.filter((t) => t.dirty),

			markFileDeleted: (id) =>
				set((state) => ({
					tabs: state.tabs.map((t) =>
						t.id === id && !t.deleted
							? { ...t, deleted: true, title: `${t.title} (deleted)` }
							: t,
					),
				})),

			setOutOfRoot: (id, outOfRoot) =>
				set((state) => ({
					tabs: state.tabs.map((t) => (t.id === id ? { ...t, outOfRoot } : t)),
				})),

			updateTabPath: (oldPath, newPath) =>
				set((state) => ({
					tabs: state.tabs.map((t) => {
						if (t.filePath !== oldPath) return t;
						const title = newPath.split(/[/\\]/).pop() ?? newPath;
						return { ...t, filePath: newPath, title };
					}),
				})),
		}),
		{
			name: 'dbsp-editor-tabs',
			partialize: (state) => ({
				tabs: state.tabs.map((t) => ({
					...t,
					// Reset transient flags on persist — content is the last-known state
					dirty: false,
					deleted: undefined,
				})),
				activeTabId: state.activeTabId,
			}),
		},
	),
);

// ── Derived helpers ─────────────────────────────────────────────────

export function getActiveTab(state: EditorState): EditorTab | null {
	if (!state.activeTabId) return null;
	return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
}
