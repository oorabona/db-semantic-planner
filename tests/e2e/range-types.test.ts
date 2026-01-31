/**
 * PostgreSQL Range Types E2E Tests
 *
 * Tests range operators (overlaps, contains, containedBy) with real PostgreSQL:
 * - daterange: Date ranges for bookings
 * - tstzrange: Timestamp ranges for events
 * - int4range: Integer ranges for price tiers
 *
 * Requires PostgreSQL 9.2+ (when range types were introduced).
 */

import {
	createOrm,
	rangeContainedBy,
	rangeContains,
	rangeOverlaps,
} from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchedulingSchema,
	dropSchedulingSchema,
	getTestAdapter,
	schedulingModel,
	schedulingTestData,
	seedSchedulingData,
	
} from './testkit/index.js';

describe('PostgreSQL Range Types', () => {
	const SCHEMA = 'scheduling_e2e';

	beforeAll(async () => {
		await dropSchedulingSchema(SCHEMA);
		await createSchedulingSchema(SCHEMA);
		await seedSchedulingData(SCHEMA);
	});

	afterAll(async () => {
		await dropSchedulingSchema(SCHEMA);
		await closeTestDb();
	});

	describe('rangeOverlaps (&&)', () => {
		it('should find bookings overlapping a date range', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find bookings that overlap with Jan 17-19, 2024
			const bookings = await orm
				.withSchema(SCHEMA)
				.select('roomBookings')
				.where(
					rangeOverlaps('bookingPeriod', {
						lower: '2024-01-17',
						upper: '2024-01-20',
					}),
				)
				.columns(['id', 'bookedBy', 'purpose', 'bookingPeriod'])
				.execute();

			// Should find "Team offsite" (Jan 15-20) and "Monthly board meetings" (Jan 1-31)
			expect(bookings.length).toBeGreaterThanOrEqual(2);
			const purposes = bookings.map((b: { purpose: string }) => b.purpose);
			expect(purposes).toContain('Team offsite');
			expect(purposes).toContain('Monthly board meetings');
		});

		it('should find events overlapping a timestamp range', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find events overlapping with Jan 15, 2024 10:00-12:00 UTC
			const events = await orm
				.withSchema(SCHEMA)
				.select('events')
				.where(
					rangeOverlaps('timeSlot', {
						lower: '2024-01-15 10:00:00+00',
						upper: '2024-01-15 12:00:00+00',
					}),
				)
				.columns(['id', 'title', 'organizer'])
				.execute();

			// Should find "Tech Talk" (11:00-12:00)
			const titles = events.map((e: { title: string }) => e.title);
			expect(titles).toContain('Tech Talk');
		});

		it('should find price tiers overlapping a quantity range', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find tiers overlapping with quantity 20-60
			const tiers = await orm
				.withSchema(SCHEMA)
				.select('priceTiers')
				.where(
					rangeOverlaps('quantityRange', {
						lower: 20,
						upper: 60,
					}),
				)
				.columns(['id', 'productName', 'quantityRange', 'unitPrice'])
				.execute();

			// Should find [10, 50) and [50, 100) tiers
			expect(tiers.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('rangeContains (@>)', () => {
		it('should find bookings that contain a specific date', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find bookings that contain Jan 18, 2024
			const bookings = await orm
				.withSchema(SCHEMA)
				.select('roomBookings')
				.where(rangeContains('bookingPeriod', '2024-01-18'))
				.columns(['id', 'bookedBy', 'purpose'])
				.execute();

			// Should find "Team offsite" (Jan 15-20) and "Monthly board meetings" (Jan 1-31)
			const purposes = bookings.map((b: { purpose: string }) => b.purpose);
			expect(purposes).toContain('Team offsite');
			expect(purposes).toContain('Monthly board meetings');
		});

		it('should find price tier containing a specific quantity', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find tier for quantity 25
			const tiers = await orm
				.withSchema(SCHEMA)
				.select('priceTiers')
				.where(rangeContains('quantityRange', 25))
				.columns(['id', 'productName', 'unitPrice'])
				.execute();

			expect(tiers).toHaveLength(1);
			expect(tiers[0].unitPrice).toBe(
				schedulingTestData.priceTiers.tierForQty25.unitPrice,
			);
		});

		it('should find tier for bulk quantity (100+)', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find tier for quantity 150 (should be the unlimited tier)
			const tiers = await orm
				.withSchema(SCHEMA)
				.select('priceTiers')
				.where(rangeContains('quantityRange', 150))
				.columns(['id', 'productName', 'unitPrice'])
				.execute();

			expect(tiers).toHaveLength(1);
			expect(tiers[0].unitPrice).toBe('69.99'); // Best bulk price
		});
	});

	describe('rangeContainedBy (<@)', () => {
		it('should find bookings fully contained within a date range', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find bookings fully contained within Jan 1 - Jan 31, 2024
			const bookings = await orm
				.withSchema(SCHEMA)
				.select('roomBookings')
				.where(
					rangeContainedBy('bookingPeriod', {
						lower: '2024-01-01',
						upper: '2024-02-01',
					}),
				)
				.columns(['id', 'bookedBy', 'purpose'])
				.execute();

			// All January bookings should be included
			expect(bookings.length).toBe(
				schedulingTestData.bookings.containedInJan.length,
			);
		});

		it('should find events fully contained within a time window', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find events fully within Jan 15, 2024 08:00-18:00 UTC
			const events = await orm
				.withSchema(SCHEMA)
				.select('events')
				.where(
					rangeContainedBy('timeSlot', {
						lower: '2024-01-15 08:00:00+00',
						upper: '2024-01-15 18:00:00+00',
					}),
				)
				.columns(['id', 'title'])
				.execute();

			// Should find all Jan 15 events
			const titles = events.map((e: { title: string }) => e.title);
			for (const expected of schedulingTestData.events.onJan15) {
				expect(titles).toContain(expected);
			}
		});
	});

	describe('Range with relations', () => {
		it('should find rooms with overlapping bookings', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// Find rooms that have bookings overlapping Jan 15-20
			const rooms = await orm
				.withSchema(SCHEMA)
				.select('rooms')
				.include('bookings', {
					where: rangeOverlaps('bookingPeriod', {
						lower: '2024-01-15',
						upper: '2024-01-20',
					}),
				})
				.columns(['id', 'name'])
				.execute();

			// Should find rooms with matching bookings
			expect(rooms.length).toBeGreaterThan(0);
		});
	});

	describe('Edge cases', () => {
		it('should handle unbounded ranges', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// The [100,) tier has no upper bound
			const tiers = await orm
				.withSchema(SCHEMA)
				.select('priceTiers')
				.where(rangeContains('quantityRange', 500))
				.columns(['id', 'unitPrice'])
				.execute();

			expect(tiers).toHaveLength(1);
			expect(tiers[0].unitPrice).toBe('69.99');
		});

		it('should return empty for non-overlapping range', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: schedulingModel, adapter });

			// No bookings in December 2023
			const bookings = await orm
				.withSchema(SCHEMA)
				.select('roomBookings')
				.where(
					rangeOverlaps('bookingPeriod', {
						lower: '2023-12-01',
						upper: '2023-12-31',
					}),
				)
				.execute();

			expect(bookings).toHaveLength(0);
		});
	});
});
