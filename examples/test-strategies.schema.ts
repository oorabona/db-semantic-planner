/**
 * Strategy Coverage Schema
 *
 * Compact schema designed to exercise ALL include strategies:
 * - json_agg (default for 1:N, M:N)
 * - flat/lateral (| flat modifier)
 * - CTE (self-referencing hierarchies)
 * - subquery (planner auto-selection)
 * - join (belongsTo)
 *
 * Also covers uncovered NQL features: between, like, in, case when,
 * mutations (insert, update, delete, upsert), and deep nesting.
 *
 * Relations:
 *   orgs ←self-ref (parent/children/ancestors/descendants)
 *   orgs → departments (1:N)
 *   departments → employees (1:N)
 *   employees ←→ projects (M:N via assignments)
 *   projects → tasks (1:N, for deep nesting)
 */

import { ref, schema } from '@dbsp/core';

export default schema({
	orgs: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		parentId: ref('orgs', {
			nullable: true,
			onDelete: 'SET NULL',
			roles: {
				parent: 'parent',
				children: 'children',
				ancestors: 'ancestors',
				descendants: 'descendants',
			},
		}),
		active: { type: 'boolean', default: 'true' },
	},
	departments: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		orgId: ref('orgs', { onDelete: 'CASCADE', inverse: 'departments' }),
		budget: { type: 'decimal', nullable: true },
	},
	employees: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		email: { type: 'string', unique: true },
		departmentId: ref('departments', { onDelete: 'CASCADE', inverse: 'employees' }),
		salary: 'decimal',
		hireDate: 'date',
		active: { type: 'boolean', default: 'true' },
	},
	projects: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		status: { type: 'string', default: "'active'" },
		startDate: 'date',
		endDate: { type: 'date', nullable: true },
	},
	assignments: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		employeeId: ref('employees', { onDelete: 'CASCADE', inverse: 'assignments' }),
		projectId: ref('projects', { onDelete: 'CASCADE', inverse: 'assignments' }),
		role: { type: 'string', default: "'member'" },
		hoursPerWeek: { type: 'integer', default: '40' },
	},
	tasks: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		title: 'string',
		projectId: ref('projects', { onDelete: 'CASCADE', inverse: 'tasks' }),
		assigneeId: ref('employees', { nullable: true, onDelete: 'SET NULL', inverse: 'tasks' }),
		priority: { type: 'integer', default: '3' },
		completed: { type: 'boolean', default: 'false' },
	},
});
