import { relationBinding } from '../../binding-registry.js';
import { queryLocal } from '../../sql-identifier.js';
import { expressionResolvedColumnRef } from '../types.js';

const binding = relationBinding({
	qualifier: queryLocal('activeCategories'),
	kind: 'cte-bind',
});

// @ts-expect-error Converted expression exports reject unclassified strings.
expressionResolvedColumnRef('raw_column', binding);
expressionResolvedColumnRef(queryLocal('resolved_column'), binding);
