/**
 * FR-3: BatchValues tests.
 * Assertions match actual pgsql-deparser output:
 *   - CAST($N AS type[]) form (not $N::type[] shorthand)
 *   - Identifiers unquoted for simple names
 *   - int4 for integer, text for text
 */

import { batchValues, createOrm, schema } from "@dbsp/core";
import type { WhereComparisonIntent } from "@dbsp/types";
import { describe, expect, it } from "vitest";
import { createPgsqlCompileOnlyAdapter } from "../pgsql-adapter.js";

const testSchema = schema({
	calls: {
		id: { type: "integer", primaryKey: true },
		callee_id: { type: "integer" },
	},
	files: {
		id: { type: "integer", primaryKey: true },
		path: { type: "text" },
		name: { type: "text" },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

describe("FR-3: batchValues()", () => {
	it("T1: SELECT FROM unnest batch — basic", () => {
		const orm = buildOrm();
		const batch = batchValues(
			[["/a", "/b"], ["a.ts", "b.ts"]],
			["path", "name"],
			["text", "text"],
			{ alias: "requested" },
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain("FROM unnest(CAST($1 AS text[]), CAST($2 AS text[])) AS requested(path, name)");
		expect(dump.params[0]).toEqual(["/a", "/b"]);
		expect(dump.params[1]).toEqual(["a.ts", "b.ts"]);
	});

	it("T2: WITH ORDINALITY adds ord column", () => {
		const orm = buildOrm();
		const batch = batchValues(
			[["/a", "/b"], ["a.ts", "b.ts"]],
			["path", "name"],
			["text", "text"],
			{ alias: "requested", ordinality: true },
		);
		const dump = (orm as any).from(batch).dump();
		const sql = ws(dump.sql);
		expect(sql).toContain("WITH ORDINALITY AS requested(path, name, ord)");
		expect(dump.params).toEqual([["/a", "/b"], ["a.ts", "b.ts"]]);
	});

	it("T3: batch JOIN — unnest as rarg with explicit ON condition", () => {
		const orm = buildOrm();
		const batch = batchValues(
			[[1, 2, 3], [10, 20, 30]],
			["id", "callee_id"],
			["integer", "integer"],
			{ alias: "batch" },
		);
		const onCond: WhereComparisonIntent = {
			kind: "comparison",
			field: "calls.id",
			operator: "eq",
			value: { kind: "fieldRef", column: "id", scope: "outer" },
		};
		const dump = (orm as any)
			.select("calls")
			.join(batch, { on: onCond, type: "inner" })
			.dump();
		const sql = ws(dump.sql);
		expect(sql).toContain("JOIN unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS batch(id, callee_id)");
		expect(sql).toContain("calls.id = batch.id");
		expect(dump.params[0]).toEqual([1, 2, 3]);
		expect(dump.params[1]).toEqual([10, 20, 30]);
	});

	it("T4: batchValues() returns correct BatchValuesRef shape", () => {
		const batch = batchValues([[1, 2], [10, 20]], ["id", "value"], ["integer", "integer"], { alias: "my_batch", ordinality: false });
		expect(batch.__kind).toBe("batchValues");
		expect(batch.alias).toBe("my_batch");
		expect(batch.columns).toEqual(["id", "value"]);
		expect(batch.types).toEqual(["integer", "integer"]);
		expect(batch.data).toEqual([[1, 2], [10, 20]]);
		expect(batch.ordinality).toBe(false);
	});

	it("T5: batchValues() defaults alias to batch when not specified", () => {
		const batch = batchValues([[1]], ["id"], ["integer"]);
		expect(batch.alias).toBe("batch");
	});
});
