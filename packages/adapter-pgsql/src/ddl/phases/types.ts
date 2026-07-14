/**
 * Shared types for DDL generation phases.
 *
 * Each phase receives a PhaseContext containing the full set of
 * generation options resolved from GenerateDDLOptions.
 *
 * @module ddl/phases/types
 */

import type { DialectCapabilities, ModelIR, TableIR } from '@dbsp/types';
import type { NamingPlugin } from '../../naming-plugin.js';

/**
 * Resolved context passed to every DDL generation phase.
 * Contains all options from GenerateDDLOptions plus the resolved tables array.
 */
export type PhaseContext = {
	readonly schema: ModelIR;
	readonly tables: TableIR[];
	/** Database schema identifier resolved from GenerateDDLOptions; never pass through naming plugins. */
	readonly schemaName: string | undefined;
	readonly naming: NamingPlugin;
	readonly caps: DialectCapabilities | undefined;
	readonly fkAutoIndex: boolean;
	readonly includeDropStatements: boolean;
};

/**
 * Check whether a DDL feature is supported given DialectCapabilities.
 *
 * - `undefined` caps: no capability restriction → feature is on by default.
 * - `false`: capability explicitly disabled → feature is skipped.
 * - `true`: capability explicitly enabled → feature is included.
 */
export function sup(
	caps: DialectCapabilities | undefined,
	flag: boolean | undefined,
): boolean {
	return !caps || flag === true;
}
