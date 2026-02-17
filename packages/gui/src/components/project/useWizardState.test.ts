// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ConnectionFormData } from '@/components/connection/ConnectionDialog';
import { useWizardState } from './useWizardState';

const mockConnection: ConnectionFormData = {
	name: 'Test DB',
	type: 'postgresql',
	host: 'localhost',
	port: 5432,
	database: 'testdb',
	user: 'admin',
	password: 'secret',
	schema: 'public',
	sslMode: 'prefer',
};

describe('useWizardState', () => {
	// ── Initial state ──

	it('starts at step 0 with empty fields', () => {
		const { result } = renderHook(() => useWizardState());
		expect(result.current.step).toBe(0);
		expect(result.current.name).toBe('');
		expect(result.current.folderPath).toBe('');
		expect(result.current.connections).toEqual([]);
		expect(result.current.generateSchema).toBe(false);
	});

	it('pre-populates initial connection when provided', () => {
		const { result } = renderHook(() =>
			useWizardState({ initialConnection: mockConnection }),
		);
		expect(result.current.connections).toHaveLength(1);
		expect(result.current.connections[0]!.formData).toBe(mockConnection);
		expect(result.current.connections[0]!.environment).toBe('Test DB');
	});

	it('uses database name as environment fallback when connection has no name', () => {
		const noName = { ...mockConnection, name: '' };
		const { result } = renderHook(() =>
			useWizardState({ initialConnection: noName }),
		);
		expect(result.current.connections[0]!.environment).toBe('testdb');
	});

	// ── Navigation ──

	it('can advance from step 0 (intro) unconditionally', () => {
		const { result } = renderHook(() => useWizardState());
		expect(result.current.canGoNext()).toBe(true);
		act(() => result.current.goNext());
		expect(result.current.step).toBe(1);
	});

	it('blocks advance from step 1 when name is empty', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.goNext()); // → step 1
		expect(result.current.canGoNext()).toBe(false);
	});

	it('blocks advance from step 1 when folder is empty', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.goNext()); // → step 1
		act(() => result.current.setName('my-project'));
		expect(result.current.canGoNext()).toBe(false);
	});

	it('allows advance from step 1 when name and folder are set', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.goNext()); // → step 1
		act(() => {
			result.current.setName('my-project');
			result.current.setFolderPath('/home/user/projects');
		});
		expect(result.current.canGoNext()).toBe(true);
	});

	it('allows advance from step 2 (connections) with zero connections', () => {
		const { result } = renderHook(() => useWizardState());
		// Navigate to step 2
		act(() => result.current.goNext()); // 0→1
		act(() => {
			result.current.setName('proj');
			result.current.setFolderPath('/tmp');
		});
		act(() => result.current.goNext()); // 1→2
		expect(result.current.step).toBe(2);
		expect(result.current.canGoNext()).toBe(true);
	});

	it('goBack decrements step', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.goNext()); // → step 1
		act(() => result.current.goBack());
		expect(result.current.step).toBe(0);
	});

	it('goBack does nothing at step 0', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.goBack());
		expect(result.current.step).toBe(0);
	});

	it('goNext does nothing at step 3 (last)', () => {
		const { result } = renderHook(() => useWizardState());
		// Navigate to step 3
		act(() => result.current.goNext()); // 0→1
		act(() => {
			result.current.setName('proj');
			result.current.setFolderPath('/tmp');
		});
		act(() => result.current.goNext()); // 1→2
		act(() => result.current.goNext()); // 2→3
		expect(result.current.step).toBe(3);
		act(() => result.current.goNext()); // still 3
		expect(result.current.step).toBe(3);
	});

	it('goToStep navigates back to completed steps', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.goNext()); // 0→1
		act(() => {
			result.current.setName('proj');
			result.current.setFolderPath('/tmp');
		});
		act(() => result.current.goNext()); // 1→2
		act(() => result.current.goToStep(0));
		expect(result.current.step).toBe(0);
	});

	it('goToStep blocks forward if canGoNext is false', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.goNext()); // 0→1
		// name and folder are empty → canGoNext = false
		act(() => result.current.goToStep(2));
		expect(result.current.step).toBe(1); // didn't advance
	});

	// ── Connections ──

	it('addConnection appends a connection with auto-generated id', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => {
			result.current.addConnection(mockConnection);
		});
		expect(result.current.connections).toHaveLength(1);
		expect(result.current.connections[0]!.formData).toBe(mockConnection);
		expect(result.current.connections[0]!.id).toMatch(/^wiz-conn-/);
	});

	it('addConnection uses custom environment when provided', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => {
			result.current.addConnection(mockConnection, 'production');
		});
		expect(result.current.connections[0]!.environment).toBe('production');
	});

	it('addConnection derives environment from connection name', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => {
			result.current.addConnection(mockConnection);
		});
		expect(result.current.connections[0]!.environment).toBe('Test DB');
	});

	it('removeConnection removes by id', () => {
		const { result } = renderHook(() => useWizardState());
		let id: string;
		act(() => {
			id = result.current.addConnection(mockConnection);
		});
		expect(result.current.connections).toHaveLength(1);
		act(() => {
			result.current.removeConnection(id!);
		});
		expect(result.current.connections).toHaveLength(0);
	});

	it('updateEnvironment changes environment label', () => {
		const { result } = renderHook(() => useWizardState());
		let id: string;
		act(() => {
			id = result.current.addConnection(mockConnection);
		});
		act(() => {
			result.current.updateEnvironment(id!, 'staging');
		});
		expect(result.current.connections[0]!.environment).toBe('staging');
	});

	// ── Setters ──

	it('setGenerateSchema toggles schema generation', () => {
		const { result } = renderHook(() => useWizardState());
		act(() => result.current.setGenerateSchema(true));
		expect(result.current.generateSchema).toBe(true);
		act(() => result.current.setGenerateSchema(false));
		expect(result.current.generateSchema).toBe(false);
	});
});
