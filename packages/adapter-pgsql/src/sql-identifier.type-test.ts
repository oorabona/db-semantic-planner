import { resolveDeclaredIdentifier } from './sql-identifier.js';

// @ts-expect-error Declared-name resolution requires an addressed name, not a raw string.
resolveDeclaredIdentifier(undefined, 'preserve', 'users');
