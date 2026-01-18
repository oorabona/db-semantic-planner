/**
 * IAM/RBAC Schema DDL
 *
 * Creates tables for users, roles, permissions, and their relationships.
 * Used for testing recursive CTE queries (role hierarchy traversal).
 */

import { type Kysely, sql } from 'kysely';

/**
 * Create IAM schema tables in the specified schema.
 */
export async function createIamSchema(
	db: Kysely<unknown>,
	schemaName: string,
): Promise<void> {
	// Set search path
	await sql`SET search_path TO ${sql.ref(schemaName)}`.execute(db);

	// Users table
	await sql`
		CREATE TABLE users (
			id SERIAL PRIMARY KEY,
			username VARCHAR(100) UNIQUE NOT NULL,
			email VARCHAR(255) NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`.execute(db);

	// Roles table
	await sql`
		CREATE TABLE roles (
			id SERIAL PRIMARY KEY,
			name VARCHAR(100) UNIQUE NOT NULL,
			description TEXT
		)
	`.execute(db);

	// Permissions table
	await sql`
		CREATE TABLE permissions (
			id SERIAL PRIMARY KEY,
			name VARCHAR(100) UNIQUE NOT NULL,
			description TEXT
		)
	`.execute(db);

	// User-Role junction (many-to-many)
	await sql`
		CREATE TABLE user_roles (
			user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
			role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (user_id, role_id)
		)
	`.execute(db);

	// Role-Permission junction (many-to-many)
	await sql`
		CREATE TABLE role_permissions (
			role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
			PRIMARY KEY (role_id, permission_id)
		)
	`.execute(db);

	// Role hierarchy edges (edge-table for recursive CTE)
	await sql`
		CREATE TABLE role_edges (
			id SERIAL PRIMARY KEY,
			parent_role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			child_role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			UNIQUE (parent_role_id, child_role_id)
		)
	`.execute(db);

	// Separation of Duty rules (incompatible role pairs)
	await sql`
		CREATE TABLE sod_rules (
			id SERIAL PRIMARY KEY,
			role_a_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			role_b_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			reason TEXT NOT NULL,
			UNIQUE (role_a_id, role_b_id)
		)
	`.execute(db);

	// Reset search path
	await sql`SET search_path TO public`.execute(db);
}

/**
 * Drop IAM schema tables.
 */
export async function dropIamSchema(
	db: Kysely<unknown>,
	schemaName: string,
): Promise<void> {
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(db);
}
