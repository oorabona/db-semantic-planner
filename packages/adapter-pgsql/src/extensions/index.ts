/**
 * adapter-pgsql Extensions
 *
 * PostgreSQL-specific extension wrappers built on top of the core expression primitives.
 */

export {
	bm25Search,
	booleanSearch,
	boost,
	parse,
	score,
} from './paradedb.js';
export { generateSeries, nextval } from './pgsql-builtins.js';
export {
	cosineDistance,
	innerProduct,
	l2Distance,
	rawDistance,
} from './pgvector.js';
