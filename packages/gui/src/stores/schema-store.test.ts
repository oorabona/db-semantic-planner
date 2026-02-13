import { describe, expect, it, beforeEach } from "vitest";
import {
	useSchemaStore,
	getFilteredTables,
	isPrimaryKey,
	isForeignKey,
	getFkTarget,
	type IntrospectionResult,
	type SchemaTable,
} from "./schema-store.js";

const USERS_TABLE: SchemaTable = {
	name: "users",
	columns: [
		{ name: "id", type: "uuid", nullable: false, originalDbType: "uuid" },
		{ name: "name", type: "string", nullable: false, originalDbType: "varchar(255)" },
		{ name: "email", type: "string", nullable: true, originalDbType: "text" },
		{ name: "role_id", type: "uuid", nullable: true, originalDbType: "uuid" },
	],
	primaryKey: "id",
	foreignKeys: [
		{
			columns: ["role_id"],
			references: { table: "roles", columns: ["id"] },
		},
	],
	indexes: [
		{ name: "idx_users_email", columns: ["email"], unique: true },
	],
};

const ROLES_TABLE: SchemaTable = {
	name: "roles",
	columns: [
		{ name: "id", type: "uuid", nullable: false, originalDbType: "uuid" },
		{ name: "name", type: "string", nullable: false, originalDbType: "varchar(100)" },
	],
	primaryKey: "id",
	foreignKeys: [],
	indexes: [],
};

const ORDERS_TABLE: SchemaTable = {
	name: "orders",
	columns: [
		{ name: "id", type: "number", nullable: false, originalDbType: "serial" },
		{ name: "user_id", type: "uuid", nullable: false, originalDbType: "uuid" },
		{ name: "total", type: "number", nullable: false, originalDbType: "numeric(10,2)" },
	],
	primaryKey: "id",
	foreignKeys: [
		{
			columns: ["user_id"],
			references: { table: "users", columns: ["id"] },
		},
	],
	indexes: [],
};

const SCHEMA: IntrospectionResult = {
	tables: [USERS_TABLE, ROLES_TABLE, ORDERS_TABLE],
	relations: [
		{
			name: "users.roles",
			type: "belongsTo",
			source: "users",
			target: "roles",
			cardinality: "one",
		},
		{
			name: "users.orders",
			type: "hasMany",
			source: "users",
			target: "orders",
			cardinality: "many",
		},
	],
	hierarchies: [],
	warnings: ["Table 'legacy_data' has no primary key"],
	introspectedAt: "2026-02-13T12:00:00Z",
};

describe("useSchemaStore", () => {
	beforeEach(() => {
		useSchemaStore.setState({
			schema: null,
			loading: false,
			error: null,
			expanded: new Set(),
			searchFilter: "",
		});
	});

	describe("schema data", () => {
		it("starts with null schema", () => {
			expect(useSchemaStore.getState().schema).toBeNull();
		});

		it("sets schema data", () => {
			useSchemaStore.getState().setSchema(SCHEMA);
			expect(useSchemaStore.getState().schema).toBe(SCHEMA);
			expect(useSchemaStore.getState().error).toBeNull();
		});

		it("clears schema and expanded state", () => {
			useSchemaStore.getState().setSchema(SCHEMA);
			useSchemaStore.getState().toggleExpanded("table:users");
			useSchemaStore.getState().clearSchema();
			expect(useSchemaStore.getState().schema).toBeNull();
			expect(useSchemaStore.getState().expanded.size).toBe(0);
		});
	});

	describe("loading state", () => {
		it("tracks loading", () => {
			useSchemaStore.getState().setLoading(true);
			expect(useSchemaStore.getState().loading).toBe(true);
			useSchemaStore.getState().setLoading(false);
			expect(useSchemaStore.getState().loading).toBe(false);
		});

		it("sets error and stops loading", () => {
			useSchemaStore.getState().setLoading(true);
			useSchemaStore.getState().setError("Connection failed");
			expect(useSchemaStore.getState().error).toBe("Connection failed");
			expect(useSchemaStore.getState().loading).toBe(false);
		});
	});

	describe("expanded state", () => {
		it("toggles expand/collapse", () => {
			useSchemaStore.getState().toggleExpanded("table:users");
			expect(useSchemaStore.getState().expanded.has("table:users")).toBe(true);

			useSchemaStore.getState().toggleExpanded("table:users");
			expect(useSchemaStore.getState().expanded.has("table:users")).toBe(false);
		});

		it("sets expanded explicitly", () => {
			useSchemaStore.getState().setExpanded("table:users", true);
			expect(useSchemaStore.getState().expanded.has("table:users")).toBe(true);

			useSchemaStore.getState().setExpanded("table:users", false);
			expect(useSchemaStore.getState().expanded.has("table:users")).toBe(false);
		});

		it("collapses all", () => {
			useSchemaStore.getState().toggleExpanded("table:users");
			useSchemaStore.getState().toggleExpanded("table:orders");
			useSchemaStore.getState().collapseAll();
			expect(useSchemaStore.getState().expanded.size).toBe(0);
		});
	});

	describe("search filter", () => {
		it("sets filter text", () => {
			useSchemaStore.getState().setSearchFilter("user");
			expect(useSchemaStore.getState().searchFilter).toBe("user");
		});
	});
});

describe("getFilteredTables", () => {
	it("returns empty for null schema", () => {
		expect(getFilteredTables(null, "")).toEqual([]);
	});

	it("returns all tables with empty filter", () => {
		expect(getFilteredTables(SCHEMA, "")).toHaveLength(3);
	});

	it("filters by table name (case-insensitive)", () => {
		const result = getFilteredTables(SCHEMA, "USER");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("users");
	});

	it("matches partial name", () => {
		const result = getFilteredTables(SCHEMA, "or");
		expect(result).toHaveLength(1);
		expect(result[0]!.name).toBe("orders");
	});

	it("returns empty for no match", () => {
		expect(getFilteredTables(SCHEMA, "zzz")).toHaveLength(0);
	});
});

describe("isPrimaryKey", () => {
	it("detects single PK", () => {
		expect(isPrimaryKey(USERS_TABLE, "id")).toBe(true);
		expect(isPrimaryKey(USERS_TABLE, "name")).toBe(false);
	});

	it("handles composite PK", () => {
		const table: SchemaTable = {
			...USERS_TABLE,
			primaryKey: ["id", "name"],
		};
		expect(isPrimaryKey(table, "id")).toBe(true);
		expect(isPrimaryKey(table, "name")).toBe(true);
		expect(isPrimaryKey(table, "email")).toBe(false);
	});

	it("handles no PK", () => {
		const table: SchemaTable = {
			...USERS_TABLE,
			primaryKey: undefined,
		};
		expect(isPrimaryKey(table, "id")).toBe(false);
	});
});

describe("isForeignKey", () => {
	it("detects FK column", () => {
		expect(isForeignKey(USERS_TABLE, "role_id")).toBe(true);
		expect(isForeignKey(USERS_TABLE, "id")).toBe(false);
	});
});

describe("getFkTarget", () => {
	it("returns target for FK column", () => {
		const target = getFkTarget(USERS_TABLE, "role_id");
		expect(target).toEqual({ table: "roles", column: "id" });
	});

	it("returns null for non-FK column", () => {
		expect(getFkTarget(USERS_TABLE, "name")).toBeNull();
	});
});
