/**
 * Shared dependencies injected into AdapterCompiler sub-modules.
 * Extracted from PgsqlAdapter fields to enable compilation without `this`.
 *
 * @internal
 */

import type { DialectCapabilities, ModelIR } from '@dbsp/types';
import type { FkColumnDerivation } from './assert-field.js';
import type { BindingNameRegistry, QueryScope } from './binding-registry.js';
import type { DeclaredNameResolver } from './declared-name-resolver.js';
import type { NamingPlugin } from './naming-plugin.js';
import type { PgPhysicalModel } from './physical-model/index.js';
import type { RelationTargetProjectionRegistry } from './relation-target-projection.js';

/**
 * All state that compilation methods need from PgsqlAdapter.
 * Passed by reference — constructed once in PgsqlAdapter constructor.
 */
export interface AdapterCompilerDeps {
	readonly naming: NamingPlugin;
	readonly schemaName: string | undefined;
	readonly model: ModelIR | undefined;
	/** Cached physical authority for the logical model used by this compile. */
	readonly physicalModel?: PgPhysicalModel | undefined;
	/** Resolves declared model objects; query-local names never go through it. */
	readonly declaredNames?: DeclaredNameResolver | undefined;
	readonly dialectCapabilities?: DialectCapabilities;
	readonly defaultPk: string;
	readonly deriveFk: FkColumnDerivation;
	/** Query-local relation authority established by the adapter boundary. */
	readonly scope?: QueryScope;
	readonly bindingNames?: BindingNameRegistry;
	readonly relationTargetProjections?: RelationTargetProjectionRegistry;
}
