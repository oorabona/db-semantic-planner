import { deparseSync } from 'pgsql-deparser';
import { loadModule } from 'pgsql-parser';

// pgsql-deparser is pure JS (internalized in commit 8c161e7 — WASM removed).
// The call below is a smoke check that the module loads without errors;
// it does NOT initialise any WASM binary.
deparseSync({ SelectStmt: {} });

// pgsql-parser wraps libpg-query which loads a WASM binary asynchronously on
// first use. In a cold CI environment, parallel vitest workers race to
// initialise it — causing "WASM module not initialized" failures in
// parseSync-dependent tests (e.g. raw-expression-parser.test.ts).
// One await here serialises WASM init before any worker-level test file runs.
// vitest setup files are awaited before workers start, making this safe.
await loadModule();
