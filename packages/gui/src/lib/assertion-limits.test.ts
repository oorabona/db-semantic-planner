import { describe, expect, it } from 'vitest';
import {
	ASSERTION_TIMEOUT_MS,
	MAX_ASSERT_FILE_SIZE,
	MAX_ASSERTION_COUNT,
	MAX_DBSP_FILE_SIZE,
	countAssertionBlocks,
	validateAssertionContent,
	validateDbspContent,
	withTimeout,
} from './assertion-limits';

// ── validateAssertionContent ─────────────────────────────────────

describe('validateAssertionContent', () => {
	it('returns null for valid content', () => {
		const content = '--- query: 1\nsql.equals: SELECT 1';
		expect(validateAssertionContent(content)).toBeNull();
	});

	it('rejects empty content', () => {
		expect(validateAssertionContent('')).toEqual({
			message: 'Assertion file is empty.',
		});
	});

	it('rejects whitespace-only content', () => {
		expect(validateAssertionContent('   \n  \n  ')).toEqual({
			message: 'Assertion file is empty.',
		});
	});

	it('rejects content exceeding max file size', () => {
		// Create content just over the limit
		const content = 'x'.repeat(MAX_ASSERT_FILE_SIZE + 1);
		const result = validateAssertionContent(content);
		expect(result).not.toBeNull();
		expect(result!.message).toContain('too large');
		expect(result!.message).toContain('Maximum');
	});

	it('accepts content at exactly the max file size', () => {
		const content = 'x'.repeat(MAX_ASSERT_FILE_SIZE);
		expect(validateAssertionContent(content)).toBeNull();
	});

	it('rejects content with too many assertion blocks', () => {
		const blocks = Array.from(
			{ length: MAX_ASSERTION_COUNT + 1 },
			(_, i) => `--- query: ${i + 1}\nsql.equals: SELECT ${i + 1}`,
		).join('\n');
		const result = validateAssertionContent(blocks);
		expect(result).not.toBeNull();
		expect(result!.message).toContain('Too many assertion blocks');
		expect(result!.message).toContain(`${MAX_ASSERTION_COUNT + 1}`);
	});

	it('accepts content at exactly the max assertion count', () => {
		const blocks = Array.from(
			{ length: MAX_ASSERTION_COUNT },
			(_, i) => `--- query: ${i + 1}\nsql.equals: SELECT ${i + 1}`,
		).join('\n');
		expect(validateAssertionContent(blocks)).toBeNull();
	});
});

// ── validateDbspContent ──────────────────────────────────────────

describe('validateDbspContent', () => {
	it('returns null for valid content', () => {
		expect(validateDbspContent('users | where active = true')).toBeNull();
	});

	it('rejects empty content', () => {
		expect(validateDbspContent('')).toEqual({
			message: 'Query file is empty.',
		});
	});

	it('rejects content exceeding max file size', () => {
		const content = 'x'.repeat(MAX_DBSP_FILE_SIZE + 1);
		const result = validateDbspContent(content);
		expect(result).not.toBeNull();
		expect(result!.message).toContain('too large');
	});
});

// ── countAssertionBlocks ─────────────────────────────────────────

describe('countAssertionBlocks', () => {
	it('returns 0 for content without blocks', () => {
		expect(countAssertionBlocks('just some text')).toBe(0);
	});

	it('counts single block', () => {
		expect(countAssertionBlocks('--- query: 1\nsql.equals: SELECT 1')).toBe(1);
	});

	it('counts multiple blocks', () => {
		const content = [
			'--- query: 1',
			'sql.equals: SELECT 1',
			'--- query: 2',
			'sql.equals: SELECT 2',
			'--- query: 3',
			'success: true',
		].join('\n');
		expect(countAssertionBlocks(content)).toBe(3);
	});

	it('handles leading whitespace before ---', () => {
		expect(countAssertionBlocks('  --- query: 1')).toBe(1);
	});
});

// ── withTimeout ──────────────────────────────────────────────────

describe('withTimeout', () => {
	it('resolves when promise completes before timeout', async () => {
		const result = await withTimeout(
			Promise.resolve(42),
			1000,
			'test operation',
		);
		expect(result).toBe(42);
	});

	it('rejects when promise times out', async () => {
		const neverResolves = new Promise<number>(() => {});
		await expect(
			withTimeout(neverResolves, 10, 'slow operation'),
		).rejects.toThrow('slow operation timed out after 0.01s');
	});

	it('propagates original error when promise rejects before timeout', async () => {
		const failing = Promise.reject(new Error('original error'));
		await expect(
			withTimeout(failing, 1000, 'failing operation'),
		).rejects.toThrow('original error');
	});
});

// ── Constants sanity check ───────────────────────────────────────

describe('constants', () => {
	it('ASSERTION_TIMEOUT_MS is 30 seconds', () => {
		expect(ASSERTION_TIMEOUT_MS).toBe(30_000);
	});

	it('MAX_ASSERT_FILE_SIZE is 512 KB', () => {
		expect(MAX_ASSERT_FILE_SIZE).toBe(512 * 1024);
	});

	it('MAX_ASSERTION_COUNT is 200', () => {
		expect(MAX_ASSERTION_COUNT).toBe(200);
	});
});
