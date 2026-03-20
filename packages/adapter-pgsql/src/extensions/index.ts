/**
 * adapter-pgsql Extensions
 *
 * PostgreSQL-specific extension wrappers built on top of the core expression primitives.
 */

export {
	cosineDistance,
	innerProduct,
	l2Distance,
	rawDistance,
} from './pgvector.js';
