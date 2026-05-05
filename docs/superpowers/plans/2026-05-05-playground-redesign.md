# Playground Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `/playground` as a demo-first surface — schema collapsed top, query stacked above a Plan-as-hero output, auto-compile on mount, URL-hash sharing via native `CompressionStream`, and a sticky top error banner for init-time anomalies.

**Architecture:** Parent-owns-state pattern. `Playground.vue` orchestrates lifecycle (mount + `hashchange` + `onBeforeUnmount`), state, compile flow, hash sync, and module imports. Six presentational sub-components in `packages/docs/.vitepress/theme/playground/` receive data via `defineProps` and signal user gestures via `defineEmits`. Mermaid is lazy-loaded after the critical path so the auto-compile hero isn't gated on it. Hash payload is versioned (`{v:1, …}`); decode rejects unknown `v`/`m` with a non-fatal banner; encoder enforces a `MAX_HASH_LENGTH` cap.

**Tech Stack:** Vue 3 (`<script setup>`), VitePress 1.6, native `CompressionStream`, vitest (newly added to docs package for pure-helper unit tests), pnpm workspace.

**Spec reference:** `docs/superpowers/specs/2026-05-05-playground-redesign-design.md` (commit `df78929` on `main`).

**Branching:** Branch off `main` as `feat/playground-redesign`. Do NOT branch from `feat/playground-polish` (that PR is in flight). Confirm `main` has both `f9df9ad` (spec v1) and `df78929` (spec v2) before starting.

**Approval gate:** PR #104 (T2 polish) MUST be merged into `main` before this work begins. The redesign rewrites `Playground.vue` wholesale — the polish work needs to land first or the redesign rewrites a moving target.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `packages/docs/vitest.config.ts` | **Create** | Minimal vitest config for pure-helper unit tests |
| `packages/docs/package.json` | **Modify** | Add `test` script wired to vitest |
| `packages/docs/.vitepress/theme/playground/types.ts` | **Create** | Shared TS types (`ErrorBannerData`, `HashPayloadV1`, public-facing types) |
| `packages/docs/.vitepress/theme/playground/sanitize.ts` | **Create** | `validateIdentifier`, `validatePayload`, size caps |
| `packages/docs/.vitepress/theme/playground/sanitize.test.ts` | **Create** | Unit tests for sanitize helpers |
| `packages/docs/.vitepress/theme/playground/hash-codec.ts` | **Create** | `encodeHash`, `decodeHash`, `MAX_HASH_LENGTH`, `HASH_VERSION` |
| `packages/docs/.vitepress/theme/playground/hash-codec.test.ts` | **Create** | Unit tests for codec roundtrip + edge cases |
| `packages/docs/.vitepress/theme/playground/ErrorBanner.vue` | **Create** | Sticky top error banner, severity-aware |
| `packages/docs/.vitepress/theme/playground/SchemaSection.vue` | **Create** | Collapsed bar + expandable editor (DSL/Diagram/TS); pointer-event pan/zoom |
| `packages/docs/.vitepress/theme/playground/QuerySection.vue` | **Create** | Mode toggle (TS disabled v1) + example dropdown + textarea + Compile button |
| `packages/docs/.vitepress/theme/playground/PlanSection.vue` | **Create** | Meta strip + warnings + CTEs |
| `packages/docs/.vitepress/theme/playground/PlanDecisions.vue` | **Create** | Decision-card list with local `Map<id, signature>` watcher |
| `packages/docs/.vitepress/theme/playground/OutputSection.vue` | **Create** | SQL/Params sub-tabs + Copy buttons |
| `packages/docs/.vitepress/theme/Playground.vue` | **Rewrite** | Parent: state, lifecycle, compile flow, hash sync, module imports |
| `packages/docs/.vitepress/theme/index.ts` | (no change) | Already imports/registers `Playground` |

Total expected delta: 1 rewrite (~500 LoC down from current ~1700 thanks to extraction), 11 new files (~1500 LoC across all), 2 small-config additions.

---

## Pre-task setup

- [ ] **Step 0.1: Confirm prerequisites**

```bash
git fetch origin
git checkout main
git pull
git log --oneline -5
# Expected: at minimum `df78929` (spec v2) and `f9df9ad` (spec v1) reachable.
# If PR #104 (T2 polish) shows as merged in `gh pr view 104`, that's the
# happy-path starting state. If still open, ask the user before starting.
```

- [ ] **Step 0.2: Create the branch**

```bash
git checkout -b feat/playground-redesign
git branch --show-current
# Expected: feat/playground-redesign
```

- [ ] **Step 0.3: Open the spec for reference (in another tab/pane)**

```bash
less docs/superpowers/specs/2026-05-05-playground-redesign-design.md
```

Keep this open. Every task references back to it.

---

### Task 1: Add vitest harness to the docs package

**Why:** The pure helpers (`sanitize.ts`, `hash-codec.ts`) need unit tests. Other packages (`core`, `adapter-pgsql`, `cli`, `gui`) already use vitest; the docs package doesn't, so we add the minimal config.

**Files:**
- Create: `packages/docs/vitest.config.ts`
- Modify: `packages/docs/package.json` (add `test` script)

- [ ] **Step 1.1: Read the existing vitest config from another package as reference**

Run: `cat packages/core/vitest.config.ts | head -30`

Note the import + `defineConfig` pattern, environment, include globs.

- [ ] **Step 1.2: Create the docs vitest config**

Create `packages/docs/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'happy-dom',
		include: ['.vitepress/theme/**/*.test.ts'],
		// Fast-skip docs site E2E (none here, but explicit).
		exclude: ['node_modules', 'dist'],
	},
});
```

**Note on `happy-dom`:** Required for the hash-codec tests because they use `TextEncoder`, `Response`, and `CompressionStream` — `happy-dom` provides browser-shaped globals. If `happy-dom` isn't already a dev dep at the workspace root, add it.

- [ ] **Step 1.3: Add `happy-dom` as a workspace dev dep if missing**

Check first:

```bash
pnpm list -r happy-dom 2>&1 | head -5
```

If it's not listed: `pnpm add -Dw happy-dom`. (`-w` adds at workspace root, shared across packages.)

- [ ] **Step 1.4: Add the test script to packages/docs/package.json**

Edit the `"scripts"` object inside `packages/docs/package.json` so it reads:

```json
"scripts": {
  "dev": "vitepress dev",
  "build": "vitepress build .",
  "preview": "vitepress preview",
  "test": "vitest run"
}
```

- [ ] **Step 1.5: Sanity-check vitest can launch on an empty test set**

```bash
pnpm -C packages/docs test 2>&1 | tail -10
```

Expected: vitest reports "No test files found, exiting with code 0" or equivalent. If it errors on missing dependency, fix the dep before moving on.

- [ ] **Step 1.6: Commit**

```bash
git add packages/docs/vitest.config.ts packages/docs/package.json pnpm-lock.yaml
git commit -m "build(docs): add vitest harness for pure-helper unit tests"
```

---

### Task 2: Sanitization helpers (TDD)

**Why:** Spec § "Security & sanitization" — hash payloads are arbitrary internet input. Validate identifier shape and size caps before applying to refs.

**Files:**
- Create: `packages/docs/.vitepress/theme/playground/types.ts` (used here + downstream)
- Create: `packages/docs/.vitepress/theme/playground/sanitize.ts`
- Test:   `packages/docs/.vitepress/theme/playground/sanitize.test.ts`

- [ ] **Step 2.1: Write the types module**

Create `packages/docs/.vitepress/theme/playground/types.ts`:

```ts
/**
 * Local types for Playground sub-components. Public API of theme/playground/
 * is INTENTIONALLY narrow — only the parent (Playground.vue) consumes these.
 */

export interface ErrorBannerData {
	readonly severity: 'warn' | 'fatal';
	readonly title: string;
	readonly message: string;
	readonly actions: readonly ErrorBannerAction[];
}

export interface ErrorBannerAction {
	readonly label: string;
	readonly handler: () => void;
}

/**
 * Shape of a v1 URL hash payload. New version → bump HASH_VERSION,
 * add a discriminated union here.
 */
export interface HashPayloadV1 {
	readonly v: 1;
	readonly s: string; // schema DSL
	readonly n: string; // NQL query
	readonly m: 'nql'; // mode — `'ts'` lands in v2 once T3 ships
}

/** Maximum size of a decoded schema DSL payload, in bytes. */
export const MAX_SCHEMA_BYTES = 8 * 1024;

/** Maximum size of a decoded NQL query payload, in bytes. */
export const MAX_NQL_BYTES = 2 * 1024;
```

- [ ] **Step 2.2: Write the failing tests**

Create `packages/docs/.vitepress/theme/playground/sanitize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	rejectsOversizeSchema,
	rejectsOversizeNql,
	validateIdentifier,
	validatePayload,
} from './sanitize';
import type { HashPayloadV1 } from './types';

describe('validateIdentifier', () => {
	it('accepts standard SQL identifiers', () => {
		expect(validateIdentifier('users')).toBe(true);
		expect(validateIdentifier('user_id')).toBe(true);
		expect(validateIdentifier('UsersTable')).toBe(true);
		expect(validateIdentifier('_private')).toBe(true);
	});

	it('rejects identifiers with unsafe characters', () => {
		expect(validateIdentifier('1users')).toBe(false); // starts with digit
		expect(validateIdentifier('users; DROP TABLE')).toBe(false);
		expect(validateIdentifier('<script>')).toBe(false);
		expect(validateIdentifier('users-table')).toBe(false); // hyphen
		expect(validateIdentifier('')).toBe(false);
	});
});

describe('rejectsOversizeSchema', () => {
	it('returns false (=accepts) up to the cap', () => {
		const small = 'a'.repeat(100);
		expect(rejectsOversizeSchema(small)).toBe(false);
		const atCap = 'a'.repeat(8 * 1024);
		expect(rejectsOversizeSchema(atCap)).toBe(false);
	});

	it('returns true (=rejects) above the cap', () => {
		const oversize = 'a'.repeat(8 * 1024 + 1);
		expect(rejectsOversizeSchema(oversize)).toBe(true);
	});
});

describe('rejectsOversizeNql', () => {
	it('accepts up to the cap', () => {
		expect(rejectsOversizeNql('users {| name |}')).toBe(false);
		expect(rejectsOversizeNql('a'.repeat(2048))).toBe(false);
	});

	it('rejects above the cap', () => {
		expect(rejectsOversizeNql('a'.repeat(2049))).toBe(true);
	});
});

describe('validatePayload', () => {
	const baseValid: HashPayloadV1 = {
		v: 1,
		s: 'table users {\n  id: uuid pk\n  name: string\n}\n',
		n: 'users {| name |}',
		m: 'nql',
	};

	it('accepts a well-formed v1 payload', () => {
		expect(validatePayload(baseValid)).toEqual({ ok: true, payload: baseValid });
	});

	it('rejects unknown version with reason "version"', () => {
		const result = validatePayload({ ...baseValid, v: 99 } as unknown as HashPayloadV1);
		expect(result).toEqual({ ok: false, reason: 'version' });
	});

	it('rejects unknown mode with reason "version"', () => {
		const result = validatePayload({
			...baseValid,
			m: 'ts',
		} as unknown as HashPayloadV1);
		expect(result).toEqual({ ok: false, reason: 'version' });
	});

	it('rejects oversize schema with reason "size"', () => {
		const result = validatePayload({
			...baseValid,
			s: 'a'.repeat(9 * 1024),
		});
		expect(result).toEqual({ ok: false, reason: 'size' });
	});

	it('rejects oversize NQL with reason "size"', () => {
		const result = validatePayload({
			...baseValid,
			n: 'a'.repeat(3 * 1024),
		});
		expect(result).toEqual({ ok: false, reason: 'size' });
	});

	it('rejects schema with unsafe identifier with reason "identifier"', () => {
		const result = validatePayload({
			...baseValid,
			s: 'table users {\n  1id: uuid pk\n  name: string\n}\n',
		});
		expect(result).toEqual({ ok: false, reason: 'identifier' });
	});

	it('rejects schema with bad table name with reason "identifier"', () => {
		const result = validatePayload({
			...baseValid,
			s: 'table users; DROP {\n  id: uuid pk\n}\n',
		});
		expect(result).toEqual({ ok: false, reason: 'identifier' });
	});

	it('rejects non-object input with reason "shape"', () => {
		expect(validatePayload(null)).toEqual({ ok: false, reason: 'shape' });
		expect(validatePayload('string')).toEqual({ ok: false, reason: 'shape' });
		expect(validatePayload(42)).toEqual({ ok: false, reason: 'shape' });
	});

	it('rejects missing fields with reason "shape"', () => {
		expect(validatePayload({ v: 1, s: 'x' })).toEqual({ ok: false, reason: 'shape' });
	});
});
```

- [ ] **Step 2.3: Run the tests to confirm they fail**

```bash
pnpm -C packages/docs test 2>&1 | tail -30
```

Expected: `FAIL` on every test because `sanitize.ts` doesn't exist.

- [ ] **Step 2.4: Write the minimal implementation**

Create `packages/docs/.vitepress/theme/playground/sanitize.ts`:

```ts
import {
	MAX_NQL_BYTES,
	MAX_SCHEMA_BYTES,
	type HashPayloadV1,
} from './types';

/**
 * Identifier regex matches the same shape as @dbsp/adapter-pgsql's
 * validateIdentifier — letters / underscores, then alphanumerics.
 */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateIdentifier(value: string): boolean {
	return IDENTIFIER_RE.test(value);
}

export function rejectsOversizeSchema(dsl: string): boolean {
	return new TextEncoder().encode(dsl).byteLength > MAX_SCHEMA_BYTES;
}

export function rejectsOversizeNql(query: string): boolean {
	return new TextEncoder().encode(query).byteLength > MAX_NQL_BYTES;
}

/**
 * Pull out every identifier mentioned by `table NAME { COL: ... }` lines.
 * NOT a full DSL parser — just enough to flag malformed table/column names
 * before we hand the DSL to the runtime parser. The runtime parser is the
 * authority; this is a fast first-pass for security.
 */
function* extractDslIdentifiers(dsl: string): Generator<string> {
	const tableRe = /^\s*table\s+([^\s{]+)/gm;
	const columnRe = /^\s*([^\s:]+)\s*:/gm;
	for (const match of dsl.matchAll(tableRe)) yield match[1];
	for (const match of dsl.matchAll(columnRe)) {
		// Skip lines that are also `table X` matches.
		const id = match[1];
		if (id !== 'table') yield id;
	}
}

export type ValidationResult =
	| { ok: true; payload: HashPayloadV1 }
	| { ok: false; reason: 'shape' | 'version' | 'size' | 'identifier' };

export function validatePayload(input: unknown): ValidationResult {
	// Shape: must be an object with the four required fields.
	if (input === null || typeof input !== 'object') {
		return { ok: false, reason: 'shape' };
	}
	const obj = input as Record<string, unknown>;
	if (
		typeof obj.v !== 'number' ||
		typeof obj.s !== 'string' ||
		typeof obj.n !== 'string' ||
		typeof obj.m !== 'string'
	) {
		return { ok: false, reason: 'shape' };
	}

	// Version + mode: only v=1, m='nql' accepted in v1.
	if (obj.v !== 1 || obj.m !== 'nql') {
		return { ok: false, reason: 'version' };
	}

	// Size caps.
	if (rejectsOversizeSchema(obj.s) || rejectsOversizeNql(obj.n)) {
		return { ok: false, reason: 'size' };
	}

	// Identifier validation on every table/column name extracted from the DSL.
	for (const id of extractDslIdentifiers(obj.s)) {
		if (!validateIdentifier(id)) {
			return { ok: false, reason: 'identifier' };
		}
	}

	return {
		ok: true,
		payload: { v: 1, s: obj.s, n: obj.n, m: 'nql' },
	};
}
```

- [ ] **Step 2.5: Run tests to verify they pass**

```bash
pnpm -C packages/docs test 2>&1 | tail -20
```

Expected: all tests `PASS`.

- [ ] **Step 2.6: Commit**

```bash
git add packages/docs/.vitepress/theme/playground/types.ts \
       packages/docs/.vitepress/theme/playground/sanitize.ts \
       packages/docs/.vitepress/theme/playground/sanitize.test.ts
git commit -m "feat(docs): add hash-payload sanitization for playground"
```

---

### Task 3: Hash codec (TDD)

**Why:** Spec § "URL hash format" — encode/decode v1 payloads via native `CompressionStream('gzip')` + base64url, with a `MAX_HASH_LENGTH` cap.

**Files:**
- Create: `packages/docs/.vitepress/theme/playground/hash-codec.ts`
- Test:   `packages/docs/.vitepress/theme/playground/hash-codec.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Create `packages/docs/.vitepress/theme/playground/hash-codec.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	HASH_PREFIX,
	HASH_VERSION,
	MAX_HASH_LENGTH,
	decodeHash,
	encodeHash,
	isHashLengthOk,
} from './hash-codec';
import type { HashPayloadV1 } from './types';

const sample: HashPayloadV1 = {
	v: 1,
	s: 'table users {\n  id: uuid pk\n  name: string\n  email: string unique\n}\n',
	n: 'users {| name, email |}',
	m: 'nql',
};

describe('encodeHash + decodeHash roundtrip', () => {
	it('produces a base64url string with the prefix', async () => {
		const encoded = await encodeHash(sample);
		expect(encoded.startsWith(HASH_PREFIX)).toBe(true);
		// base64url alphabet only — no `+`, `/`, or `=`.
		expect(encoded.slice(HASH_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('decodes back to the same payload', async () => {
		const encoded = await encodeHash(sample);
		const decoded = await decodeHash(encoded);
		expect(decoded).toEqual({ ok: true, payload: sample });
	});

	it('decodes from a hash that includes the leading "#"', async () => {
		const encoded = await encodeHash(sample);
		const decoded = await decodeHash('#' + encoded);
		expect(decoded).toEqual({ ok: true, payload: sample });
	});
});

describe('decodeHash failure modes', () => {
	it('reports "no-hash" when input is empty / has no h= prefix', async () => {
		expect(await decodeHash('')).toEqual({ ok: false, reason: 'no-hash' });
		expect(await decodeHash('foo=bar')).toEqual({ ok: false, reason: 'no-hash' });
	});

	it('reports "decode-error" when the base64url is corrupt', async () => {
		expect(await decodeHash(HASH_PREFIX + 'not-valid-base64-!!!')).toEqual({
			ok: false,
			reason: 'decode-error',
		});
	});

	it('reports "decode-error" when the gzipped payload is invalid', async () => {
		// 'AAAA' decodes to 3 bytes that aren't a valid gzip stream.
		expect(await decodeHash(HASH_PREFIX + 'AAAA')).toEqual({
			ok: false,
			reason: 'decode-error',
		});
	});

	it('reports "no-compression-stream" when CompressionStream is missing', async () => {
		const original = (globalThis as { CompressionStream?: unknown })
			.CompressionStream;
		// @ts-expect-error temporary delete to simulate old browser
		delete (globalThis as { CompressionStream?: unknown }).CompressionStream;
		try {
			const encoded = HASH_PREFIX + 'anything';
			expect(await decodeHash(encoded)).toEqual({
				ok: false,
				reason: 'no-compression-stream',
			});
		} finally {
			(globalThis as { CompressionStream?: unknown }).CompressionStream = original;
		}
	});
});

describe('encodeHash sanitization integration', () => {
	it('refuses to encode payloads that fail validation', async () => {
		// Bad identifier in schema.
		await expect(
			encodeHash({
				v: 1,
				s: 'table 1users { id: uuid pk }',
				n: 'users {| name |}',
				m: 'nql',
			}),
		).rejects.toThrow();
	});

	it('refuses payloads larger than MAX_NQL_BYTES', async () => {
		await expect(
			encodeHash({
				v: 1,
				s: 'table users { id: uuid pk }',
				n: 'a'.repeat(3 * 1024),
				m: 'nql',
			}),
		).rejects.toThrow();
	});
});

describe('isHashLengthOk', () => {
	it('returns true below cap', () => {
		expect(isHashLengthOk('a'.repeat(MAX_HASH_LENGTH - 1))).toBe(true);
	});

	it('returns false above cap', () => {
		expect(isHashLengthOk('a'.repeat(MAX_HASH_LENGTH + 1))).toBe(false);
	});
});

describe('HASH_VERSION constant', () => {
	it('is 1 in v1 of the spec', () => {
		expect(HASH_VERSION).toBe(1);
	});
});
```

- [ ] **Step 3.2: Run tests, confirm they fail**

```bash
pnpm -C packages/docs test 2>&1 | tail -30
```

Expected: `FAIL` because `hash-codec.ts` doesn't exist.

- [ ] **Step 3.3: Write the implementation**

Create `packages/docs/.vitepress/theme/playground/hash-codec.ts`:

```ts
import { validatePayload } from './sanitize';
import type { HashPayloadV1 } from './types';

export const HASH_PREFIX = 'h=';
export const HASH_VERSION = 1 as const;

/**
 * URL length cap for the *full hash content* (the bit after `#`, including
 * the `h=` prefix). 4000 chars is a conservative baseline below all
 * documented browser URL limits (Chrome ~32k, Firefox ~64k, Safari ~80k,
 * Edge ~2k legacy). Calibrate during implementation if real schemas push
 * past this; the encoder surfaces a banner + skips the write when exceeded.
 */
export const MAX_HASH_LENGTH = 4000;

export function isHashLengthOk(hash: string): boolean {
	return hash.length <= MAX_HASH_LENGTH;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function fromBase64Url(b64url: string): Uint8Array {
	const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
	const padding = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
	const padRight = padded + '='.repeat(padding);
	const binary = atob(padRight);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export async function encodeHash(payload: HashPayloadV1): Promise<string> {
	// Defensive: refuse to encode anything that wouldn't pass decode validation.
	const verdict = validatePayload(payload);
	if (!verdict.ok) {
		throw new Error(`encodeHash: payload failed validation (${verdict.reason})`);
	}

	const json = JSON.stringify(payload);
	const stream = new CompressionStream('gzip');
	const writer = stream.writable.getWriter();
	await writer.write(new TextEncoder().encode(json));
	await writer.close();
	const bytes = new Uint8Array(
		await new Response(stream.readable).arrayBuffer(),
	);
	return HASH_PREFIX + toBase64Url(bytes);
}

export type DecodeResult =
	| { ok: true; payload: HashPayloadV1 }
	| {
			ok: false;
			reason:
				| 'no-hash'
				| 'no-compression-stream'
				| 'decode-error'
				| 'version'
				| 'size'
				| 'identifier'
				| 'shape';
	  };

export async function decodeHash(rawHash: string): Promise<DecodeResult> {
	// Strip leading '#'
	const hash = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
	if (!hash.startsWith(HASH_PREFIX)) {
		return { ok: false, reason: 'no-hash' };
	}

	if (!('CompressionStream' in globalThis)) {
		return { ok: false, reason: 'no-compression-stream' };
	}

	const b64url = hash.slice(HASH_PREFIX.length);
	let bytes: Uint8Array;
	try {
		bytes = fromBase64Url(b64url);
	} catch {
		return { ok: false, reason: 'decode-error' };
	}

	let json: string;
	try {
		const stream = new DecompressionStream('gzip');
		const writer = stream.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		json = await new Response(stream.readable).text();
	} catch {
		return { ok: false, reason: 'decode-error' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { ok: false, reason: 'decode-error' };
	}

	const verdict = validatePayload(parsed);
	if (verdict.ok) return { ok: true, payload: verdict.payload };
	return { ok: false, reason: verdict.reason };
}
```

- [ ] **Step 3.4: Run tests, verify pass**

```bash
pnpm -C packages/docs test 2>&1 | tail -20
```

Expected: all tests `PASS`.

- [ ] **Step 3.5: Commit**

```bash
git add packages/docs/.vitepress/theme/playground/hash-codec.ts \
       packages/docs/.vitepress/theme/playground/hash-codec.test.ts
git commit -m "feat(docs): add versioned URL-hash codec for playground"
```

---

### Task 4: ErrorBanner.vue (presentational)

**Why:** Spec § "Error banner" — single severity-aware component used by the parent for init-time anomalies.

**Files:**
- Create: `packages/docs/.vitepress/theme/playground/ErrorBanner.vue`

- [ ] **Step 4.1: Create the component**

Create `packages/docs/.vitepress/theme/playground/ErrorBanner.vue`:

```vue
<script setup lang="ts">
import type { ErrorBannerData } from './types';

defineProps<{ data: ErrorBannerData | null }>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div
    v-if="data"
    class="playground-error-banner"
    :class="`error-banner--${data.severity}`"
    :role="data.severity === 'fatal' ? 'alertdialog' : 'alert'"
    :aria-modal="data.severity === 'fatal' ? 'true' : undefined"
  >
    <div class="error-banner-icon" aria-hidden="true">
      {{ data.severity === 'fatal' ? '✕' : '⚠' }}
    </div>
    <div class="error-banner-text">
      <strong class="error-banner-title">{{ data.title }}</strong>
      <p class="error-banner-message">{{ data.message }}</p>
    </div>
    <div class="error-banner-actions">
      <button
        v-for="action in data.actions"
        :key="action.label"
        type="button"
        class="error-banner-action"
        @click="action.handler"
      >
        {{ action.label }}
      </button>
    </div>
    <button
      type="button"
      class="error-banner-close"
      aria-label="Dismiss banner"
      @click="$emit('dismiss')"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.playground-error-banner {
  position: sticky;
  top: var(--vp-nav-height, 64px);
  z-index: calc(var(--vp-z-index-nav, 30) - 1);
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: start;
  gap: var(--dbsp-space-md, 0.75rem);
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  border: 1px solid var(--vp-c-divider);
  border-left-width: 3px;
  border-radius: var(--dbsp-radius-md, 8px);
  margin-bottom: var(--dbsp-space-md, 0.75rem);
  font-size: var(--dbsp-text-sm, 0.875rem);
}

.error-banner--warn {
  background: color-mix(in srgb, var(--dbsp-c-warning) 8%, transparent);
  border-left-color: var(--dbsp-c-warning);
  color: var(--vp-c-text-1);
}

.error-banner--fatal {
  background: color-mix(in srgb, var(--dbsp-c-error) 10%, transparent);
  border-left-color: var(--dbsp-c-error);
  color: var(--vp-c-text-1);
}

.error-banner-icon {
  font-size: 1.1rem;
  line-height: 1.5;
}

.error-banner--warn .error-banner-icon {
  color: var(--dbsp-c-warning);
}

.error-banner--fatal .error-banner-icon {
  color: var(--dbsp-c-error);
}

.error-banner-text {
  min-width: 0;
}

.error-banner-title {
  display: block;
  font-weight: 600;
  margin-bottom: var(--dbsp-space-xs, 0.25rem);
}

.error-banner-message {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}

.error-banner-actions {
  display: flex;
  gap: var(--dbsp-space-xs, 0.25rem);
  flex-wrap: wrap;
}

.error-banner-action {
  font-size: 0.8rem;
  padding: 0.25rem 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  cursor: pointer;
  transition: all 0.15s;
}

.error-banner-action:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.error-banner-action:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.error-banner-close {
  background: transparent;
  border: 0;
  font-size: 1.2rem;
  line-height: 1;
  color: var(--vp-c-text-3);
  cursor: pointer;
  padding: 0 0.25rem;
}

.error-banner-close:hover {
  color: var(--vp-c-text-1);
}
</style>
```

- [ ] **Step 4.2: Sanity-build (component loads even without consumer)**

```bash
pnpm -C packages/docs build > /tmp/build.log 2>&1; echo "EXIT:$?"; grep -E "Error|error TS" /tmp/build.log | head -5
```

Expected: `EXIT:0`, no errors. The component is unused for now but its TS must parse.

- [ ] **Step 4.3: Commit**

```bash
git add packages/docs/.vitepress/theme/playground/ErrorBanner.vue
git commit -m "feat(docs): extract ErrorBanner presentational component"
```

---

### Task 5: SchemaSection.vue (presentational, with pointer-event pan/zoom)

**Why:** Spec § "Anatomy" + § "Accessibility" (pointer events for pan/zoom). Lift the schema editor + diagram + TS export out of `Playground.vue`.

**Files:**
- Create: `packages/docs/.vitepress/theme/playground/SchemaSection.vue`

The SchemaSection renders the collapsed bar AND the expanded body (DSL editor / Mermaid diagram / generated TS tabs). Parent owns: `dsl`, `tableCount`, `mermaidSvg`, `generatedTs`, `schemaError`, `expanded`. Component emits: `update:dsl`, `update:expanded`, `reset`, `copy-ts`.

**Pointer event migration:** the existing wheel-zoom + mouse-drag handlers (`onDiagramWheel`, `onDiagramDragStart`, `onDiagramDrag`, `onDiagramDragEnd`) move into this file and switch to `pointerdown` / `pointermove` / `pointerup`. The diagram container gets `touch-action: none` so iOS/Android don't claim the gesture for browser scroll.

- [ ] **Step 5.1: Read the current schema-related code in Playground.vue**

Run: `grep -n "schemaTab\|onDiagram\|mermaidViewport\|schema-output\|schema-tabs\|schemaDsl\|generateTypeScript\|copyTypeScript" /mnt/wsl/shared/dev/db-semantic-planner/packages/docs/.vitepress/theme/Playground.vue | head -50`

Note the line numbers — these are the regions you migrate.

- [ ] **Step 5.2: Create the component skeleton + props/emits**

Create `packages/docs/.vitepress/theme/playground/SchemaSection.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
	dsl: string;
	tableCount: number;
	mermaidSvg: string;
	generatedTs: string;
	schemaError: string | null;
	expanded: boolean;
}>();

const emit = defineEmits<{
	'update:dsl': [value: string];
	'update:expanded': [value: boolean];
	reset: [];
	'copy-ts': [];
}>();

// Tab inside the expanded body: 'editor' | 'diagram' | 'typescript'
const activeTab = ref<'editor' | 'diagram' | 'typescript'>('editor');

// Local pan/zoom state for the Mermaid diagram.
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let panStartX = 0;
let panStartY = 0;
let activePointerId: number | null = null;

function onPointerDown(e: PointerEvent) {
	(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	activePointerId = e.pointerId;
	isDragging = true;
	dragStartX = e.clientX;
	dragStartY = e.clientY;
	panStartX = panX.value;
	panStartY = panY.value;
}

function onPointerMove(e: PointerEvent) {
	if (!isDragging || e.pointerId !== activePointerId) return;
	panX.value = panStartX + (e.clientX - dragStartX);
	panY.value = panStartY + (e.clientY - dragStartY);
}

function onPointerUp(e: PointerEvent) {
	if (e.pointerId !== activePointerId) return;
	isDragging = false;
	activePointerId = null;
	(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
}

function onWheel(e: WheelEvent) {
	const delta = e.deltaY > 0 ? -0.1 : 0.1;
	zoom.value = Math.max(0.3, Math.min(3, zoom.value + delta));
}

function resetView() {
	zoom.value = 1;
	panX.value = 0;
	panY.value = 0;
}

function toggleExpand() {
	emit('update:expanded', !props.expanded);
}
</script>

<template>
  <section class="schema-section" :data-expanded="expanded">
    <button
      type="button"
      class="schema-bar"
      :aria-expanded="expanded"
      aria-controls="schema-body"
      @click="toggleExpand"
    >
      <span class="schema-chev" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <span class="schema-label">Schema</span>
      <span class="schema-tables">{{ tableCount }} tables</span>
      <span class="schema-spacer"></span>
      <span class="schema-actions" @click.stop>
        <button
          type="button"
          class="schema-action-btn"
          aria-label="Reset playground state (clear URL hash)"
          @click="emit('reset')"
        >
          Reset
        </button>
        <span class="schema-action-edit">{{ expanded ? 'Collapse ↑' : 'Edit ↗' }}</span>
      </span>
    </button>

    <div v-show="expanded" id="schema-body" class="schema-body">
      <div role="group" aria-label="Schema view" class="schema-tabs">
        <button
          type="button"
          class="schema-tab-btn"
          :class="{ active: activeTab === 'editor' }"
          @click="activeTab = 'editor'"
        >Editor</button>
        <button
          type="button"
          class="schema-tab-btn"
          :class="{ active: activeTab === 'diagram' }"
          @click="activeTab = 'diagram'"
        >Diagram</button>
        <button
          type="button"
          class="schema-tab-btn"
          :class="{ active: activeTab === 'typescript' }"
          @click="activeTab = 'typescript'"
        >TypeScript</button>
        <button
          v-if="activeTab === 'typescript'"
          type="button"
          class="schema-copy-btn"
          aria-label="Copy generated TypeScript to clipboard"
          @click="emit('copy-ts')"
        >Copy</button>
      </div>

      <div v-if="schemaError" class="schema-error" role="alert">
        <pre>{{ schemaError }}</pre>
      </div>

      <textarea
        v-show="activeTab === 'editor'"
        :value="dsl"
        class="schema-dsl"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        aria-label="Schema DSL"
        @input="emit('update:dsl', ($event.target as HTMLTextAreaElement).value)"
      />

      <div
        v-show="activeTab === 'diagram'"
        class="schema-diagram"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.passive="onWheel"
      >
        <button
          type="button"
          class="diagram-reset-btn"
          aria-label="Reset diagram pan and zoom"
          @click="resetView"
        >Reset view</button>
        <div
          class="diagram-svg-wrapper"
          :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})` }"
          v-html="mermaidSvg"
        ></div>
      </div>

      <pre
        v-show="activeTab === 'typescript'"
        class="schema-ts"
      ><code>{{ generatedTs }}</code></pre>
    </div>
  </section>
</template>

<style scoped>
.schema-section {
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  margin-bottom: var(--dbsp-space-lg, 1rem);
  overflow: hidden;
}

.schema-bar {
  display: flex;
  align-items: center;
  gap: var(--dbsp-space-sm, 0.5rem);
  width: 100%;
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(34, 211, 238, 0.04) 100%);
  border: 0;
  border-bottom: 1px solid var(--vp-c-divider);
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
  transition: background 0.15s;
}

.schema-bar:hover { background: linear-gradient(135deg, rgba(99, 102, 241, 0.10) 0%, rgba(34, 211, 238, 0.07) 100%); }
.schema-bar:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; }

.schema-chev { color: var(--vp-c-brand-1); font-weight: 700; width: 1rem; display: inline-block; }
.schema-label { font-weight: 600; }
.schema-tables { color: var(--vp-c-text-3); font-size: 0.8rem; }
.schema-spacer { flex: 1; }
.schema-actions { display: flex; align-items: center; gap: var(--dbsp-space-sm, 0.5rem); }

.schema-action-btn {
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s;
}

.schema-action-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.schema-action-edit { font-size: 0.8rem; color: var(--vp-c-brand-1); cursor: pointer; }

.schema-body { padding: var(--dbsp-space-md, 0.75rem); }
.schema-tabs { display: flex; gap: 2px; margin-bottom: var(--dbsp-space-sm, 0.5rem); align-items: center; }

.schema-tab-btn {
  font-size: 0.8rem;
  padding: 0.3rem 0.7rem;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.schema-tab-btn.active { border-bottom-color: var(--vp-c-brand-1); font-weight: 600; }

.schema-copy-btn {
  margin-left: auto;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.schema-copy-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }

.schema-error {
  background: color-mix(in srgb, var(--dbsp-c-error) 8%, transparent);
  border-left: 3px solid var(--dbsp-c-error);
  border-radius: var(--dbsp-radius-sm, 4px);
  padding: var(--dbsp-space-sm, 0.5rem);
  margin-bottom: var(--dbsp-space-sm, 0.5rem);
  font-size: 0.85rem;
  color: var(--dbsp-c-error);
}
.schema-error pre { margin: 0; white-space: pre-wrap; }

.schema-dsl {
  width: 100%;
  min-height: 12rem;
  padding: var(--dbsp-space-sm, 0.5rem);
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  color: var(--vp-c-text-1);
  resize: vertical;
}

.schema-diagram {
  position: relative;
  height: 24rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  overflow: hidden;
  touch-action: none; /* Mobile: don't let the browser claim pinch/drag */
  user-select: none;
  cursor: grab;
}
.schema-diagram:active { cursor: grabbing; }

.diagram-reset-btn {
  position: absolute;
  top: var(--dbsp-space-sm, 0.5rem);
  right: var(--dbsp-space-sm, 0.5rem);
  z-index: 1;
  font-size: 0.72rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
}

.diagram-svg-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  transform-origin: center center;
}
.diagram-svg-wrapper :deep(svg) { max-width: 100%; max-height: 100%; }

.schema-ts {
  margin: 0;
  padding: var(--dbsp-space-sm, 0.5rem);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  color: var(--vp-c-text-1);
  overflow: auto;
  max-height: 20rem;
}
</style>
```

- [ ] **Step 5.3: Sanity-build**

```bash
pnpm -C packages/docs build > /tmp/build.log 2>&1; echo "EXIT:$?"; grep -E "Error|error TS" /tmp/build.log | head -5
```

Expected: `EXIT:0`, no errors. Component unused for now.

- [ ] **Step 5.4: Commit**

```bash
git add packages/docs/.vitepress/theme/playground/SchemaSection.vue
git commit -m "feat(docs): extract SchemaSection presentational component"
```

---

### Task 6: QuerySection.vue (presentational)

**Why:** Spec § "Anatomy" — query input area with NQL/TS toggle (TS disabled in v1), example dropdown, textarea, Compile button.

**Files:**
- Create: `packages/docs/.vitepress/theme/playground/QuerySection.vue`

- [ ] **Step 6.1: Create the component**

Create `packages/docs/.vitepress/theme/playground/QuerySection.vue`:

```vue
<script setup lang="ts">
import type { PropType } from 'vue';

defineProps({
	nqlCode: { type: String, required: true },
	queryMode: { type: String as PropType<'nql'>, required: true },
	examples: {
		type: Array as PropType<readonly { readonly name: string; readonly code: string }[]>,
		required: true,
	},
	selectedExampleIndex: { type: Number, required: true },
	ready: { type: Boolean, required: true }, // nqlTag loaded + no schema error
});

const emit = defineEmits<{
	'update:nqlCode': [value: string];
	'update:selectedExampleIndex': [value: number];
	compile: [];
}>();

function onExampleChange(e: Event) {
	const target = e.target as HTMLSelectElement;
	emit('update:selectedExampleIndex', Number(target.value));
}

function onTextareaInput(e: Event) {
	emit('update:nqlCode', (e.target as HTMLTextAreaElement).value);
}

function onCompileShortcut(e: KeyboardEvent) {
	if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
		e.preventDefault();
		emit('compile');
	}
}
</script>

<template>
  <section class="query-section">
    <div class="query-header">
      <span class="query-label">Query</span>
      <div class="query-mode" role="group" aria-label="Query syntax">
        <button
          type="button"
          class="mode-btn active"
          :aria-pressed="queryMode === 'nql'"
        >NQL</button>
        <button
          type="button"
          class="mode-btn"
          aria-pressed="false"
          disabled
          title="TypeScript ORM mode coming in a future release"
        >TypeScript</button>
      </div>
    </div>

    <div class="query-examples">
      <label for="example-select" class="visually-hidden">Example</label>
      <select
        id="example-select"
        :value="selectedExampleIndex"
        class="example-select"
        @change="onExampleChange"
      >
        <option v-for="(ex, i) in examples" :key="i" :value="i">
          {{ ex.name }}
        </option>
      </select>
    </div>

    <textarea
      :value="nqlCode"
      class="nql-textarea"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      placeholder="Enter NQL query..."
      aria-label="NQL query"
      @input="onTextareaInput"
      @keydown="onCompileShortcut"
    />

    <div class="query-actions">
      <button
        type="button"
        class="compile-btn"
        :disabled="!ready"
        @click="emit('compile')"
      >Compile</button>
      <span class="hint">Ctrl+Enter · Cmd+Enter</span>
    </div>
  </section>
</template>

<style scoped>
.query-section {
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  padding: var(--dbsp-space-md, 0.75rem);
  margin-bottom: var(--dbsp-space-lg, 1rem);
}

.query-header { display: flex; align-items: center; gap: var(--dbsp-space-md, 0.75rem); margin-bottom: var(--dbsp-space-sm, 0.5rem); }
.query-label { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vp-c-text-2); }
.query-mode { display: inline-flex; gap: 2px; padding: 2px; background: var(--vp-c-bg-soft); border-radius: var(--dbsp-radius-sm, 4px); }

.mode-btn {
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border: 0;
  background: transparent;
  color: inherit;
  border-radius: 3px;
  cursor: pointer;
  font-family: var(--vp-font-family-mono);
}
.mode-btn.active { background: var(--vp-c-bg); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.mode-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.query-examples { margin-bottom: var(--dbsp-space-sm, 0.5rem); }

.example-select {
  font-size: 0.85rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  max-width: 24rem;
  width: 100%;
}

.nql-textarea {
  width: 100%;
  min-height: 7rem;
  padding: var(--dbsp-space-sm, 0.5rem);
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  color: var(--vp-c-text-1);
  resize: vertical;
}

.query-actions { display: flex; align-items: center; gap: var(--dbsp-space-md, 0.75rem); margin-top: var(--dbsp-space-sm, 0.5rem); }

.compile-btn {
  font-size: 0.85rem;
  padding: 0.4rem 1rem;
  border: 0;
  border-radius: var(--dbsp-radius-sm, 4px);
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: white;
  font-weight: 600;
  cursor: pointer;
}
.compile-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.hint { font-size: 0.75rem; color: var(--vp-c-text-3); }

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
```

- [ ] **Step 6.2: Sanity-build**

```bash
pnpm -C packages/docs build > /tmp/build.log 2>&1; echo "EXIT:$?"; grep -E "Error|error TS" /tmp/build.log | head -5
```

Expected: `EXIT:0`.

- [ ] **Step 6.3: Commit**

```bash
git add packages/docs/.vitepress/theme/playground/QuerySection.vue
git commit -m "feat(docs): extract QuerySection presentational component"
```

---

### Task 7: PlanSection.vue + PlanDecisions.vue

**Why:** Spec § "Anatomy" — Plan as hero. PlanSection renders meta strip, warnings, CTEs. PlanDecisions owns its local `Map<id, signature>` watcher (per spec § "Decision-card collapse-state preservation").

**Files:**
- Create: `packages/docs/.vitepress/theme/playground/PlanSection.vue`
- Create: `packages/docs/.vitepress/theme/playground/PlanDecisions.vue`

- [ ] **Step 7.1: Create PlanDecisions.vue**

Create `packages/docs/.vitepress/theme/playground/PlanDecisions.vue`:

```vue
<script setup lang="ts">
import { ref, watch, type PropType } from 'vue';
import type { PlanDecision } from '@dbsp/core';

const props = defineProps({
	decisions: {
		type: Array as PropType<readonly PlanDecision[]>,
		required: true,
	},
});

const expanded = ref<Set<string>>(new Set());

function decisionSignature(d: PlanDecision): string {
	const c = d.context;
	const target = c.relation ?? c.target ?? '';
	const path = c.relationPath ?? c.intentPath ?? '';
	const alias = c.includeAlias ?? '';
	const join = d.joinType ?? '';
	return `${d.type}:${c.sourceTable}:${target}:${path}:${alias}:${join}:${d.choice}`;
}

let lastSignatures = new Map<string, string>();

watch(
	() => props.decisions,
	(decisions) => {
		// Empty = transient compile error; preserve state, do nothing.
		if (decisions.length === 0) return;

		const currentSigs = new Map<string, string>();
		for (const d of decisions) currentSigs.set(d.id, decisionSignature(d));

		// Same shape? Nothing to update.
		let unchanged = currentSigs.size === lastSignatures.size;
		if (unchanged) {
			for (const [id, sig] of currentSigs) {
				if (lastSignatures.get(id) !== sig) {
					unchanged = false;
					break;
				}
			}
		}
		if (unchanged) return;

		// Per-id signature comparison: keep collapse choice for ids whose
		// signature still matches; default-expand new or repurposed ids.
		const next = new Set<string>();
		for (const [id, sig] of currentSigs) {
			if (lastSignatures.get(id) === sig) {
				if (expanded.value.has(id)) next.add(id);
			} else {
				next.add(id);
			}
		}
		expanded.value = next;
		lastSignatures = currentSigs;
	},
	{ immediate: true },
);

function isExpanded(id: string): boolean {
	return expanded.value.has(id);
}

function toggle(id: string) {
	const next = new Set(expanded.value);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	expanded.value = next;
}

function formatType(type: string): string {
	return type.replace(/-/g, ' ').toUpperCase();
}

function formatContext(ctx: PlanDecision['context']): string {
	const parts: string[] = [ctx.sourceTable];
	const target = ctx.relation ?? ctx.target;
	if (target) parts.push(`→ ${target}`);
	return parts.join(' ');
}
</script>

<template>
  <div v-if="decisions.length > 0" class="plan-decisions">
    <div class="plan-section-title">Decisions ({{ decisions.length }})</div>
    <div
      v-for="d in decisions"
      :key="d.id"
      class="plan-decision-card"
      :class="`plan-decision-card--${d.type}`"
    >
      <button
        type="button"
        class="plan-decision-header"
        :aria-expanded="isExpanded(d.id)"
        :aria-controls="`plan-decision-body-${d.id}`"
        @click="toggle(d.id)"
      >
        <span class="plan-decision-type">{{ formatType(d.type) }}</span>
        <span class="plan-decision-context">{{ formatContext(d.context) }}</span>
        <span class="plan-decision-choice">{{ d.choice }}</span>
        <span
          class="plan-decision-chevron"
          :class="{ open: isExpanded(d.id) }"
          aria-hidden="true"
        >▸</span>
      </button>
      <div
        v-show="isExpanded(d.id)"
        :id="`plan-decision-body-${d.id}`"
        class="plan-decision-body"
      >
        <div class="plan-decision-row">
          <span class="plan-decision-label">Reasoning</span>
          <span class="plan-decision-value">{{ d.reasoning }}</span>
        </div>
        <div v-if="d.alternatives.length > 0" class="plan-decision-row">
          <span class="plan-decision-label">Alternatives considered</span>
          <ul class="plan-decision-alternatives">
            <li v-for="(alt, j) in d.alternatives" :key="j">{{ alt }}</li>
          </ul>
        </div>
        <div v-if="d.joinType" class="plan-decision-row">
          <span class="plan-decision-label">Join type</span>
          <span class="plan-decision-value">{{ d.joinType }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-decisions { display: flex; flex-direction: column; }
.plan-decisions > .plan-decision-card + .plan-decision-card { margin-top: var(--dbsp-space-sm, 0.5rem); }

.plan-section-title {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-2);
  margin-bottom: var(--dbsp-space-sm, 0.5rem);
}

.plan-decision-card {
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--dbsp-c-cyan);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg);
  overflow: hidden;
  transition: border-color 0.15s;
}
.plan-decision-card--ambiguity { border-left-color: var(--dbsp-c-warning); }

.plan-decision-header {
  display: flex;
  align-items: center;
  gap: var(--dbsp-space-md, 0.75rem);
  width: 100%;
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  font-size: 0.875rem;
  color: inherit;
  transition: background 0.15s;
}
.plan-decision-header:hover { background: var(--vp-c-bg-soft); }
.plan-decision-header:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -2px; }

.plan-decision-type {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--dbsp-c-cyan);
  flex-shrink: 0;
}
.plan-decision-card--ambiguity .plan-decision-type { color: var(--dbsp-c-warning); }

.plan-decision-context { font-family: var(--vp-font-family-mono); color: var(--vp-c-text-2); flex-shrink: 0; }
.plan-decision-choice { flex: 1; font-weight: 600; color: var(--vp-c-text-1); }
.plan-decision-chevron { color: var(--vp-c-text-3); transition: transform 0.15s; flex-shrink: 0; }
.plan-decision-chevron.open { transform: rotate(90deg); }

.plan-decision-body {
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem) var(--dbsp-space-md, 0.75rem);
  border-top: 1px solid var(--vp-c-divider);
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  gap: var(--dbsp-space-sm, 0.5rem);
}

.plan-decision-row { display: flex; flex-direction: column; gap: var(--dbsp-space-xs, 0.25rem); }
.plan-decision-label { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vp-c-text-3); }
.plan-decision-value { color: var(--vp-c-text-1); line-height: 1.5; }
.plan-decision-alternatives { margin: 0; padding-left: var(--dbsp-space-lg, 1rem); color: var(--vp-c-text-2); }
.plan-decision-alternatives li { font-family: var(--vp-font-family-mono); font-size: 0.82rem; line-height: 1.6; }
</style>
```

- [ ] **Step 7.2: Create PlanSection.vue (composes meta + warnings + CTEs + PlanDecisions)**

Create `packages/docs/.vitepress/theme/playground/PlanSection.vue`:

```vue
<script setup lang="ts">
import { computed, type PropType } from 'vue';
import type { Dump } from '@dbsp/core';
import PlanDecisions from './PlanDecisions.vue';

const props = defineProps({
	result: { type: Object as PropType<Dump | null>, default: null },
});

const planMeta = computed(() => props.result?.plan?.metadata);
const planRootTable = computed(() => props.result?.plan?.rootTable);
const planWarnings = computed(() => props.result?.plan?.warnings ?? []);
const planCtes = computed(() => props.result?.plan?.ctes ?? []);
const planDecisions = computed(() => props.result?.plan?.decisions ?? []);
</script>

<template>
  <section v-if="result" class="plan-section">
    <div v-if="planMeta || planRootTable" class="plan-meta">
      <span v-if="planRootTable" class="plan-meta-item">
        <span class="plan-meta-label">Root</span>
        <span class="plan-meta-value">{{ planRootTable }}</span>
      </span>
      <span v-if="planMeta" class="plan-meta-item">
        <span class="plan-meta-label">Planned in</span>
        <span class="plan-meta-value">{{ planMeta.planningTimeMs.toFixed(2) }}ms</span>
      </span>
      <span v-if="planMeta" class="plan-meta-item">
        <span class="plan-meta-label">Relations</span>
        <span class="plan-meta-value">{{ planMeta.relationsAnalyzed }}</span>
      </span>
      <span v-if="planMeta?.isAmbiguous" class="plan-meta-item plan-meta-warn">
        Ambiguous plan
      </span>
    </div>

    <div v-if="planWarnings.length > 0" class="plan-warnings">
      <div class="plan-section-title">Warnings ({{ planWarnings.length }})</div>
      <div v-for="(w, i) in planWarnings" :key="i" class="plan-warning-card">
        <div class="plan-warning-code">{{ w.code }}</div>
        <div class="plan-warning-message">{{ w.message }}</div>
        <div v-if="w.suggestion" class="plan-warning-suggestion">→ {{ w.suggestion }}</div>
      </div>
    </div>

    <div v-if="planCtes.length > 0" class="plan-ctes">
      <div class="plan-section-title">CTEs ({{ planCtes.length }})</div>
      <div v-for="cte in planCtes" :key="cte.name" class="plan-cte-card">
        <div class="plan-cte-header">
          <span class="plan-cte-name">{{ cte.name }}</span>
          <span v-if="cte.recursive" class="plan-cte-recursive">WITH RECURSIVE</span>
          <span v-if="cte.referencedBy.length > 0" class="plan-cte-refs">
            referenced by {{ cte.referencedBy.join(', ') }}
          </span>
        </div>
        <div class="plan-cte-purpose">{{ cte.purpose }}</div>
      </div>
    </div>

    <PlanDecisions :decisions="planDecisions" />
  </section>
</template>

<style scoped>
.plan-section {
  display: flex;
  flex-direction: column;
  gap: var(--dbsp-space-lg, 1rem);
  padding: var(--dbsp-space-md, 0.75rem);
  background: rgba(99, 102, 241, 0.04);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  margin-bottom: var(--dbsp-space-lg, 1rem);
}

.plan-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--dbsp-space-md, 0.75rem);
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-size: 0.85rem;
}

.plan-meta-item { display: inline-flex; align-items: baseline; gap: var(--dbsp-space-xs, 0.25rem); }
.plan-meta-label { color: var(--vp-c-text-3); }
.plan-meta-value { color: var(--vp-c-text-1); font-family: var(--vp-font-family-mono); font-weight: 600; }
.plan-meta-warn { color: var(--dbsp-c-warning); font-weight: 600; }

.plan-section-title {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vp-c-text-2);
  margin-bottom: var(--dbsp-space-sm, 0.5rem);
}

.plan-warnings, .plan-ctes { display: flex; flex-direction: column; }
.plan-warnings > .plan-warning-card + .plan-warning-card,
.plan-ctes > .plan-cte-card + .plan-cte-card { margin-top: var(--dbsp-space-sm, 0.5rem); }

.plan-warning-card {
  padding: var(--dbsp-space-md, 0.75rem);
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--dbsp-c-warning);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-size: 0.875rem;
  line-height: 1.5;
}
.plan-warning-code { font-family: var(--vp-font-family-mono); font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; color: var(--dbsp-c-warning); margin-bottom: var(--dbsp-space-xs, 0.25rem); }
.plan-warning-message { color: var(--vp-c-text-1); }
.plan-warning-suggestion { margin-top: var(--dbsp-space-xs, 0.25rem); color: var(--vp-c-text-2); font-style: italic; }

.plan-cte-card {
  padding: var(--dbsp-space-sm, 0.5rem) var(--dbsp-space-md, 0.75rem);
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--dbsp-c-cyan);
  border-radius: var(--dbsp-radius-sm, 4px);
  font-size: 0.875rem;
}
.plan-cte-header { display: flex; align-items: baseline; gap: var(--dbsp-space-md, 0.75rem); flex-wrap: wrap; }
.plan-cte-name { font-family: var(--vp-font-family-mono); font-weight: 700; color: var(--dbsp-c-cyan); }
.plan-cte-recursive {
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0.05rem 0.4rem;
  border-radius: var(--dbsp-radius-sm, 4px);
  background: color-mix(in srgb, var(--dbsp-c-warning) 12%, transparent);
  color: var(--dbsp-c-warning);
}
.plan-cte-refs { font-size: 0.72rem; color: var(--vp-c-text-3); }
.plan-cte-purpose { margin-top: var(--dbsp-space-xs, 0.25rem); color: var(--vp-c-text-2); line-height: 1.5; }
</style>
```

- [ ] **Step 7.3: Sanity-build**

```bash
pnpm -C packages/docs build > /tmp/build.log 2>&1; echo "EXIT:$?"; grep -E "Error|error TS" /tmp/build.log | head -5
```

Expected: `EXIT:0`. Note: relies on `@dbsp/core` exporting `Dump`, `PlanDecision` (already does per current Playground.vue).

- [ ] **Step 7.4: Commit**

```bash
git add packages/docs/.vitepress/theme/playground/PlanSection.vue \
       packages/docs/.vitepress/theme/playground/PlanDecisions.vue
git commit -m "feat(docs): extract PlanSection and PlanDecisions components"
```

---

### Task 8: OutputSection.vue (presentational)

**Why:** Spec § "Anatomy" — SQL/Params sub-tabs + Copy buttons. Owns local `activeOutputTab` ref since the tab choice is purely presentational.

**Files:**
- Create: `packages/docs/.vitepress/theme/playground/OutputSection.vue`

- [ ] **Step 8.1: Create the component**

Create `packages/docs/.vitepress/theme/playground/OutputSection.vue`:

```vue
<script setup lang="ts">
import { ref, watch, type PropType } from 'vue';
import type { Dump } from '@dbsp/core';

const props = defineProps({
	result: { type: Object as PropType<Dump | null>, default: null },
});

const emit = defineEmits<{
	'copy-sql': [];
	'copy-params': [];
}>();

const activeTab = ref<'sql' | 'params'>('sql');
const sqlCopied = ref(false);
const paramsCopied = ref(false);

let sqlTimer: ReturnType<typeof setTimeout> | null = null;
let paramsTimer: ReturnType<typeof setTimeout> | null = null;

// Reset copied feedback when result changes — clipboard is now stale.
watch(
	() => props.result,
	() => {
		if (sqlTimer !== null) clearTimeout(sqlTimer);
		sqlTimer = null;
		if (paramsTimer !== null) clearTimeout(paramsTimer);
		paramsTimer = null;
		sqlCopied.value = false;
		paramsCopied.value = false;
	},
);

async function copySQL() {
	if (!props.result) return;
	await navigator.clipboard.writeText(props.result.sql);
	sqlCopied.value = true;
	if (sqlTimer !== null) clearTimeout(sqlTimer);
	sqlTimer = setTimeout(() => {
		sqlCopied.value = false;
		sqlTimer = null;
	}, 2000);
	emit('copy-sql');
}

async function copyParams() {
	if (!props.result) return;
	await navigator.clipboard.writeText(formatParams(props.result.params));
	paramsCopied.value = true;
	if (paramsTimer !== null) clearTimeout(paramsTimer);
	paramsTimer = setTimeout(() => {
		paramsCopied.value = false;
		paramsTimer = null;
	}, 2000);
	emit('copy-params');
}

function formatParams(params: readonly unknown[]): string {
	if (params.length === 0) return '(no parameters)';
	return params.map((p, i) => `$${i + 1}: ${JSON.stringify(p)}`).join('\n');
}

const SQL_KEYWORDS = new RegExp(
	'\\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|LATERAL|ON|AND|OR|NOT|IN|EXISTS|AS' +
		'|ORDER\\s+BY|GROUP\\s+BY|HAVING|LIMIT|OFFSET|INSERT\\s+INTO|VALUES|UPDATE|SET|DELETE|RETURNING' +
		'|WITH|RECURSIVE|UNION|ALL|INTERSECT|EXCEPT|DISTINCT|CASE|WHEN|THEN|ELSE|END' +
		'|IS|NULL|TRUE|FALSE|ASC|DESC|BETWEEN|LIKE|ILIKE|CAST|OVER|PARTITION\\s+BY' +
		'|CONFLICT|DO|NOTHING|FETCH|FIRST|NEXT|ROWS|ONLY|FOR|SHARE|SKIP|LOCKED|NOWAIT)\\b',
	'g',
);

function highlightSQL(sql: string): string {
	const escaped = sql
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return escaped
		.replace(/("(?:[^"\\]|\\.)*")/g, '\x00IDENT$1\x00')
		.replace(SQL_KEYWORDS, '<span class="sql-kw">$1</span>')
		.replace(/(\$\d+)/g, '<span class="sql-param">$1</span>')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: \x00 sentinel
		.replace(/\x00IDENT(.*?)\x00/g, '<span class="sql-ident">$1</span>');
}
</script>

<template>
  <section v-if="result" class="output-section">
    <div role="group" aria-label="Output format" class="output-tabs">
      <button
        type="button"
        class="output-tab-btn"
        :class="{ active: activeTab === 'sql' }"
        @click="activeTab = 'sql'"
      >SQL</button>
      <button
        type="button"
        class="output-tab-btn"
        :class="{ active: activeTab === 'params' }"
        @click="activeTab = 'params'"
      >Parameters</button>

      <button
        v-if="activeTab === 'sql'"
        type="button"
        class="output-copy-btn"
        :aria-label="sqlCopied ? 'SQL copied to clipboard' : 'Copy SQL to clipboard'"
        @click="copySQL"
      >{{ sqlCopied ? 'Copied' : 'Copy' }}</button>
      <button
        v-else
        type="button"
        class="output-copy-btn"
        :aria-label="paramsCopied ? 'Parameters copied to clipboard' : 'Copy parameters to clipboard'"
        @click="copyParams"
      >{{ paramsCopied ? 'Copied' : 'Copy' }}</button>
    </div>

    <pre v-if="activeTab === 'sql'" class="output-pre"><code v-html="highlightSQL(result.sql)"></code></pre>
    <pre v-else class="output-pre"><code>{{ formatParams(result.params) }}</code></pre>
  </section>
</template>

<style scoped>
.output-section {
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
  padding: var(--dbsp-space-md, 0.75rem);
  margin-bottom: var(--dbsp-space-lg, 1rem);
}

.output-tabs { display: flex; gap: 2px; padding-bottom: 0.4rem; border-bottom: 1px solid var(--vp-c-divider); margin-bottom: var(--dbsp-space-sm, 0.5rem); align-items: center; }
.output-tab-btn { font-size: 0.85rem; padding: 0.3rem 0.7rem; border: 0; background: transparent; color: inherit; cursor: pointer; border-bottom: 2px solid transparent; }
.output-tab-btn.active { border-bottom-color: var(--vp-c-brand-1); font-weight: 600; }

.output-copy-btn {
  margin-left: auto;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-sm, 4px);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.output-copy-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.output-copy-btn:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }

.output-pre {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}

.output-pre :deep(.sql-kw) { color: #4338CA; font-weight: 600; }
.output-pre :deep(.sql-param) { color: #0E7490; }
.output-pre :deep(.sql-ident) { color: #15803D; }
.dark .output-pre :deep(.sql-kw) { color: #A5B4FC; font-weight: 600; }
.dark .output-pre :deep(.sql-param) { color: #67E8F9; }
.dark .output-pre :deep(.sql-ident) { color: #86EFAC; }
</style>
```

- [ ] **Step 8.2: Sanity-build**

```bash
pnpm -C packages/docs build > /tmp/build.log 2>&1; echo "EXIT:$?"; grep -E "Error|error TS" /tmp/build.log | head -5
```

Expected: `EXIT:0`.

- [ ] **Step 8.3: Commit**

```bash
git add packages/docs/.vitepress/theme/playground/OutputSection.vue
git commit -m "feat(docs): extract OutputSection presentational component"
```

---

### Task 9: Playground.vue rewrite — orchestrator

**Why:** All sub-components now exist. Rewrite the parent to wire them up, own all state, run the new lifecycle (mount + hashchange + onBeforeUnmount), implement the auto-compile flow with lazy Mermaid, and sync URL hash on changes.

**Files:**
- Modify: `packages/docs/.vitepress/theme/Playground.vue` (full rewrite)

This task is the largest — ~500 LoC after the rewrite, vs ~1700 LoC today.

- [ ] **Step 9.1: Read the current parent state surface in Playground.vue (for migration mapping)**

```bash
grep -nE "ref<|const .* = ref\(|^let " /mnt/wsl/shared/dev/db-semantic-planner/packages/docs/.vitepress/theme/Playground.vue | head -60
```

You will migrate every state ref / `let` declaration into the new orchestrator. Make a checklist of each one before you start.

- [ ] **Step 9.2: Rewrite Playground.vue**

Replace the full content of `packages/docs/.vitepress/theme/Playground.vue` with the orchestrator skeleton below. The four helpers (`parseSchemaDsl`, `buildSchemaFromParsed`, `generateTypeScript`, `buildMermaidCode`) must be migrated verbatim from the old file (they're pure helpers, no shared state). Search for each in the old `Playground.vue` and paste it into the new file, replacing the placeholder body. Do this BEFORE running the build in Step 9.4.

```vue
<script setup lang="ts">
/**
 * Playground orchestrator.
 *
 * Owns all stateful refs and the lifecycle. Sub-components in
 * theme/playground/ are presentational — they receive data via props and
 * signal user gestures via emits. Module-scope `let` state means this
 * component is single-instance per page; that is an accepted v1 limitation.
 * If a future requirement embeds the playground in guides, refactor the
 * `let` declarations into a `useState`-style composable.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Dump } from '@dbsp/core';

import ErrorBanner from './playground/ErrorBanner.vue';
import SchemaSection from './playground/SchemaSection.vue';
import QuerySection from './playground/QuerySection.vue';
import PlanSection from './playground/PlanSection.vue';
import OutputSection from './playground/OutputSection.vue';
import {
	HASH_PREFIX,
	MAX_HASH_LENGTH,
	decodeHash,
	encodeHash,
} from './playground/hash-codec';
import type { ErrorBannerData } from './playground/types';

// ---------------------------------------------------------------------------
// Default schema + examples (migrate verbatim from old file — abridged here)
// ---------------------------------------------------------------------------

const DEFAULT_SCHEMA_DSL = '...migrate from old Playground.vue...';
const ALL_EXAMPLES: ReadonlyArray<{ name: string; code: string; requires: readonly string[] }> = [];

interface NqlBuilder { dump(): Dump }
type NqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => NqlBuilder;

// ---------------------------------------------------------------------------
// Module-scope state (single-instance)
// ---------------------------------------------------------------------------

let coreModule: typeof import('@dbsp/core') | null = null;
let adapterModule: typeof import('@dbsp/adapter-pgsql') | null = null;
let mermaidInstance: typeof import('mermaid').default | null = null;
let nqlTag: NqlTag | null = null;

let schemaDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let nqlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let hashWriteTimer: ReturnType<typeof setTimeout> | null = null;

let suppressNextNqlWatch = false;
let pendingManualCompile = false;
let rebuildGeneration = 0;
let lastEmittedHash: string | null = null;
let disposed = false;

// ---------------------------------------------------------------------------
// Reactive state (parent owns)
// ---------------------------------------------------------------------------

const schemaDsl = ref(DEFAULT_SCHEMA_DSL);
const schemaError = ref<string | null>(null);
const tableCount = ref(0);
const mermaidSvg = ref('');
const generatedTs = ref('');
const schemaExpanded = ref(false);

const nqlCode = ref(ALL_EXAMPLES[0]?.code ?? '');
const selectedExampleIndex = ref(0);
const queryMode = ref<'nql'>('nql'); // 'ts' lands in v2 with T3.

const result = ref<Dump | null>(null);
const compileError = ref<string | null>(null);

const errorBanner = ref<ErrorBannerData | null>(null);
const isInitializing = ref(true);
const initFatal = ref(false);

const tsCopied = ref(false);
let tsCopiedTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const visibleExamples = computed(() => {
	if (schemaError.value) return [];
	const tableNames = new Set<string>();
	for (const m of schemaDsl.value.matchAll(/^\s*table\s+(\w+)/gm)) {
		tableNames.add(m[1]);
	}
	return ALL_EXAMPLES.filter((ex) => ex.requires.every((t) => tableNames.has(t)));
});

const ready = computed(() => !disposed && nqlTag !== null && !schemaError.value);

// ---------------------------------------------------------------------------
// Compile flow
// ---------------------------------------------------------------------------

function performCompile(opts: { resetTab: boolean }) {
	if (!nqlTag) {
		compileError.value = schemaError.value
			? `Schema error: ${schemaError.value}`
			: 'Compiler not ready — please wait a moment and try again.';
		result.value = null;
		return;
	}
	const query = nqlCode.value.trim();
	if (!query) {
		compileError.value = 'Please enter an NQL query.';
		result.value = null;
		return;
	}
	try {
		const builder = nqlTag`${query}`;
		result.value = builder.dump();
		compileError.value = null;
		void opts; // resetTab reserved for future TS-mode wiring.
	} catch (e) {
		compileError.value = e instanceof Error ? e.message : String(e);
		result.value = null;
	}
}

function compile() {
	if (nqlDebounceTimer !== null) {
		clearTimeout(nqlDebounceTimer);
		nqlDebounceTimer = null;
	}
	if (schemaDebounceTimer !== null) {
		pendingManualCompile = true;
		return;
	}
	performCompile({ resetTab: true });
}

// ---------------------------------------------------------------------------
// Schema rebuild
// ---------------------------------------------------------------------------

interface ParsedSchema { tables: { name: string; columns: { name: string; type: string }[] }[] }
function parseSchemaDsl(_dsl: string): ParsedSchema { throw new Error('Migrate parseSchemaDsl from old Playground.vue'); }
function buildSchemaFromParsed(_parsed: ParsedSchema): unknown { throw new Error('Migrate buildSchemaFromParsed'); }
function generateTypeScript(_parsed: ParsedSchema): string { throw new Error('Migrate generateTypeScript'); }
function buildMermaidCode(_parsed: ParsedSchema): string { throw new Error('Migrate buildMermaidCode'); }

async function rebuildOrm(dsl: string): Promise<void> {
	if (!coreModule || !adapterModule) return;
	const myGen = ++rebuildGeneration;
	schemaError.value = null;

	let parsed: ParsedSchema;
	try {
		parsed = parseSchemaDsl(dsl);
	} catch (e) {
		if (myGen !== rebuildGeneration || disposed) return;
		schemaError.value = e instanceof Error ? e.message : String(e);
		tableCount.value = 0;
		mermaidSvg.value = '';
		generatedTs.value = '';
		nqlTag = null;
		return;
	}

	if (parsed.tables.length === 0) {
		if (myGen !== rebuildGeneration || disposed) return;
		schemaError.value = 'No tables defined';
		tableCount.value = 0;
		mermaidSvg.value = '';
		generatedTs.value = '';
		nqlTag = null;
		return;
	}

	if (myGen !== rebuildGeneration || disposed) return;
	tableCount.value = parsed.tables.length;
	generatedTs.value = generateTypeScript(parsed);

	try {
		const builtSchema = buildSchemaFromParsed(parsed);
		const orm = coreModule.createOrm({
			schema: builtSchema,
			adapter: adapterModule.createPgsqlCompileOnlyAdapter(),
		});
		nqlTag = orm.nql as NqlTag;
	} catch (e) {
		if (myGen !== rebuildGeneration || disposed) return;
		schemaError.value = `Schema error: ${e instanceof Error ? e.message : String(e)}`;
		nqlTag = null;
		return;
	}

	if (schemaExpanded.value) {
		await ensureMermaid();
		await renderDiagram(parsed, myGen);
	}
}

async function ensureMermaid() {
	if (mermaidInstance) return;
	const m = await import('mermaid');
	if (disposed) return;
	mermaidInstance = m.default;
	mermaidInstance.initialize({
		startOnLoad: false,
		theme: 'dark',
		er: { diagramPadding: 20, layoutDirection: 'TB', minEntityWidth: 100 },
	});
}

async function renderDiagram(parsed: ParsedSchema, gen: number): Promise<void> {
	if (!mermaidInstance) return;
	try {
		const code = buildMermaidCode(parsed);
		const id = `er-${gen}-${Date.now()}`;
		const { svg } = await mermaidInstance.render(id, code);
		if (gen !== rebuildGeneration || disposed) return;
		mermaidSvg.value = svg;
	} catch {
		if (gen !== rebuildGeneration || disposed) return;
		mermaidSvg.value = '';
	}
}

// ---------------------------------------------------------------------------
// URL hash sync
// ---------------------------------------------------------------------------

async function syncUrlHash() {
	if (disposed) return;
	if (!('CompressionStream' in window)) return;
	try {
		const encoded = await encodeHash({
			v: 1,
			s: schemaDsl.value,
			n: nqlCode.value,
			m: 'nql',
		});
		const nextHash = '#' + encoded;
		if (nextHash.length > MAX_HASH_LENGTH) {
			showOversizeBanner();
			return;
		}
		if (nextHash === lastEmittedHash) return;
		lastEmittedHash = nextHash;
		const nextUrl = window.location.pathname + window.location.search + nextHash;
		history.replaceState(history.state ?? {}, '', nextUrl);
	} catch {
		// Encoding failed (validation rejected). Schema error already surfaces.
	}
}

function scheduleHashSync() {
	if (hashWriteTimer !== null) clearTimeout(hashWriteTimer);
	hashWriteTimer = setTimeout(() => {
		hashWriteTimer = null;
		void syncUrlHash();
	}, 500);
}

function clearHashFromUrl() {
	const nextUrl = window.location.pathname + window.location.search;
	history.replaceState(history.state ?? {}, '', nextUrl);
	lastEmittedHash = null;
}

// ---------------------------------------------------------------------------
// Banner factories (omitted in this excerpt — see spec for full text)
// ---------------------------------------------------------------------------

function showVersionBanner(reason: 'version' | 'unknown'): void {
	errorBanner.value = {
		severity: 'warn',
		title: reason === 'version'
			? 'Shared link from a newer version'
			: "Couldn't restore the shared link",
		message: reason === 'version'
			? "This link uses a version of the playground hash format that isn't supported here. Loaded the default state."
			: 'The URL hash is corrupt, oversized, or contains unsupported content. Loaded the default playground instead.',
		actions: [
			{ label: 'Reset URL', handler: () => softResetUrl() },
			{ label: 'Got it', handler: () => (errorBanner.value = null) },
		],
	};
}

function showNoCompressionStreamBanner(): void {
	errorBanner.value = {
		severity: 'warn',
		title: "Couldn't restore the shared link",
		message: 'This link needs CompressionStream (Firefox 113+, Safari 16.4+, Chrome 80+). Loaded the default state.',
		actions: [
			{ label: 'Reset URL', handler: () => softResetUrl() },
			{ label: 'Got it', handler: () => (errorBanner.value = null) },
		],
	};
}

function showOversizeBanner(): void {
	errorBanner.value = {
		severity: 'warn',
		title: 'URL sharing paused',
		message: 'The current playground state is too large to share via URL. The page still works locally; URL sharing will resume when state shrinks below the limit.',
		actions: [
			{ label: 'Got it', handler: () => (errorBanner.value = null) },
		],
	};
}

function showFatalBanner(error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error);
	initFatal.value = true;
	errorBanner.value = {
		severity: 'fatal',
		title: "Couldn't load the playground",
		message: `A network issue prevented the playground modules from loading. (${detail})`,
		actions: [
			{ label: 'Reload', handler: () => window.location.reload() },
			{ label: 'Reset URL', handler: () => window.location.assign(window.location.pathname + window.location.search) },
		],
	};
}

function softResetUrl(): void {
	clearHashFromUrl();
	schemaDsl.value = DEFAULT_SCHEMA_DSL;
	selectedExampleIndex.value = 0;
	suppressNextNqlWatch = true;
	nqlCode.value = ALL_EXAMPLES[0]?.code ?? '';
	queryMode.value = 'nql';
	errorBanner.value = null;
	void rebuildOrm(schemaDsl.value).then(() => {
		if (!disposed && ready.value) compile();
	});
}

// ---------------------------------------------------------------------------
// Init flow
// ---------------------------------------------------------------------------

async function runInitFlow(): Promise<void> {
	isInitializing.value = true;

	if (window.location.hash) {
		const decoded = await decodeHash(window.location.hash);
		if (disposed) return;
		if (decoded.ok) {
			schemaDsl.value = decoded.payload.s;
			nqlCode.value = decoded.payload.n;
			queryMode.value = decoded.payload.m;
			lastEmittedHash = window.location.hash;
		} else if (decoded.reason === 'no-compression-stream') {
			showNoCompressionStreamBanner();
		} else if (decoded.reason === 'version') {
			showVersionBanner('version');
		} else if (
			decoded.reason === 'decode-error' ||
			decoded.reason === 'shape' ||
			decoded.reason === 'size' ||
			decoded.reason === 'identifier'
		) {
			showVersionBanner('unknown');
		}
	}

	try {
		const [core, adapter] = await Promise.all([
			import('@dbsp/core'),
			import('@dbsp/adapter-pgsql'),
		]);
		if (disposed) return;
		coreModule = core;
		adapterModule = adapter;
	} catch (e) {
		if (disposed) return;
		showFatalBanner(e);
		isInitializing.value = false;
		return;
	}

	await rebuildOrm(schemaDsl.value);
	if (disposed) return;

	if (!schemaError.value && nqlTag && nqlCode.value.trim()) {
		if (nqlDebounceTimer !== null) {
			clearTimeout(nqlDebounceTimer);
			nqlDebounceTimer = null;
		}
		performCompile({ resetTab: false });
	}

	isInitializing.value = false;
}

async function onHashChange() {
	if (disposed) return;
	if (window.location.hash === lastEmittedHash) return;
	if (nqlDebounceTimer !== null) clearTimeout(nqlDebounceTimer);
	nqlDebounceTimer = null;
	if (schemaDebounceTimer !== null) clearTimeout(schemaDebounceTimer);
	schemaDebounceTimer = null;
	rebuildGeneration += 1;
	pendingManualCompile = false;
	errorBanner.value = null;
	await runInitFlow();
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

watch(schemaDsl, (newDsl) => {
	if (schemaDebounceTimer !== null) clearTimeout(schemaDebounceTimer);
	const myTimer: ReturnType<typeof setTimeout> = setTimeout(async () => {
		await rebuildOrm(newDsl);
		if (schemaDebounceTimer !== myTimer || disposed) return;
		schemaDebounceTimer = null;
		if (pendingManualCompile) {
			pendingManualCompile = false;
			performCompile({ resetTab: true });
		} else if (nqlCode.value.trim()) {
			performCompile({ resetTab: false });
		}
		scheduleHashSync();
	}, 500);
	schemaDebounceTimer = myTimer;
});

watch(nqlCode, () => {
	if (suppressNextNqlWatch) {
		suppressNextNqlWatch = false;
		return;
	}
	if (nqlDebounceTimer !== null) clearTimeout(nqlDebounceTimer);
	nqlDebounceTimer = setTimeout(() => {
		nqlDebounceTimer = null;
		if (schemaDebounceTimer !== null) return;
		performCompile({ resetTab: false });
		scheduleHashSync();
	}, 300);
});

watch(schemaExpanded, async (expanded) => {
	if (expanded && !mermaidInstance) {
		await ensureMermaid();
		if (!disposed) {
			try {
				const parsed = parseSchemaDsl(schemaDsl.value);
				const myGen = ++rebuildGeneration;
				await renderDiagram(parsed, myGen);
			} catch {
				/* schema error already surfaced */
			}
		}
	}
});

// ---------------------------------------------------------------------------
// Sub-component event handlers
// ---------------------------------------------------------------------------

function onLoadExample(index: number): void {
	const ex = visibleExamples.value[index];
	if (!ex) return;
	selectedExampleIndex.value = index;
	if (nqlCode.value !== ex.code) {
		suppressNextNqlWatch = true;
		nqlCode.value = ex.code;
	}
	compile();
}

async function onCopyTs() {
	await navigator.clipboard.writeText(generatedTs.value);
	tsCopied.value = true;
	if (tsCopiedTimer !== null) clearTimeout(tsCopiedTimer);
	tsCopiedTimer = setTimeout(() => {
		tsCopied.value = false;
		tsCopiedTimer = null;
	}, 2000);
}

watch(generatedTs, () => {
	if (tsCopiedTimer !== null) clearTimeout(tsCopiedTimer);
	tsCopiedTimer = null;
	tsCopied.value = false;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(async () => {
	disposed = false;
	await runInitFlow();
	if (!disposed) {
		window.addEventListener('hashchange', onHashChange);
	}
});

onBeforeUnmount(() => {
	disposed = true;
	window.removeEventListener('hashchange', onHashChange);
	if (schemaDebounceTimer !== null) clearTimeout(schemaDebounceTimer);
	if (nqlDebounceTimer !== null) clearTimeout(nqlDebounceTimer);
	if (hashWriteTimer !== null) clearTimeout(hashWriteTimer);
	if (tsCopiedTimer !== null) clearTimeout(tsCopiedTimer);
	rebuildGeneration += 1;
	pendingManualCompile = false;
	suppressNextNqlWatch = false;
});
</script>

<template>
  <div class="playground" :aria-busy="isInitializing">
    <ErrorBanner :data="errorBanner" @dismiss="errorBanner = null" />

    <SchemaSection
      :dsl="schemaDsl"
      :table-count="tableCount"
      :mermaid-svg="mermaidSvg"
      :generated-ts="generatedTs"
      :schema-error="schemaError"
      :expanded="schemaExpanded"
      @update:dsl="schemaDsl = $event"
      @update:expanded="schemaExpanded = $event"
      @reset="softResetUrl"
      @copy-ts="onCopyTs"
    />

    <QuerySection
      :nql-code="nqlCode"
      :query-mode="queryMode"
      :examples="visibleExamples"
      :selected-example-index="selectedExampleIndex"
      :ready="ready"
      @update:nql-code="nqlCode = $event"
      @update:selected-example-index="onLoadExample"
      @compile="compile"
    />

    <div v-if="!initFatal" class="playground-output">
      <div v-if="isInitializing" class="output-skeleton" aria-live="polite">
        <span>Loading playground…</span>
      </div>
      <div v-else-if="compileError" class="output-error" role="alert">
        <pre>{{ compileError }}</pre>
      </div>
      <template v-else-if="result">
        <PlanSection :result="result" />
        <OutputSection :result="result" />
      </template>
      <div v-else class="output-placeholder">
        <span>Click "Compile" to see the output.</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playground {
  margin: var(--dbsp-space-xl, 1.5rem) 0;
  padding: var(--dbsp-space-md, 0.75rem);
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: var(--dbsp-radius-lg, 12px);
  background: var(--vp-c-bg-soft);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}

.output-skeleton {
  position: relative;
  min-height: 200px;
  border-radius: var(--dbsp-radius-md, 8px);
  background: linear-gradient(
    90deg,
    var(--vp-c-bg-soft) 0%,
    var(--vp-c-bg) 50%,
    var(--vp-c-bg-soft) 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s ease-in-out infinite;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-3);
  font-size: 0.85rem;
}

@keyframes skeleton-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.output-error {
  background: color-mix(in srgb, var(--dbsp-c-error) 8%, transparent);
  border-left: 3px solid var(--dbsp-c-error);
  border-radius: var(--dbsp-radius-sm, 4px);
  padding: var(--dbsp-space-md, 0.75rem);
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  color: var(--dbsp-c-error);
  white-space: pre-wrap;
}

.output-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-3);
  font-size: 0.85rem;
  min-height: 200px;
  padding: var(--dbsp-space-md, 0.75rem);
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--dbsp-radius-md, 8px);
}
</style>
```

- [ ] **Step 9.3: Migrate the parser/generator helpers**

For each of the four placeholder helpers (`parseSchemaDsl`, `buildSchemaFromParsed`, `generateTypeScript`, `buildMermaidCode`):

1. `git show HEAD:packages/docs/.vitepress/theme/Playground.vue | grep -nA 40 "function <name>"` to read the original implementation.
2. Paste the body into the new file, replacing the `throw` placeholder.
3. If the helper references types not in scope (e.g. `ParsedColumn`), copy the local interface declarations as well — keep them at the bottom of the file's `<script setup>`.
4. Migrate `DEFAULT_SCHEMA_DSL` and `ALL_EXAMPLES` verbatim too.

- [ ] **Step 9.4: Sanity-build with the rewrite**

```bash
pnpm -C packages/docs build > /tmp/build.log 2>&1; echo "EXIT:$?"; grep -E "Error|error TS|warn" /tmp/build.log | head -20
```

Expected: `EXIT:0`. Some `nql language not loaded` warnings are pre-existing and OK.

- [ ] **Step 9.5: Visit the dev server and verify the page loads**

```bash
pnpm -C packages/docs dev > /tmp/dev.log 2>&1 &
sleep 4
curl -sS -o /dev/null -w "playground=%{http_code}\n" http://localhost:5173/playground
# Expected: playground=200
```

Open `http://localhost:5173/playground` in a browser. Verify:
- Schema bar collapsed at top with table count visible.
- Query section pre-filled with the first example.
- Plan section + Output section visible (auto-compile fired).
- No console errors.
- Click `▾` on the schema bar → schema body expands → diagram tab loads mermaid (lazy).
- Type something in the textarea → after 300ms, plan + sql update.
- Click an example → state changes, no double-compile.
- `Ctrl+Enter` in textarea → compiles.

- [ ] **Step 9.6: Commit the rewrite**

```bash
git add packages/docs/.vitepress/theme/Playground.vue
git commit -m "refactor(docs): rewrite Playground as orchestrator over sub-components"
```

---

### Task 10: Manual verification of the spec's success criteria

**Why:** Spec § "Verification (during implementation)". This task runs through every check listed there.

**Files:** none (verification only)

- [ ] **Step 10.1: Lighthouse on /playground**

With dev server running:

```bash
pnpm -C packages/docs build > /tmp/build.log 2>&1 && pnpm -C packages/docs preview &
sleep 3
# Then run Lighthouse against http://localhost:4173/playground from the browser DevTools.
```

Expected: LCP < 2.5s, CLS < 0.1, INP < 200ms on the Mobile Fast-4G profile. Capture the report.

- [ ] **Step 10.2: Hash round-trip**

In a browser DevTools console at `/playground`:

```js
// Edit schema/query in the playground manually, wait 500ms, then:
const sharedUrl = window.location.href;
console.log(sharedUrl);
// Open that URL in a new tab. Verify state matches.
```

Expected: schema, NQL, and compiled output identical in both tabs.

- [ ] **Step 10.3: Hash oversize**

In DevTools console:

```js
document.querySelector('.schema-dsl').value = 'a'.repeat(9000);
document.querySelector('.schema-dsl').dispatchEvent(new Event('input'));
// Wait ~1s. The "URL sharing paused" banner should appear at top.
```

Expected: warn banner with `Got it` action. URL bar stays at the previous valid hash.

- [ ] **Step 10.4: hashchange in-page navigation**

Construct two valid hashed URLs A and B (use the round-trip from 10.2 to obtain them). With the page on URL A:

```js
window.location.hash = 'h=...'; // paste B's hash content here
```

Expected: state restores from B's payload without a full remount (DevTools Performance shows no `load` event).

- [ ] **Step 10.5: Sanitization rejection**

```js
window.location.hash = '#h=corrupt-payload-here';
```

Expected: warn banner appears with "Couldn't restore the shared link" message.

- [ ] **Step 10.6: Version mismatch**

```js
const stream = new CompressionStream('gzip');
const w = stream.writable.getWriter();
w.write(new TextEncoder().encode(JSON.stringify({ v: 99, s: 'x', n: 'y', m: 'nql' })));
w.close();
const bytes = new Uint8Array(await new Response(stream.readable).arrayBuffer());
const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
window.location.hash = '#h=' + b64;
```

Expected: warn banner with "Shared link from a newer version" message.

- [ ] **Step 10.7: Reset URL preserves search + scroll**

Visit `/playground?foo=bar#h=anything`. Scroll mid-page. Click `Reset` in the schema header.

Expected: URL becomes `/playground?foo=bar` (hash dropped, search preserved). Scroll position retained. No full reload (DevTools Network shows no document fetch).

- [ ] **Step 10.8: Mobile viewport + touch pan/zoom**

In DevTools, switch to a 320×640 mobile profile:
- Verify vertical layout (schema bar → query → plan → output, no horizontal scroll).
- Expand schema → diagram tab → use touch-emulation (Chrome DevTools "Touch" mode) to pinch and pan the diagram.

Expected: pinch zooms, drag pans, no browser-default behavior intercepts.

- [ ] **Step 10.9: Unsupported-browser fallback**

In DevTools console at fresh `/playground`:

```js
delete CompressionStream;
delete DecompressionStream;
// Reload the page with a hashed URL (use one from 10.2).
```

Expected: warn banner with "Couldn't restore the shared link" and reference to CompressionStream. Default state loaded.

- [ ] **Step 10.10: Module load fatal**

In DevTools Network tab → set throttling to "Offline" → reload `/playground`.

Expected: fatal banner with "Couldn't load the playground" and `Reload`/`Reset URL` actions. Output panel hidden.

- [ ] **Step 10.11: Disposal — navigate away mid-init**

Reload `/playground`. Within 1 second of the reload (while the skeleton is still showing), click the "Home" link in the VitePress nav.

Expected: console clean. No "Cannot mutate ref after unmount" warnings. No stray timer fires.

- [ ] **Step 10.12: Verification report**

If all 11 checks pass, no commit needed. If anything failed, file the failure as a follow-up TODO before merging.

---

### Task 11: Open the GitHub follow-up issues

**Why:** Spec § "Out of scope" — track what we explicitly deferred so it doesn't get lost.

**Files:** none (issue creation via gh CLI)

- [ ] **Step 11.1: Open the embed-in-guides issue**

```bash
gh issue create \
  --title "Refactor Playground for embedding in guides — API and decomposition TBD" \
  --body "Today \`<Playground>\` is single-use on \`/playground.md\`. Future guides (recursive CTE, range operators, FTS) could benefit from live, embeddable examples. Decide later whether this means:
  - One configurable component with props (\`initial-schema\`, \`initial-query\`, \`mode\`, \`hide-schema-editor\`)
  - Two components (full + embedded variant)
  - Decomposition into smaller pieces (\`<SchemaSection>\`, \`<QueryInput>\`, \`<OutputPanel>\`, \`<PlanCards>\`) that consumers compose

Concrete-use-case driven: don't design the API until at least 2 guide pages have asked for it. The redesign in #N (this PR) prepared the ground via internal sub-component decomposition."
```

- [ ] **Step 11.2: Open the LZMA fallback issue**

```bash
gh issue create \
  --title "Add LZMA fallback for oversize schema URL hashes (eat-your-own-dogfood with node-liblzma)" \
  --body "When the gzip-compressed hash exceeds \`MAX_HASH_LENGTH\`, the playground currently surfaces a 'URL sharing paused' banner. For users with very large schemas, an LZMA fallback (via \`oorabona/node-liblzma\` wasm, ~80 KB gzipped) would compress 15-25% better on text > 1 KB.

Lazy-load the wasm only on demand (e.g., a 'Share large schema' button). Don't add to the critical path of the playground first paint. Track size budget impact on Lighthouse before merging."
```

- [ ] **Step 11.3: (Optional) Multi-instance refactor**

Open only if a real guide page has asked for an embedded playground:

```bash
gh issue create \
  --title "Refactor Playground module-scope state to per-instance composables (multi-instance support)" \
  --body "Today \`Playground.vue\` keeps several \`let\` state declarations at module scope. This works for single-instance usage on \`/playground.md\`. To embed multiple playgrounds in the same page (post embed-in-guides feature), migrate the state to composables called inside each instance's setup."
```

---

### Task 12: Open PR + Copilot review loop

**Files:** none (PR workflow)

- [ ] **Step 12.1: Push the branch**

```bash
git push -u origin feat/playground-redesign
```

- [ ] **Step 12.2: Pre-PR senior review (recommended for >100-LOC PRs)**

This redesign is large. Run a senior pre-PR review:

```bash
git diff main..HEAD > /tmp/redesign-diff.patch && wc -l /tmp/redesign-diff.patch
# Then dispatch a senior-code-reviewer agent (per project memory feedback_prepush_senior_review.md).
```

Fold any S/M findings before opening the PR.

- [ ] **Step 12.3: Open the PR**

```bash
gh pr create \
  --title "feat(docs): T2.5 Playground redesign — schema collapsed top, Plan-as-hero, URL hash sharing" \
  --body-file /tmp/pr-body.md \
  --reviewer copilot-pull-request-reviewer
```

PR body should reference the spec (`docs/superpowers/specs/2026-05-05-playground-redesign-design.md`) and the plan (`docs/superpowers/plans/2026-05-05-playground-redesign.md`).

- [ ] **Step 12.4: Copilot watchdog**

Per project convention, schedule a wakeup ~270s after each push and iterate per `Skill("copilot-review-loop")` until convergence. If hard cap reached and only L items remain, push final commit using `git push  # NO-COPILOT-REVIEW` on the command line (NEVER in commit body — see `feedback_no_internal_markers_in_commits.md`).

---

## Self-review

After writing this plan, audit it against the spec:

1. **Spec coverage:** Each spec section has at least one task implementing it.
   - Why / Goals / Non-goals → Tasks 5-9 (layout) + Task 9 (hash format / lifecycle) + Task 10 (verification budget)
   - User journey → Tasks 5/6/7/8/9
   - Anatomy → Tasks 4-9
   - Lifecycle → Task 9 (mount + hashchange + onBeforeUnmount)
   - Decision-card collapse preservation → Task 7 (PlanDecisions.vue local watcher)
   - URL hash format → Tasks 2-3 (codec + sanitize) + Task 9 (writer)
   - Security & sanitization → Task 2
   - Error banner → Task 4 + Task 9 (banner factories)
   - Auto-compile semantics → Task 9 (compile + watchers)
   - Component decomposition → Tasks 4-8
   - Accessibility → Tasks 4-9 (per-component aria) + Task 5 (pointer events)
   - Out of scope → Task 11 (issues created)
   - Verification → Task 10
   - Approved decision summary → covered transitively by all tasks above.

2. **Placeholder scan:**
   - Task 9 stubs `parseSchemaDsl`, `buildSchemaFromParsed`, `generateTypeScript`, `buildMermaidCode` and explicitly directs the implementer to migrate them verbatim. This is a deliberate, traceable migration step — not a vague "TBD". Step 9.3 spells out the migration procedure.
   - No "implement later" / "fill in details" / "similar to Task N" patterns.

3. **Type consistency:**
   - `ErrorBannerData` defined in `types.ts` (Task 2) → used in `ErrorBanner.vue` (Task 4) and parent (Task 9). Consistent.
   - `HashPayloadV1` (`{ v: 1, s, n, m: 'nql' }`) used in sanitize (Task 2), hash-codec (Task 3), and parent (Task 9). Consistent.
   - `Dump`, `PlanDecision`, `CTEDefinition` imported from `@dbsp/core` in PlanSection (Task 7), PlanDecisions (Task 7), OutputSection (Task 8), parent (Task 9). Consistent.
   - Component prop names match parent's bindings — verified by reading both sides during plan writing.

4. **Bite-sized step granularity:**
   - Each task has 4-12 numbered steps.
   - Each step is one action (write a file, run a command, commit, verify a build).
   - No "implement everything" mega-steps.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-05-playground-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 12-task / multi-day plan with clear isolation between tasks.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. Best if you want continuous oversight.

**Which approach?**
