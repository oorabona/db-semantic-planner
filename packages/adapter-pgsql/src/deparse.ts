/**
 * Deparse AST to SQL string.
 * Re-exports deparseSync from pgsql-deparser with a consistent API.
 */
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';

export function deparseQuoted(ast: Node): string {
	return deparseSync(ast);
}
