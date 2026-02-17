/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { normalizePath, sanitizeFolderName } from './project-id';

describe('normalizePath', () => {
	it('strips trailing slashes', () => {
		expect(normalizePath('/home/user/project/')).toBe('/home/user/project');
	});

	it('resolves .. segments', () => {
		expect(normalizePath('/home/user/foo/../project')).toBe(
			'/home/user/project',
		);
	});

	it('resolves . segments', () => {
		expect(normalizePath('/home/user/./project')).toBe('/home/user/project');
	});

	it('normalizes multiple slashes', () => {
		expect(normalizePath('/home//user///project')).toBe('/home/user/project');
	});

	it('keeps root slash', () => {
		expect(normalizePath('/')).toBe('/');
	});

	it('converts backslashes to forward slashes', () => {
		const result = normalizePath('/home\\user\\project');
		expect(result).toContain('/home');
		expect(result).not.toContain('\\');
	});
});

describe('sanitizeFolderName', () => {
	it('lowercases', () => {
		expect(sanitizeFolderName('MyProject')).toBe('myproject');
	});

	it('replaces spaces with dashes', () => {
		expect(sanitizeFolderName('My Project')).toBe('my-project');
	});

	it('strips unsafe characters', () => {
		expect(sanitizeFolderName('project<>:name')).toBe('projectname');
	});

	it('collapses multiple separators', () => {
		expect(sanitizeFolderName('my---project___name')).toBe('my-project-name');
	});

	it('trims leading/trailing separators', () => {
		expect(sanitizeFolderName('--project--')).toBe('project');
	});

	it('falls back to "project" for empty result', () => {
		expect(sanitizeFolderName(':::???')).toBe('project');
		expect(sanitizeFolderName('')).toBe('project');
	});

	it('handles realistic project names', () => {
		expect(sanitizeFolderName('db-semantic-planner')).toBe(
			'db-semantic-planner',
		);
		expect(sanitizeFolderName('My Awesome App v2.0')).toBe(
			'my-awesome-app-v2.0',
		);
	});
});
