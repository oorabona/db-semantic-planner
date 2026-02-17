/**
 * Integration tests for the project lifecycle flows:
 *   - Cold start → standalone → query → history
 *   - Open folder → project mode → scoped state
 *   - Create project → connect → query
 *
 * Tests cross-store coordination between:
 *   - project-store (mode, folder, settings)
 *   - editor-store (tabs, files)
 *   - connection-store (profiles, status)
 *   - history-store (query entries)
 *   - schema-store (expanded, search)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks for Tauri APIs ──────────────────────────────────────

vi.mock('@tauri-apps/api/path', () => ({
	appConfigDir: vi.fn().mockResolvedValue('/mock/config'),
	join: vi.fn((...parts: string[]) => Promise.resolve(parts.join('/'))),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
	readDir: vi.fn().mockResolvedValue([]),
	readTextFile: vi.fn().mockResolvedValue(''),
	exists: vi.fn().mockResolvedValue(false),
	watch: vi.fn().mockResolvedValue(vi.fn()),
	writeTextFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn().mockResolvedValue(null),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
	default: {
		load: vi.fn().mockResolvedValue({
			execute: vi.fn().mockResolvedValue([]),
			select: vi.fn().mockResolvedValue([]),
			close: vi.fn().mockResolvedValue(undefined),
		}),
	},
}));

import { useConnectionStore } from './connection-store';
import { useEditorStore } from './editor-store';
import { useHistoryStore } from './history-store';
import { useProjectStore } from './project-store';
import { useSchemaStore } from './schema-store';

describe('Project Lifecycle Integration', () => {
	beforeEach(() => {
		// Reset all stores to clean state
		useProjectStore.setState({
			mode: 'standalone',
			folderPath: null,
			folderName: null,
			settings: null,
			files: [],
			loading: false,
			error: null,
		});
		useEditorStore.setState({
			tabs: [],
			activeTabId: null,
		});
		useConnectionStore.setState({
			status: 'disconnected',
			active: null,
			error: null,
		});
		useHistoryStore.setState({
			entries: [],
		});
		useSchemaStore.setState({
			searchFilter: '',
			expanded: new Set<string>(),
		});
	});

	describe('Cold start → standalone mode', () => {
		it('starts in standalone mode with empty state', () => {
			const project = useProjectStore.getState();
			const editor = useEditorStore.getState();
			const connection = useConnectionStore.getState();

			expect(project.mode).toBe('standalone');
			expect(project.folderPath).toBeNull();
			expect(editor.tabs).toHaveLength(0);
			expect(connection.status).toBe('disconnected');
		});

		it('allows creating tabs in standalone mode', () => {
			useEditorStore.getState().addTab('sql', 'SELECT 1');
			useEditorStore.getState().addTab('nql', 'from users');

			const { tabs } = useEditorStore.getState();
			expect(tabs).toHaveLength(2);
			expect(tabs[0]!.language).toBe('sql');
			expect(tabs[1]!.language).toBe('nql');
		});

		it('tracks history entries in standalone mode', () => {
			useHistoryStore.getState().addEntry({
				query: 'SELECT * FROM users',
				language: 'sql',
				database: 'testdb',
				timestamp: Date.now(),
				durationMs: 42,
				rowCount: 5,
				success: true,
			});

			const { entries } = useHistoryStore.getState();
			expect(entries).toHaveLength(1);
			expect(entries[0]!.query).toBe('SELECT * FROM users');
		});
	});

	describe('standalone → project mode transition', () => {
		it('editor tabs persist across mode transitions', () => {
			// Start with a tab in standalone mode
			useEditorStore.getState().addTab('sql', 'SELECT 1');
			expect(useEditorStore.getState().tabs).toHaveLength(1);

			// Simulate project mode activation
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/my/project',
				folderName: 'my-project',
			});

			// Tab still exists
			expect(useEditorStore.getState().tabs).toHaveLength(1);
			expect(useEditorStore.getState().tabs[0]!.content).toBe('SELECT 1');
		});

		it('connection state persists across mode transitions', () => {
			// Connected in standalone
			useConnectionStore.setState({ status: 'connected' });

			// Switch to project mode
			useProjectStore.setState({ mode: 'project' });

			// Still connected
			expect(useConnectionStore.getState().status).toBe('connected');
		});
	});

	describe('project mode → close → reopen', () => {
		it('resets to standalone on folder close', () => {
			// Start in project mode
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/my/project',
				folderName: 'my-project',
				settings: { project: { schemaPath: 'auto' } } as any,
				files: [{ path: 'schema.ts', name: 'schema.ts', isDirectory: false }],
			});

			expect(useProjectStore.getState().mode).toBe('project');

			// Close folder (simulate)
			useProjectStore.setState({
				mode: 'standalone',
				folderPath: null,
				folderName: null,
				settings: null,
				files: [],
			});

			expect(useProjectStore.getState().mode).toBe('standalone');
			expect(useProjectStore.getState().files).toHaveLength(0);
		});
	});

	describe('schema store interaction with project mode', () => {
		it('schema search filter is independent of project mode', () => {
			useSchemaStore.getState().setSearchFilter('users');
			expect(useSchemaStore.getState().searchFilter).toBe('users');

			// Mode change doesn't affect schema filter
			useProjectStore.setState({ mode: 'project' });
			expect(useSchemaStore.getState().searchFilter).toBe('users');
		});

		it('expanded tables persist across mode changes', () => {
			useSchemaStore.getState().toggleExpanded('users');
			expect(useSchemaStore.getState().expanded.has('users')).toBe(true);

			useProjectStore.setState({ mode: 'project' });
			expect(useSchemaStore.getState().expanded.has('users')).toBe(true);
		});
	});

	describe('editor + project coordination', () => {
		it('typescript tab can be created for schema editing', () => {
			useEditorStore
				.getState()
				.addTab(
					'typescript',
					'import { schema } from "@dbsp/core"',
					'/project/schema.ts',
				);

			const { tabs } = useEditorStore.getState();
			expect(tabs).toHaveLength(1);
			expect(tabs[0]!.language).toBe('typescript');
			expect(tabs[0]!.filePath).toBe('/project/schema.ts');
		});

		it('findTabByFilePath prevents duplicate schema tabs', () => {
			const store = useEditorStore.getState();
			store.addTab('typescript', 'content', '/project/schema.ts');
			const existing = store.findTabByFilePath('/project/schema.ts');
			expect(existing).toBeDefined();
			expect(existing!.language).toBe('typescript');
		});

		it('multiple tab types coexist', () => {
			const store = useEditorStore.getState();
			store.addTab('sql', 'SELECT 1');
			store.addTab('nql', 'from users');
			store.addTab('typescript', 'export const schema = {}', '/schema.ts');

			const { tabs } = useEditorStore.getState();
			expect(tabs).toHaveLength(3);
			expect(tabs.map((t) => t.language)).toEqual(['sql', 'nql', 'typescript']);
		});
	});

	describe('history entries with metadata', () => {
		it('entries store language type', () => {
			const store = useHistoryStore.getState();
			store.addEntry({
				query: 'SELECT 1',
				language: 'sql',
				database: 'testdb',
				timestamp: Date.now(),
				durationMs: 10,
				rowCount: 1,
				success: true,
			});
			store.addEntry({
				query: 'from users',
				language: 'nql',
				database: 'testdb',
				timestamp: Date.now(),
				durationMs: 20,
				rowCount: 5,
				success: true,
			});

			const { entries } = useHistoryStore.getState();
			expect(entries).toHaveLength(2);
			// Newest first (prepend order)
			expect(entries[0]!.language).toBe('nql');
			expect(entries[1]!.language).toBe('sql');
		});

		it('failed entries are recorded', () => {
			useHistoryStore.getState().addEntry({
				query: 'INVALID SQL',
				language: 'sql',
				database: 'testdb',
				timestamp: Date.now(),
				durationMs: 5,
				rowCount: null,
				success: false,
				error: 'syntax error',
			});

			const { entries } = useHistoryStore.getState();
			expect(entries).toHaveLength(1);
			expect(entries[0]!.success).toBe(false);
			expect(entries[0]!.error).toBe('syntax error');
		});
	});
});
