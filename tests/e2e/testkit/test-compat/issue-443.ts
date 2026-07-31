/** Test-only compatibility boundary for #443. */
import type { QueryBuilder } from '@dbsp/core';

type HydratedRow = { readonly orderId: number; readonly tenantId: number };
type OrdersQuery = QueryBuilder<{
	readonly order_id: number;
	readonly tenant_id: number;
}>;
type AssertAssignable<T extends U, U> = T;
type QueryExecution = ReturnType<OrdersQuery['execute']>;

type CompatibilityCanary = AssertAssignable<
	// @ts-expect-error #443: public row inference exposes DB keys, not ORM-hydrated keys.
	QueryExecution,
	Promise<HydratedRow[]>
>;
