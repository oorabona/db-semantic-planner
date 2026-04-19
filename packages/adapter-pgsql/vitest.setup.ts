import { deparseSync } from 'pgsql-deparser';
import { loadModule } from 'pgsql-parser';

// Pre-load libpg-query WASM module before any test runs.
// Without this, parallel test workers race to initialize the WASM module,
// causing flaky failures in ast-compare and deparse-dependent tests.
deparseSync({ SelectStmt: {} });

// Pre-load pgsql-parser's WASM (libpg-query) — separate from pgsql-deparser
// which is pure JS and needs no WASM init. parseSync callers in
// raw-expression-parser.test.ts fail with "WASM module not initialized" in
// CI fresh environments when this warm-up is missing.
// vitest setup files are awaited before any test file runs, making this safe.
await loadModule();
