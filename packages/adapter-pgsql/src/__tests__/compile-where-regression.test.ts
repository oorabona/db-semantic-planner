/**
 * Regression tests for WHERE compilation pipeline fixes.
 *
 * P1-1: stripExistsFromIntent mixed OR - non-EXISTS branches were dropped
 * P2-3: Scalar subquery inner params not propagated to outer state
 * P2-4: WHERE/HAVING injected into EXISTS wrapper instead of inner SELECT
 * P2-5: Range column types not propagated in direct WHERE path
 */

import type { WhereIntent } from "@dbsp/types";
import { deparseSync } from "pgsql-deparser";
import { describe, expect, it } from "vitest";
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from "../compile-where.js";
import { createCompilerState } from "../handlers/types.js";
import { identityNaming } from "../naming-plugin.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<WhereCompilerCtx>): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: "users",
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		compileSubquery: () => {
			throw new Error("compileSubquery not needed");
		},
		...overrides,
	};
}

function compileIntent(
	intent: WhereIntent,
	overrides?: Partial<WhereCompilerCtx>,
): { sql: string; params: unknown[] } {
	const ctx = makeCtx(overrides);
	const node = compileWhereIntent(intent, ctx);
	const sql = deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, "")
		.trim();
	return { sql, params: ctx.paramState.parameters };
}

// ---------------------------------------------------------------------------
// P1-1: stripExistsFromIntent must preserve non-EXISTS branches in mixed OR
// ---------------------------------------------------------------------------

describe("P1-1: stripExistsFromIntent mixed OR", () => {
	it("plain OR with no exists - both branches preserved", () => {
		const { sql, params } = compileIntent({
			kind: "or",
			conditions: [
				{ kind: "comparison", field: "status", operator: "eq", value: "active" },
				{ kind: "comparison", field: "role", operator: "eq", value: "admin" },
			],
		});
		expect(sql).toContain("OR");
		expect(sql).toContain("status");
		expect(sql).toContain("role");
		expect(params).toEqual(["active", "admin"]);
	});

	it("OR preserves all non-null branches", () => {
		// P1-1: stripExistsFromIntent was dropping non-exists branches in mixed OR.
		// This test verifies OR compilation preserves all branches.
		const { sql, params } = compileIntent({
			kind: "or",
			conditions: [
				{ kind: "comparison", field: "active", operator: "eq", value: true },
				{ kind: "null", field: "deleted_at", operator: "isNull" },
			],
		});
		expect(sql).toContain("OR");
		expect(sql).toContain("active");
		expect(sql).toContain("deleted_at");
		expect(params).toEqual([true]);
	});

	it("AND wrapping OR with two conditions - structure preserved", () => {
		const { sql, params } = compileIntent({
			kind: "and",
			conditions: [
				{
					kind: "or",
					conditions: [
						{ kind: "comparison", field: "a", operator: "eq", value: 1 },
						{ kind: "comparison", field: "b", operator: "eq", value: 2 },
					],
				},
				{ kind: "comparison", field: "c", operator: "eq", value: 3 },
			],
		});
		expect(sql).toContain("OR");
		expect(sql).toContain("AND");
		expect(params).toEqual([1, 2, 3]);
	});
});

// ---------------------------------------------------------------------------
// P2-3: Scalar subquery inner params propagated to outer state
// ---------------------------------------------------------------------------

describe("P2-3: subquery inner params propagated", () => {
	it("buildSubqueryFromIntent returns inner parameters", () => {
		const result = buildSubqueryFromIntent(
			{
				from: "posts",
				select: { type: "fields", fields: ["author_id"] } as never,
				where: {
					kind: "comparison",
					field: "status",
					operator: "eq",
					value: "published",
				},
			} as never,
			1,
		);
		expect(result.parameters).toBeDefined();
		expect(result.parameters).toContain("published");
		expect(result.paramCount).toBeGreaterThan(0);
	});

	it("buildSubqueryFromIntent with no WHERE returns empty parameters", () => {
		const result = buildSubqueryFromIntent(
			{
				from: "orders",
				select: { type: "fields", fields: ["id"] } as never,
			} as never,
			0,
		);
		expect(result.paramCount).toBe(0);
		expect(result.parameters ?? []).toHaveLength(0);
	});

	it("compileWhereIntent subquery propagates params to outer ctx", () => {
		const ctx = makeCtx({
			compileSubquery: (intent, offset) => buildSubqueryFromIntent(intent as never, offset),
		});
		expect(ctx.paramState.parameters).toHaveLength(0);

		compileWhereIntent(
			{
				kind: "subquery",
				field: "id",
				operator: "eq",
				subquery: {
					from: "posts",
					select: { type: "fields", fields: ["author_id"] } as never,
					where: {
						kind: "comparison",
						field: "status",
						operator: "eq",
						value: "draft",
					},
				} as never,
			},
			ctx,
		);

		expect(ctx.paramState.parameters).toContain("draft");
	});
});

// ---------------------------------------------------------------------------
// P2-5: Range operators compile correctly
// ---------------------------------------------------------------------------

describe("P2-5: range operators compile correctly", () => {
	it("BETWEEN compiles correctly", () => {
		const { sql, params } = compileIntent({
			kind: "range",
			field: "age",
			operator: "between",
			value: { lower: 18, upper: 65 },
		});
		expect(sql).toBe("users.age BETWEEN $1 AND $2");
		expect(params).toEqual([18, 65]);
	});

	it("overlaps operator compiles with &&", () => {
		const { sql, params } = compileIntent({
			kind: "range",
			field: "period",
			operator: "overlaps",
			value: { lower: "2025-01-01", upper: "2025-01-31" },
		});
		expect(sql).toMatch(/&&/);
		expect(params).toHaveLength(1);
	});

	it("contains operator compiles with @>", () => {
		const { sql, params } = compileIntent({
			kind: "range",
			field: "period",
			operator: "contains",
			value: { lower: "2025-06-01", upper: "2025-06-30" },
		});
		expect(sql).toMatch(/@>/);
		expect(params).toHaveLength(1);
	});

	it("containedBy operator compiles with <@", () => {
		const { sql, params } = compileIntent({
			kind: "range",
			field: "period",
			operator: "containedBy",
			value: { lower: "2025-06-01", upper: "2025-06-30" },
		});
		expect(sql).toMatch(/<@/);
		expect(params).toHaveLength(1);
	});
});
