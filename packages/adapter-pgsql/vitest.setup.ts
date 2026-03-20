import { deparseSync } from 'pgsql-deparser';

// Pre-load libpg-query WASM module before any test runs.
// Without this, parallel test workers race to initialize the WASM module,
// causing flaky failures in ast-compare and deparse-dependent tests.
deparseSync({ SelectStmt: {} });
