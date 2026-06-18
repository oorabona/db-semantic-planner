/**
 * Shared dependencies injected into AdapterCompiler sub-modules.
 * Extracted from PgsqlAdapter fields to enable compilation without `this`.
 *
 * @internal
 */

import type { DialectCapabilities, ModelIR } from '@dbsp/types';
import type { FkColumnDerivation } from './assert-field.js';
import type { BindingNameRegistry } from './binding-registry.js';
import type { NamingPlugin } from './naming-plugin.js';

/**
 * All state that compilation methods need from PgsqlAdapter.
 * Passed by reference — constructed once in PgsqlAdapter constructor.
 */
export interface AdapterCompilerDeps {
	readonly naming: NamingPlugin;
	readonly schemaName: string | undefined;
	readonly model: ModelIR | undefined;
	readonly dialectCapabilities?: DialectCapabilities;
	readonly defaultPk: string;
	readonly deriveFk: FkColumnDerivation;
	readonly bindingNames?: BindingNameRegistry;
}
