import { describe, expect, it } from 'vitest';
import { rolePoolConfig } from './transition-reinitialize-preflight-testkit.js';

describe('rolePoolConfig', () => {
	it('replaces URL credentials while preserving the connection string transport options', () => {
		const config = rolePoolConfig(
			'postgresql://deployment:source-password@db.example:5433/app?sslmode=require&application_name=x&connect_timeout=7',
			'security role',
			'role/password',
		);
		expect(config.max).toBe(2);
		expect(config.connectionString).toBeTypeOf('string');
		const connection = new URL(config.connectionString!);
		expect(decodeURIComponent(connection.username)).toBe('security role');
		expect(decodeURIComponent(connection.password)).toBe('role/password');
		expect(connection.hostname).toBe('db.example');
		expect(connection.port).toBe('5433');
		expect(connection.pathname).toBe('/app');
		expect(connection.searchParams.get('sslmode')).toBe('require');
		expect(connection.searchParams.get('application_name')).toBe('x');
		expect(connection.searchParams.get('connect_timeout')).toBe('7');
	});

	it('keeps Unix-socket connection options intact', () => {
		const config = rolePoolConfig(
			'postgresql:///app?host=%2Fvar%2Frun%2Fpostgresql&sslmode=require&application_name=x',
			'security_role',
			'role_password',
		);
		const connection = new URL(config.connectionString!);
		expect(connection.hostname).toBe('');
		expect(connection.searchParams.get('host')).toBe('/var/run/postgresql');
		expect(connection.searchParams.get('sslmode')).toBe('require');
		expect(connection.searchParams.get('application_name')).toBe('x');
	});
});
