/**
 * E2E Testkit
 *
 * Re-exports all testkit utilities for easy imports.
 */

// Blog
export { createBlogSchema, dropBlogSchema } from './blog.ddl.js';
export { blogModel, blogSchema } from './blog.model.js';
export { seedBlogData } from './blog.seed.js';
// Blog Extended (complex testing - M:N, hierarchies)
export {
	createBlogExtendedSchema,
	dropBlogExtendedSchema,
} from './blog-extended.ddl.js';
export { blogExtendedModel } from './blog-extended.model.js';
export {
	blogExtendedTestData,
	seedBlogExtendedData,
} from './blog-extended.seed.js';
// Categories adjacency-list recursion
export {
	createCategoriesSchema,
	dropCategoriesSchema,
} from './categories.ddl.js';
export { categoriesModel, categoriesSchema } from './categories.model.js';
export { seedCategoriesData } from './categories.seed.js';
// Composite-FK correctness
export {
	createCompositeFkSchema,
	dropCompositeFkSchema,
} from './composite-fk.ddl.js';
export { compositeFkModel } from './composite-fk.model.js';
export { seedCompositeFkData } from './composite-fk.seed.js';
// Database utilities
export {
	closeTestDb,
	createPgsqlAdapterForSchema,
	createSchema,
	dropSchema,
	execInSchema,
	getPgsqlAdapter,
	getTestAdapter,
	getTestPool,
} from './db.js';
// EXISTS-correctness (regression suite for fix/core-correctness-130)
export {
	createExistsCorrectnessSchema,
	dropExistsCorrectnessSchema,
} from './exists-correctness.ddl.js';
export { existsCorrectnessModel } from './exists-correctness.model.js';
export { seedExistsCorrectnessData } from './exists-correctness.seed.js';
// IAM/RBAC
export { createIamSchema, dropIamSchema } from './iam.ddl.js';
export { iamModel } from './iam.model.js';
export { iamTestData, seedIamData } from './iam.seed.js';
// Issue 154 invalid-SQL regression domain
export {
	createIssue154Schema,
	dropIssue154Schema,
} from './issue-154.ddl.js';
export { issue154Model, issue154Schema } from './issue-154.model.js';
export { seedIssue154Data } from './issue-154.seed.js';
// PIM/DAM (base)
export { createPimdamSchema, dropPimdamSchema } from './pimdam.ddl.js';
export { pimdamModel } from './pimdam.model.js';
export { seedAcmeTenant, seedGlobexTenant } from './pimdam.seed.js';
// PIM/DAM (extended for E2E-002)
export {
	createExtendedPimdamSchema,
	dropExtendedPimdamSchema,
} from './pimdam-extended.ddl.js';
export { pimdamExtendedModel } from './pimdam-extended.model.js';
export {
	seedExtendedPimdam,
	seedExtendedPimdamTenant2,
} from './pimdam-extended.seed.js';

// Scheduling (PostgreSQL range types)
export {
	createSchedulingSchema,
	dropSchedulingSchema,
} from './scheduling.ddl.js';
export { schedulingModel } from './scheduling.model.js';
export { schedulingTestData, seedSchedulingData } from './scheduling.seed.js';
export type { SqlResult } from './sql.js';
// SQL utilities (Kysely-compatible API for pg Pool)
export { SqlFragment, sql } from './sql.js';
