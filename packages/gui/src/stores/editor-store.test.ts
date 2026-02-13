import { beforeEach, describe, expect, it } from 'vitest';
import { getActiveTab, useEditorStore } from './editor-store.js';

describe('useEditorStore', () => {
	beforeEach(() => {
		useEditorStore.setState({
			tabs: [],
			activeTabId: null,
		});
	});

	describe('addTab', () => {
		it('creates SQL tab by default', () => {
			const id = useEditorStore.getState().addTab();
			expect(useEditorStore.getState().tabs).toHaveLength(1);
			expect(useEditorStore.getState().tabs[0]!.language).toBe('sql');
			expect(useEditorStore.getState().activeTabId).toBe(id);
		});

		it('creates NQL tab', () => {
			useEditorStore.getState().addTab('nql');
			expect(useEditorStore.getState().tabs[0]!.language).toBe('nql');
			expect(useEditorStore.getState().tabs[0]!.title).toMatch(/\.dbsp$/);
		});

		it('creates tab with initial content', () => {
			useEditorStore.getState().addTab('sql', 'SELECT 1');
			expect(useEditorStore.getState().tabs[0]!.content).toBe('SELECT 1');
		});

		it('creates tab with file path', () => {
			useEditorStore.getState().addTab('sql', 'SELECT 1', '/path/to/query.sql');
			expect(useEditorStore.getState().tabs[0]!.title).toBe('query.sql');
			expect(useEditorStore.getState().tabs[0]!.filePath).toBe(
				'/path/to/query.sql',
			);
		});

		it('sets new tab as active', () => {
			const id1 = useEditorStore.getState().addTab();
			const id2 = useEditorStore.getState().addTab();
			expect(useEditorStore.getState().activeTabId).toBe(id2);
			expect(id1).not.toBe(id2);
		});
	});

	describe('closeTab', () => {
		it('removes tab', () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().closeTab(id);
			expect(useEditorStore.getState().tabs).toHaveLength(0);
			expect(useEditorStore.getState().activeTabId).toBeNull();
		});

		it('activates neighbor when closing active', () => {
			useEditorStore.getState().addTab();
			const id2 = useEditorStore.getState().addTab();
			const id3 = useEditorStore.getState().addTab();
			// Active is id3, close it
			useEditorStore.getState().closeTab(id3);
			expect(useEditorStore.getState().activeTabId).toBe(id2);
		});

		it('does nothing for non-existent id', () => {
			useEditorStore.getState().addTab();
			useEditorStore.getState().closeTab('non-existent');
			expect(useEditorStore.getState().tabs).toHaveLength(1);
		});
	});

	describe('setActiveTab', () => {
		it('switches active tab', () => {
			const id1 = useEditorStore.getState().addTab();
			useEditorStore.getState().addTab();
			useEditorStore.getState().setActiveTab(id1);
			expect(useEditorStore.getState().activeTabId).toBe(id1);
		});
	});

	describe('updateContent', () => {
		it('updates content and marks dirty', () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().updateContent(id, 'SELECT * FROM users');
			const tab = useEditorStore.getState().tabs[0]!;
			expect(tab.content).toBe('SELECT * FROM users');
			expect(tab.dirty).toBe(true);
		});
	});

	describe('renameTab', () => {
		it('renames tab', () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().renameTab(id, 'My Query.sql');
			expect(useEditorStore.getState().tabs[0]!.title).toBe('My Query.sql');
		});
	});

	describe('markSaved', () => {
		it('clears dirty flag', () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().updateContent(id, 'modified');
			expect(useEditorStore.getState().tabs[0]!.dirty).toBe(true);
			useEditorStore.getState().markSaved(id);
			expect(useEditorStore.getState().tabs[0]!.dirty).toBe(false);
		});
	});

	describe('setFilePath', () => {
		it('updates filePath and title from filename', () => {
			const id = useEditorStore.getState().addTab('nql');
			useEditorStore.getState().setFilePath(id, '/path/to/users.dbsp');
			const tab = useEditorStore.getState().tabs[0]!;
			expect(tab.filePath).toBe('/path/to/users.dbsp');
			expect(tab.title).toBe('users.dbsp');
		});
	});

	describe('findTabByFilePath', () => {
		it('returns tab when filePath matches', () => {
			useEditorStore.getState().addTab('sql', '', '/path/query.sql');
			const found = useEditorStore
				.getState()
				.findTabByFilePath('/path/query.sql');
			expect(found).toBeDefined();
			expect(found!.filePath).toBe('/path/query.sql');
		});

		it('returns undefined when no match', () => {
			useEditorStore.getState().addTab('sql', '', '/path/query.sql');
			const found = useEditorStore.getState().findTabByFilePath('/other.sql');
			expect(found).toBeUndefined();
		});
	});

	describe('hasDirtyTabs', () => {
		it('returns false when no dirty tabs', () => {
			useEditorStore.getState().addTab();
			expect(useEditorStore.getState().hasDirtyTabs()).toBe(false);
		});

		it('returns true when a tab is dirty', () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().updateContent(id, 'changed');
			expect(useEditorStore.getState().hasDirtyTabs()).toBe(true);
		});
	});

	describe('getDirtyTabs', () => {
		it('returns only dirty tabs', () => {
			const id1 = useEditorStore.getState().addTab();
			useEditorStore.getState().addTab();
			useEditorStore.getState().updateContent(id1, 'changed');
			const dirty = useEditorStore.getState().getDirtyTabs();
			expect(dirty).toHaveLength(1);
			expect(dirty[0]!.id).toBe(id1);
		});
	});

	describe('markFileDeleted', () => {
		it('sets deleted flag and appends (deleted) to title', () => {
			const id = useEditorStore.getState().addTab('sql', '', '/path/query.sql');
			useEditorStore.getState().markFileDeleted(id);
			const tab = useEditorStore.getState().tabs[0]!;
			expect(tab.deleted).toBe(true);
			expect(tab.title).toBe('query.sql (deleted)');
		});

		it('does not double-mark already deleted tab', () => {
			const id = useEditorStore.getState().addTab('sql', '', '/path/query.sql');
			useEditorStore.getState().markFileDeleted(id);
			useEditorStore.getState().markFileDeleted(id);
			const tab = useEditorStore.getState().tabs[0]!;
			expect(tab.title).toBe('query.sql (deleted)');
		});

		it('does nothing for non-existent id', () => {
			useEditorStore.getState().addTab();
			useEditorStore.getState().markFileDeleted('non-existent');
			expect(useEditorStore.getState().tabs[0]!.deleted).toBeUndefined();
		});
	});
});

describe('getActiveTab', () => {
	beforeEach(() => {
		useEditorStore.setState({ tabs: [], activeTabId: null });
	});

	it('returns null when no active tab', () => {
		expect(getActiveTab(useEditorStore.getState())).toBeNull();
	});

	it('returns active tab', () => {
		useEditorStore.getState().addTab('sql', 'SELECT 1');
		const tab = getActiveTab(useEditorStore.getState());
		expect(tab).not.toBeNull();
		expect(tab!.content).toBe('SELECT 1');
	});
});
