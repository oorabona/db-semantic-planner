/**
 * @dbsp/types - Shared type definitions for @dbsp packages
 *
 * This package contains types that are shared across multiple @dbsp packages
 * without introducing circular dependencies.
 *
 * Public types (import from '@dbsp/types'):
 * - SortDirection, RangeValue - Utility types
 * - DumpMeta, CompiledQuery - Adapter result types
 *
 * @module @dbsp/types
 */

// Public adapter types
export type {
	CompiledQuery,
	CompileOptionsBase,
	DumpMeta,
} from './public/adapter.js';

// Shared utility types
export type { RangeValue, SortDirection } from './shared/utils.js';
