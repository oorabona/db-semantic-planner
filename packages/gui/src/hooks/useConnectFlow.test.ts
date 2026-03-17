// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/stores/connection-store';
import { useConnectFlow } from './useConnectFlow';

// ── Mocks ────────────────────────────────────────────────────────

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockConnectFromProfile = vi.fn();

vi.mock('@/hooks/useConnection', () => ({
	useConnection: () => ({
		connect: mockConnect,
		disconnect: mockDisconnect,
		connectFromProfile: mockConnectFromProfile,
		testConnection: vi.fn(),
		testResult: null,
		saveProfile: vi.fn(),
		deleteProfile: vi.fn(),
	}),
}));

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

const { toast } = await import('sonner');

// ── Fixtures ─────────────────────────────────────────────────────

function makeProfile(
	overrides?: Partial<ConnectionProfile>,
): ConnectionProfile {
	return {
		id: 'prof-1',
		name: 'dev-local',
		type: 'postgresql',
		config: {
			host: 'localhost',
			port: 5432,
			database: 'mydb',
			user: 'app',
			schema: 'public',
			sslMode: 'disable',
		},
		environment: 'dev',
		createdAt: Date.now(),
		lastUsedAt: null,
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────

describe('useConnectFlow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDisconnect.mockResolvedValue(undefined);
	});

	it('quickConnect succeeds without password → no prompt', async () => {
		mockConnectFromProfile.mockResolvedValue({
			connectionId: 'c1',
			database: 'mydb',
			schema: 'public',
		});
		const { result } = renderHook(() => useConnectFlow());

		await act(async () => {
			await result.current.quickConnect(makeProfile());
		});

		expect(result.current.promptOpen).toBe(false);
		expect(mockConnectFromProfile).toHaveBeenCalledWith(expect.anything(), '');
	});

	it('quickConnect disconnects current connection first (INV-06)', async () => {
		mockConnectFromProfile.mockResolvedValue({
			connectionId: 'c1',
			database: 'mydb',
			schema: 'public',
		});
		const { result } = renderHook(() => useConnectFlow());

		await act(async () => {
			await result.current.quickConnect(makeProfile());
		});

		expect(mockDisconnect).toHaveBeenCalled();
	});

	it('quickConnect auth failure → opens PasswordPrompt', async () => {
		mockConnectFromProfile.mockRejectedValue(
			new Error('password authentication failed for user "app"'),
		);
		const { result } = renderHook(() => useConnectFlow());

		await act(async () => {
			await result.current.quickConnect(makeProfile());
		});

		expect(result.current.promptOpen).toBe(true);
		expect(result.current.promptProfile?.name).toBe('dev-local');
		expect(result.current.connecting).toBe(false);
	});

	it('quickConnect non-auth failure → toast error, no prompt (ERR-07)', async () => {
		mockConnectFromProfile.mockRejectedValue(
			new Error('connect ECONNREFUSED 127.0.0.1:5432'),
		);
		const { result } = renderHook(() => useConnectFlow());

		await act(async () => {
			await result.current.quickConnect(makeProfile());
		});

		expect(result.current.promptOpen).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining('ECONNREFUSED'),
		);
	});

	it('submitPassword success → closes prompt', async () => {
		// First, trigger auth failure to open prompt
		mockConnectFromProfile.mockRejectedValueOnce(
			new Error('password authentication failed'),
		);
		const { result } = renderHook(() => useConnectFlow());

		await act(async () => {
			await result.current.quickConnect(makeProfile());
		});
		expect(result.current.promptOpen).toBe(true);

		// Now submit password successfully
		mockConnectFromProfile.mockResolvedValueOnce({
			connectionId: 'c1',
			database: 'mydb',
			schema: 'public',
		});
		await act(async () => {
			await result.current.submitPassword('secret123');
		});

		expect(result.current.promptOpen).toBe(false);
		expect(mockConnectFromProfile).toHaveBeenLastCalledWith(
			expect.anything(),
			'secret123',
		);
	});

	it('submitPassword failure → shows error in prompt', async () => {
		mockConnectFromProfile.mockRejectedValueOnce(
			new Error('password authentication failed'),
		);
		const { result } = renderHook(() => useConnectFlow());

		await act(async () => {
			await result.current.quickConnect(makeProfile());
		});

		mockConnectFromProfile.mockRejectedValueOnce(new Error('wrong password'));
		await act(async () => {
			await result.current.submitPassword('bad-pass');
		});

		expect(result.current.promptOpen).toBe(true);
		expect(result.current.promptError).toBe('Error: wrong password');
	});

	it('cancelPassword → closes prompt', async () => {
		mockConnectFromProfile.mockRejectedValueOnce(
			new Error('password authentication failed'),
		);
		const { result } = renderHook(() => useConnectFlow());

		await act(async () => {
			await result.current.quickConnect(makeProfile());
		});
		expect(result.current.promptOpen).toBe(true);

		act(() => {
			result.current.cancelPassword();
		});

		expect(result.current.promptOpen).toBe(false);
		expect(result.current.promptProfile).toBeNull();
	});
});
