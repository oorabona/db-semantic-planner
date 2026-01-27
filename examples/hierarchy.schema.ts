/**
 * Example: Hierarchy Schema — Self-Referential Traversal
 *
 * Demonstrates pseudo-column features for hierarchical data:
 * - Custom roles: manager/reports (instead of default parent/child)
 * - Chained traversal: manager.manager.name (grandparent access)
 * - Dynamic keywords from schema configuration
 * - PlanOptions for strategy control
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/hierarchy.schema.ts
 *   pnpm dbsp generate kysely --schema ./examples/hierarchy.schema.ts
 *
 * Example NQL queries:
 *   > employees | select name, manager.name
 *   > employees | select name, manager.manager.name
 *   > employees | where manager.name = 'Alice'
 */

import { ref, schema } from '@dbsp/core';

export default schema({
	departments: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		budget: { type: 'decimal', nullable: true },
	},
	employees: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		email: { type: 'string', unique: true },
		title: 'string',
		departmentId: ref('departments', {
			onDelete: 'SET NULL',
			inverse: 'employees',
		}),
		// Self-referential FK with custom roles:
		// - manager: direct parent (who do I report to?)
		// - directReports: direct children (who reports to me?)
		// - managementChain: all ancestors recursively (CTE)
		// - allReports: all descendants recursively (CTE)
		managerId: ref('employees', {
			nullable: true,
			roles: {
				parent: 'manager',
				children: 'directReports',
				ancestors: 'managementChain',
				descendants: 'allReports',
			},
		}),
		hireDate: 'date',
		salary: 'decimal',
	},
	projects: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		leadId: ref('employees', { onDelete: 'SET NULL', inverse: 'ledProjects' }),
		departmentId: ref('departments', { onDelete: 'CASCADE' }),
		status: { type: 'string', default: 'active' },
	},
});
// Relations auto-inferred from ref():
// - departments.employees (hasMany)
// - employees.department (belongsTo)
// - employees.manager (self-ref: parent role = 'manager')
// - employees.directReports (self-ref: children role)
// - employees.managementChain (self-ref: recursive ancestors)
// - employees.allReports (self-ref: recursive descendants)
// - employees.ledProjects (hasMany)
// - projects.lead (belongsTo)
// - projects.department (belongsTo)
