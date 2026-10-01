import { sqlColumnRef } from './ast-helpers.js';

// @ts-expect-error Include emission accepts only identifiers that crossed an authority boundary.
sqlColumnRef('parent_id');
