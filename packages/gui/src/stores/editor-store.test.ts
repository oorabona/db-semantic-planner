import { describe, expect, it, beforeEach } from "vitest";
import { useEditorStore, getActiveTab } from "./editor-store.js";

describe("useEditorStore", () => {
	beforeEach(() => {
		useEditorStore.setState({
			tabs: [],
			activeTabId: null,
		});
	});

	describe("addTab", () => {
		it("creates SQL tab by default", () => {
			const id = useEditorStore.getState().addTab();
			expect(useEditorStore.getState().tabs).toHaveLength(1);
			expect(useEditorStore.getState().tabs[0]!.language).toBe("sql");
			expect(useEditorStore.getState().activeTabId).toBe(id);
		});

		it("creates NQL tab", () => {
			useEditorStore.getState().addTab("nql");
			expect(useEditorStore.getState().tabs[0]!.language).toBe("nql");
			expect(useEditorStore.getState().tabs[0]!.title).toMatch(/\.dbsp$/);
		});

		it("creates tab with initial content", () => {
			useEditorStore.getState().addTab("sql", "SELECT 1");
			expect(useEditorStore.getState().tabs[0]!.content).toBe("SELECT 1");
		});

		it("creates tab with file path", () => {
			useEditorStore.getState().addTab("sql", "SELECT 1", "/path/to/query.sql");
			expect(useEditorStore.getState().tabs[0]!.title).toBe("query.sql");
			expect(useEditorStore.getState().tabs[0]!.filePath).toBe("/path/to/query.sql");
		});

		it("sets new tab as active", () => {
			const id1 = useEditorStore.getState().addTab();
			const id2 = useEditorStore.getState().addTab();
			expect(useEditorStore.getState().activeTabId).toBe(id2);
			expect(id1).not.toBe(id2);
		});
	});

	describe("closeTab", () => {
		it("removes tab", () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().closeTab(id);
			expect(useEditorStore.getState().tabs).toHaveLength(0);
			expect(useEditorStore.getState().activeTabId).toBeNull();
		});

		it("activates neighbor when closing active", () => {
			useEditorStore.getState().addTab();
			const id2 = useEditorStore.getState().addTab();
			const id3 = useEditorStore.getState().addTab();
			// Active is id3, close it
			useEditorStore.getState().closeTab(id3);
			expect(useEditorStore.getState().activeTabId).toBe(id2);
		});

		it("does nothing for non-existent id", () => {
			useEditorStore.getState().addTab();
			useEditorStore.getState().closeTab("non-existent");
			expect(useEditorStore.getState().tabs).toHaveLength(1);
		});
	});

	describe("setActiveTab", () => {
		it("switches active tab", () => {
			const id1 = useEditorStore.getState().addTab();
			useEditorStore.getState().addTab();
			useEditorStore.getState().setActiveTab(id1);
			expect(useEditorStore.getState().activeTabId).toBe(id1);
		});
	});

	describe("updateContent", () => {
		it("updates content and marks dirty", () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().updateContent(id, "SELECT * FROM users");
			const tab = useEditorStore.getState().tabs[0]!;
			expect(tab.content).toBe("SELECT * FROM users");
			expect(tab.dirty).toBe(true);
		});
	});

	describe("renameTab", () => {
		it("renames tab", () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().renameTab(id, "My Query.sql");
			expect(useEditorStore.getState().tabs[0]!.title).toBe("My Query.sql");
		});
	});

	describe("markSaved", () => {
		it("clears dirty flag", () => {
			const id = useEditorStore.getState().addTab();
			useEditorStore.getState().updateContent(id, "modified");
			expect(useEditorStore.getState().tabs[0]!.dirty).toBe(true);
			useEditorStore.getState().markSaved(id);
			expect(useEditorStore.getState().tabs[0]!.dirty).toBe(false);
		});
	});
});

describe("getActiveTab", () => {
	beforeEach(() => {
		useEditorStore.setState({ tabs: [], activeTabId: null });
	});

	it("returns null when no active tab", () => {
		expect(getActiveTab(useEditorStore.getState())).toBeNull();
	});

	it("returns active tab", () => {
		useEditorStore.getState().addTab("sql", "SELECT 1");
		const tab = getActiveTab(useEditorStore.getState());
		expect(tab).not.toBeNull();
		expect(tab!.content).toBe("SELECT 1");
	});
});
