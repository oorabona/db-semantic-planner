/**
 * E15 — Row-Level Locking Schema
 *
 * Simple job queue schema to exercise FOR UPDATE / FOR SHARE locking.
 *
 * Tables:
 *   jobs — work items with status lifecycle (pending → running → done/failed)
 */

import { schema } from '@dbsp/core';

export default schema({
	jobs: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		status: 'string',
		priority: 'integer',
		payload: { type: 'string', nullable: true },
		workerId: { type: 'string', nullable: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
});
