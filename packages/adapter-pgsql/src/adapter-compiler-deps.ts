/**
 * Shared dependencies injected into AdapterCompiler sub-modules.
 * Extracted from PgsqlAdapter fields to enable compilation without `this`.
 *
 * @internal
 */

import type { ModelIR } from '@dbsp/types';
import type { FkColumnDerivation } from './assert-field.js';
import type { NamingPlugin } from './naming-plugin.js';

/**
 * All state that compilation methods need from PgsqlAdapter.
 * Passed by reference — constructed once in PgsqlAdapter constructor.
 */
export interface AdapterCompilerDeps {
	readonly naming: NamingPlugin;
	readonly schemaName: string | undefined;
	readonly model: ModelIR | undefined;
	readonly defaultPk: string;
	readonly deriveFk: FkColumnDerivation;
}
