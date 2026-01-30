/**
 * IAM/RBAC Schema DDL
 *
 * Creates tables for users, roles, permissions, and their relationships.
 * Used for testing recursive CTE queries (role hierarchy traversal).
 */

import type pg from 'pg';
import { sql } from './sql.js';

/**
 * Create IAM schema tables in the specified schema.
 */
export async function createIamSchema(
	pool: pg.Pool,
	schemaName: string,
): Promise<void> {
	const s = sql.ref(schemaName);

	// Set search path
	await sql`SET search_path TO ${s}`.execute(pool);

	// Users table
	await sql`
		CREATE TABLE users (
			id SERIAL PRIMARY KEY,
			username VARCHAR(100) UNIQUE NOT NULL,
			email VARCHAR(255) NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`.execute(pool);

	// Roles table
	await sql`
		CREATE TABLE roles (
			id SERIAL PRIMARY KEY,
			name VARCHAR(100) UNIQUE NOT NULL,
			description TEXT
		)
	`.execute(pool);

	// Permissions table
	await sql`
		CREATE TABLE permissions (
			id SERIAL PRIMARY KEY,
			name VARCHAR(100) UNIQUE NOT NULL,
			description TEXT
		)
	`.execute(pool);

	// User-Role junction (many-to-many)
	await sql`
		CREATE TABLE user_roles (
			user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
			role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY (user_id, role_id)
		)
	`.execute(pool);

	// Role-Permission junction (many-to-many)
	await sql`
		CREATE TABLE role_permissions (
			role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
			PRIMARY KEY (role_id, permission_id)
		)
	`.execute(pool);

	// Role hierarchy edges (edge-table for recursive CTE)
	await sql`
		CREATE TABLE role_edges (
			id SERIAL PRIMARY KEY,
			parent_role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			child_role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			UNIQUE (parent_role_id, child_role_id)
		)
	`.execute(pool);

	// Separation of Duty rules (incompatible role pairs)
	await sql`
		CREATE TABLE sod_rules (
			id SERIAL PRIMARY KEY,
			role_a_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			role_b_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
			reason TEXT NOT NULL,
			UNIQUE (role_a_id, role_b_id)
		)
	`.execute(pool);

	// Reset search path
	await sql`SET search_path TO public`.execute(pool);
}

/**
 * Drop IAM schema tables.
 */
export async function dropIamSchema(
	pool: pg.Pool,
	schemaName: string,
): Promise<void> {
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
