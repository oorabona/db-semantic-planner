import { describe, expect, it } from 'vitest';
import { serializeCliJson } from './output.js';

describe('SC-67 CLI JSON serializer', () => {
	it('emits a parseable, single JSON document', () => {
		const document = serializeCliJson({ name: 'users\n\u001b[2J', ok: true });
		expect(JSON.parse(document)).toEqual({
			name: 'users\n\u001b[2J',
			ok: true,
		});
		expect(document).toContain('\\n');
	});
});
