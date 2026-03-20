/**
 * Deparse AST to SQL string.
 * Uses the internal deparser for production; pgsql-deparser stays in devDeps
 * for comparison tests only.
 */
import type { Node } from '@pgsql/types';
import { deparse } from './pgsql-deparser.js';

export function deparseQuoted(ast: Node): string {
	return deparse(ast);
}
