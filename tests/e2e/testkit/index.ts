/**
 * E2E Testkit
 *
 * Re-exports all testkit utilities for easy imports.
 */

// Database utilities
export {
	closeTestDb,
	createAdapterForSchema,
	createSchema,
	describeE2E,
	dropSchema,
	execInSchema,
	getTestAdapter,
	getTestDb,
	shouldSkipE2E,
} from './db.js';

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

// Blog
export { createBlogSchema, dropBlogSchema } from './blog.ddl.js';
export { blogModel } from './blog.model.js';
export { seedBlogData } from './blog.seed.js';

// IAM/RBAC
export { createIamSchema, dropIamSchema } from './iam.ddl.js';
export { iamModel } from './iam.model.js';
export { seedIamData, iamTestData } from './iam.seed.js';

// Blog Extended (complex testing - M:N, hierarchies)
export {
	createBlogExtendedSchema,
	dropBlogExtendedSchema,
} from './blog-extended.ddl.js';
export { blogExtendedModel } from './blog-extended.model.js';
export { seedBlogExtendedData, blogExtendedTestData } from './blog-extended.seed.js';
