
import { describe, expect, it } from 'vitest';
import { like } from '../filters.js';

describe('like() with escape option', () => {
	it('produces escape field when escape option is given', () => {
		const intent = like('name', '\\_unused%', { escape: '\\' });
		expect(intent.kind).toBe('like');
		expect(intent.field).toBe('name');
		expect(intent.pattern).toBe('\\_unused%');
		expect(intent.escape).toBe('\\');
	});

	it('has no escape field when not specified', () => {
		const intent = like('name', '%foo%');
		expect(intent.escape).toBeUndefined();
	});

	it('boolean backward compat: true sets caseInsensitive, no escape', () => {
		const intent = like('name', '%foo%', true);
		expect(intent.caseInsensitive).toBe(true);
		expect(intent.escape).toBeUndefined();
	});

	it('boolean backward compat: false sets caseInsensitive to false, no escape', () => {
		const intent = like('name', '%foo%', false);
		expect(intent.caseInsensitive).toBe(false);
		expect(intent.escape).toBeUndefined();
	});

	it('object form sets both caseInsensitive and escape', () => {
		const intent = like('name', '\\_foo%', { caseInsensitive: true, escape: '\\' });
		expect(intent.caseInsensitive).toBe(true);
		expect(intent.escape).toBe('\\');
	});

	it('object form with only escape leaves caseInsensitive undefined', () => {
		const intent = like('col', 'pat\\_%', { escape: '\\' });
		expect(intent.caseInsensitive).toBeUndefined();
		expect(intent.escape).toBe('\\');
	});
});
