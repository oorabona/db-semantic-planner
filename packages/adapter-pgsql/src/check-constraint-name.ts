import type { CheckConstraintIR } from '@dbsp/types';
import type { NamingPlugin } from './naming-plugin.js';

export function getCheckConstraintDatabaseName(
	check: Pick<CheckConstraintIR, 'name'>,
	naming: NamingPlugin,
): string {
	return naming.toDatabase(check.name);
}
