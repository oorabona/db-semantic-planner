import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStoreLoad, mockStoreGet, mockResolveProfile } = vi.hoisted(
	() => ({
		mockStoreLoad: vi.fn(),
		mockStoreGet: vi.fn(),
		mockResolveProfile: vi.fn(),
	}),
);

vi.mock('@tauri-apps/plugin-store', () => ({
	load: mockStoreLoad,
}));

vi.mock('./ipc', () => ({
	sidecarApi: {
		resolveProfile: mockResolveProfile,
	},
}));

import {
	ProfileResolutionError,
	parseProfileUri,
	resolveProfile,
} from './profile-resolver';

beforeEach(() => {
	vi.clearAllMocks();
	// Default: mockStoreLoad returns an object with .get()
	mockStoreLoad.mockResolvedValue({ get: mockStoreGet });
});

// ── parseProfileUri ──────────────────────────────────────────────

describe('parseProfileUri', () => {
	it('parses file:// URI', () => {
		const result = parseProfileUri('file://.env.local');
		expect(result).toEqual({ scheme: 'file', value: '.env.local' });
	});

	it('parses env:// URI', () => {
		const result = parseProfileUri('env://DATABASE_URL');
		expect(result).toEqual({ scheme: 'env', value: 'DATABASE_URL' });
	});

	it('parses store:// URI', () => {
		const result = parseProfileUri('store://dev-local');
		expect(result).toEqual({ scheme: 'store', value: 'dev-local' });
	});

	it('throws for invalid scheme', () => {
		expect(() => parseProfileUri('http://example.com')).toThrow(
			ProfileResolutionError,
		);
	});

	it('throws for empty URI', () => {
		expect(() => parseProfileUri('')).toThrow(ProfileResolutionError);
	});

	it('throws for URI without value', () => {
		expect(() => parseProfileUri('file://')).toThrow(ProfileResolutionError);
	});

	it('preserves paths with subdirectories', () => {
		const result = parseProfileUri('file://config/.env.staging');
		expect(result.value).toBe('config/.env.staging');
	});
});

// ── resolveProfile ───────────────────────────────────────────────

describe('resolveProfile', () => {
	describe('when scheme is file://', () => {
		it('delegates to sidecar API', async () => {
			// Arrange
			const expected = {
				host: 'localhost',
				port: 5432,
				database: 'mydb',
				user: 'user',
				password: 'pass',
			};
			mockResolveProfile.mockResolvedValue(expected);

			// Act
			const result = await resolveProfile(
				'file://.env.local',
				'/my/project',
			);

			// Assert
			expect(result).toEqual(expected);
			expect(mockResolveProfile).toHaveBeenCalledWith({
				uri: 'file://.env.local',
				projectPath: '/my/project',
			});
		});
	});

	describe('when scheme is env://', () => {
		it('delegates to sidecar API', async () => {
			// Arrange
			const expected = {
				host: 'staging.db.com',
				port: 5432,
				database: 'staging',
				user: 'app',
				password: 'secret',
			};
			mockResolveProfile.mockResolvedValue(expected);

			// Act
			const result = await resolveProfile('env://DATABASE_URL');

			// Assert
			expect(result).toEqual(expected);
			expect(mockResolveProfile).toHaveBeenCalledWith({
				uri: 'env://DATABASE_URL',
				projectPath: undefined,
			});
		});
	});

	describe('when scheme is store://', () => {
		it('reads from Tauri secure store', async () => {
			// Arrange
			const stored = {
				host: 'localhost',
				port: 5432,
				database: 'devdb',
				user: 'dev',
				password: 'devpass',
			};
			mockStoreGet.mockResolvedValue(stored);

			// Act
			const result = await resolveProfile('store://dev-local');

			// Assert
			expect(result).toEqual(stored);
			expect(mockStoreLoad).toHaveBeenCalledWith('credentials.json');
			expect(mockStoreGet).toHaveBeenCalledWith('profile:dev-local');
		});

		it('throws when store key does not exist', async () => {
			// Arrange
			mockStoreGet.mockResolvedValue(null);

			// Act & Assert
			await expect(resolveProfile('store://missing')).rejects.toThrow(
				ProfileResolutionError,
			);
		});

		it('error message includes the key name', async () => {
			// Arrange
			mockStoreGet.mockResolvedValue(null);

			// Act & Assert
			try {
				await resolveProfile('store://missing-key');
			} catch (e) {
				expect(e).toBeInstanceOf(ProfileResolutionError);
				expect((e as ProfileResolutionError).uri).toBe(
					'store://missing-key',
				);
				expect((e as ProfileResolutionError).reason).toContain(
					'profile:missing-key',
				);
			}
		});
	});

	describe('when URI is invalid', () => {
		it('throws ProfileResolutionError', async () => {
			await expect(resolveProfile('bad-uri')).rejects.toThrow(
				ProfileResolutionError,
			);
		});
	});
});
