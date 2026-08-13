import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const guide = readFileSync(join(process.cwd(), 'guide/cli-usage.md'), 'utf8');

describe('CLI usage guide', () => {
	it('OBL-CLI5 documents commands with their required runnable arguments', () => {
		expect(guide).toContain(
			'dbsp plan ./schema.ts --db "$DATABASE_URL" --schema public',
		);
		expect(guide).toContain(
			'dbsp apply "$RUN_ID" --db "$DATABASE_URL" --plan-digest "$PLAN_DIGEST"',
		);
		expect(guide).toContain(
			'dbsp inspect table:users --db "$DATABASE_URL" --schema public --format json',
		);
	});
});
