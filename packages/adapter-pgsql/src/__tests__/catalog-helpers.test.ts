/**
 * Unit tests for catalog helper methods on PgsqlAdapter:
 *   - listIndexes (with namePattern option)
 *   - indexExists
 *   - storageSize
 *
 * Uses a mock pg Pool to avoid requiring a live database.
 */

import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPgsqlAdapter, createPgsqlCompileOnlyAdapter } from "../pgsql-adapter.js";

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

function makeMockPool(rows: Record<string, unknown>[] = []): Pool {
	return {
		query: vi.fn().mockResolvedValue({ rows }),
	} as unknown as Pool;
}

// ===========================================================================
// listIndexes - namePattern filter
// ===========================================================================

describe("PgsqlAdapter.listIndexes()", () => {
	it("queries pg_indexes without LIKE clause when options omitted", async () => {
		const pool = makeMockPool([
			{
				indexname: "idx_users_email",
				indexdef: "CREATE INDEX idx_users_email ON users USING btree (email)",
			},
		]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.listIndexes("users");

		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(sql).not.toContain("LIKE");
		expect(params).toEqual(["users", "public"]);
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("idx_users_email");
		expect(result[0]!.unique).toBe(false);
		expect(result[0]!.method).toBe("btree");
	});

	it("adds LIKE $3 clause when namePattern is provided", async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool);
		await adapter.listIndexes("users", "myschema", { namePattern: "idx_vec%" });

		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(sql).toContain("LIKE $3");
		expect(params).toEqual(["users", "myschema", "idx_vec%"]);
	});

	it("uses adapter schemaName when schema arg is omitted", async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool, { schemaName: "tenant_42" });
		await adapter.listIndexes("orders");

		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(params[1]).toBe("tenant_42");
	});

	it("detects UNIQUE indexes correctly", async () => {
		const pool = makeMockPool([
			{
				indexname: "idx_unique",
				indexdef: "CREATE UNIQUE INDEX idx_unique ON users USING btree (email)",
			},
		]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.listIndexes("users");
		expect(result[0]!.unique).toBe(true);
		expect(result[0]!.method).toBe("btree");
	});
});

// ===========================================================================
// indexExists
// ===========================================================================

describe("PgsqlAdapter.indexExists()", () => {
	it("returns true when EXISTS query returns true", async () => {
		const pool = makeMockPool([{ exists: true }]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.indexExists("idx_users_email", "users");

		expect(result).toBe(true);
		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(sql).toContain("pg_indexes");
		expect(sql).toContain("EXISTS");
		expect(params).toEqual(["idx_users_email", "users", "public"]);
	});

	it("returns false when index does not exist", async () => {
		const pool = makeMockPool([{ exists: false }]);
		const adapter = createPgsqlAdapter(pool);
		expect(await adapter.indexExists("idx_missing", "users")).toBe(false);
	});

	it("uses provided schema in params", async () => {
		const pool = makeMockPool([{ exists: true }]);
		const adapter = createPgsqlAdapter(pool);
		await adapter.indexExists("idx_foo", "users", "tenant_42");

		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(params).toEqual(["idx_foo", "users", "tenant_42"]);
	});

	it("falls back to adapter schemaName when schema arg omitted", async () => {
		const pool = makeMockPool([{ exists: false }]);
		const adapter = createPgsqlAdapter(pool, { schemaName: "myschema" });
		await adapter.indexExists("idx_foo", "orders");

		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(params[2]).toBe("myschema");
	});

	it("returns false when query returns no rows", async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool);
		expect(await adapter.indexExists("idx_ghost", "users")).toBe(false);
	});
});

// ===========================================================================
// storageSize
// ===========================================================================

describe("PgsqlAdapter.storageSize()", () => {
	it("returns the size as a number", async () => {
		const pool = makeMockPool([{ size: "8192" }]);
		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.storageSize("users");

		expect(result).toBe(8192);
		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [sql, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(sql).toContain("pg_total_relation_size");
		expect(sql).toContain("$1::regclass");
		expect(params[0]).toBe('"public"."users"');
	});

	it("uses the provided schema in the qualified identifier param", async () => {
		const pool = makeMockPool([{ size: "4096" }]);
		const adapter = createPgsqlAdapter(pool);
		await adapter.storageSize("orders", "tenant_42");

		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(params[0]).toBe('"tenant_42"."orders"');
	});

	it("falls back to adapter schemaName", async () => {
		const pool = makeMockPool([{ size: "0" }]);
		const adapter = createPgsqlAdapter(pool, { schemaName: "myschema" });
		await adapter.storageSize("logs");

		const querySpy = pool.query as ReturnType<typeof vi.fn>;
		const [, params] = querySpy.mock.calls[0] as [string, unknown[]];
		expect(params[0]).toBe('"myschema"."logs"');
	});

	it("returns 0 when query returns no rows", async () => {
		const pool = makeMockPool([]);
		const adapter = createPgsqlAdapter(pool);
		expect(await adapter.storageSize("empty")).toBe(0);
	});

	it("throws on compile-only adapter", async () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		await expect(adapter.storageSize("users")).rejects.toThrow(
			"compile-only mode",
		);
	});
});
