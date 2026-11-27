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
	exists,
	rangeContainedBy,
	rangeContains,
	rangeOverlaps,
	schema,
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
			const purposes = bookings.map((b) => b.purpose);
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
			const titles = events.map((e) => e.title);
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
			const purposes = bookings.map((b) => b.purpose);
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
			expect(tiers[0]!.unitPrice).toBe(
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
			expect(tiers[0]!.unitPrice).toBe('69.99'); // Best bulk price
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
			const titles = events.map((e) => e.title);
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
				.where(
					exists('roomBookings', {
						where: rangeOverlaps('bookingPeriod', {
							lower: '2024-01-15',
							upper: '2024-01-20',
						}),
					}),
				)
				.columns(['id', 'name'])
				.orderBy('id')
				.execute();

			// Team offsite, Interview and Monthly board meetings overlap Jan 15-20.
			expect(rooms.map((room) => room.id)).toEqual([1, 2, 3]);

			// Only the client meeting (room 1) and the monthly board meetings (room 3) overlap Jan 22-25.
			const lateRooms = await orm
				.withSchema(SCHEMA)
				.select('rooms')
				.where(
					exists('roomBookings', {
						where: rangeOverlaps('bookingPeriod', {
							lower: '2024-01-22',
							upper: '2024-01-25',
						}),
					}),
				)
				.columns(['id'])
				.orderBy('id')
				.execute();
			expect(lateRooms.map((room) => room.id)).toEqual([1, 3]);
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
			expect(tiers[0]!.unitPrice).toBe('69.99');
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

	describe('range values compile to the column constructor (ADR 0011 delivery 6, #1047)', () => {
		const D6 = 'range_d6_e2e';
		const d6Db = schema({
			spans: {
				id: { type: 'integer', primaryKey: true },
				span: { type: 'int4range' },
				period: { type: 'daterange' },
			},
		});

		beforeAll(async () => {
			const adapter = await getTestAdapter();
			await adapter.executeRaw(`DROP SCHEMA IF EXISTS ${D6} CASCADE`);
			await adapter.executeRaw(`CREATE SCHEMA ${D6}`);
			await adapter.executeRaw(
				`CREATE TABLE ${D6}.spans (id integer PRIMARY KEY, span int4range, period daterange)`,
			);
			await adapter.executeRaw(
				`INSERT INTO ${D6}.spans (id, span, period) VALUES (1, '[5,6)', '[2024-01-02,2024-01-03)'), (2, '[0,1)', '[2023-12-31,2024-01-01)'), (3, NULL, '[2024-01-01,2024-01-02)')`,
			);
		});

		afterAll(async () => {
			const adapter = await getTestAdapter();
			await adapter.executeRaw(`DROP SCHEMA IF EXISTS ${D6} CASCADE`);
		});

		const ids = async (condition: unknown) => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ schema: d6Db, adapter });
			const rows = await orm
				.withSchema(D6)
				.select('spans')
				.columns(['id'])
				.where(condition as never)
				.orderBy('id')
				.execute();
			return rows.map((row) => row.id);
		};

		it('AC17 bounds honoured on PostgreSQL: closed and half-open ranges select different rows', async () => {
			expect(
				await ids(rangeOverlaps('span', { lower: 1, upper: 5, bounds: '[]' })),
			).toEqual([1]);
			expect(
				await ids(rangeOverlaps('span', { lower: 0, upper: 4, bounds: '(]' })),
			).toEqual([]);
			expect(await ids(rangeOverlaps('span', { lower: 0, upper: 4 }))).toEqual([
				2,
			]);
		});

		it('AC17 Date bound matches the tuple form under a non-UTC time zone', async () => {
			const previous = process.env.TZ;
			process.env.TZ = 'Europe/Paris';
			try {
				const d = new Date('2024-01-01T23:30:00Z');
				expect(
					await ids(rangeOverlaps('period', { lower: d, upper: null })),
				).toEqual([1]);
				expect(await ids(rangeOverlaps('period', [d, null]))).toEqual([1]);
			} finally {
				if (previous === undefined) delete process.env.TZ;
				else process.env.TZ = previous;
			}
		});
	});
});
