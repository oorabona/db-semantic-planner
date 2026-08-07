import { randomUUID } from 'node:crypto';

export interface SqlQueryable {
	query<Row extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		values?: readonly unknown[],
	): Promise<{ readonly rows: readonly Row[] }>;
}

export interface OneShotInsertFailpointTarget {
	readonly schema: string;
	readonly table: string;
	readonly column: string;
	/** The only INSERT events that may fire this failpoint. */
	readonly value: string | number | boolean | null;
}

export interface OneShotInsertFailpoint {
	readonly name: string;
	readonly message: string;
	readonly target: OneShotInsertFailpointTarget;
	/** True once the trigger has consumed its non-transactional sequence value. */
	hasFired(): Promise<boolean>;
	/** Throws a named error if the test expected a fire that did not occur. */
	assertFired(): Promise<void>;
	/** Remove the trigger, function and sequence after the test. */
	disarm(): Promise<void>;
}

function quoteIdentifier(value: string): string {
	if (value.length === 0)
		throw new Error('E2E failpoint identifiers must not be empty');
	return `"${value.replace(/"/gu, '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replace(/'/gu, "''")}'`;
}

function sqlLiteral(value: OneShotInsertFailpointTarget['value']): string {
	if (value === null) return 'NULL';
	if (typeof value === 'string') return quoteLiteral(value);
	if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
	if (!Number.isFinite(value)) {
		throw new Error('E2E failpoint numeric target values must be finite');
	}
	return String(value);
}

function qualified(schema: string, name: string): string {
	return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

/**
 * Install a server-side, one-shot trigger for one exact inserted column value.
 *
 * The sequence is intentional: nextval is not rolled back when the trigger
 * raises, so the targeted failed INSERT consumes the only firing value. A
 * second matching INSERT reaches the trigger but cannot fire it again. The
 * trigger function is SECURITY DEFINER, so an application role needs INSERT on
 * the target table but not USAGE on this private harness sequence.
 */
export async function armOneShotInsertFailpoint(
	queryable: SqlQueryable,
	target: OneShotInsertFailpointTarget,
): Promise<OneShotInsertFailpoint> {
	const suffix = randomUUID().replace(/-/gu, '').slice(0, 12);
	const name = `dbsp_e2e_failpoint_${suffix}`;
	const sequenceName = `${name}_sequence`;
	const functionName = `${name}_function`;
	const triggerName = `${name}_trigger`;
	const message = `E2E failpoint "${name}" fired`;
	const sequence = qualified(target.schema, sequenceName);
	const functionReference = qualified(target.schema, functionName);
	const tableReference = qualified(target.schema, target.table);

	// A Pool checks out a client for each query. One simple multi-statement query
	// is therefore deliberately used here: PostgreSQL executes it in one implicit
	// transaction without pinning a pooled client or leaving a failed arm behind.
	await queryable.query(`
		CREATE SEQUENCE ${sequence} START WITH 1;
		CREATE FUNCTION ${functionReference}()
		RETURNS trigger
		LANGUAGE plpgsql
		SECURITY DEFINER
		SET search_path = pg_catalog
		AS $dbsp_failpoint$
		BEGIN
			IF nextval(${quoteLiteral(sequence)}::regclass) = 1 THEN
				RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = ${quoteLiteral(message)};
			END IF;
			RETURN NEW;
		END;
		$dbsp_failpoint$;
		CREATE TRIGGER ${quoteIdentifier(triggerName)}
		BEFORE INSERT ON ${tableReference}
		FOR EACH ROW
		WHEN (NEW.${quoteIdentifier(target.column)} IS NOT DISTINCT FROM ${sqlLiteral(target.value)})
		EXECUTE FUNCTION ${functionReference}();
		`);

	const hasFired = async (): Promise<boolean> => {
		const result = await queryable.query<{ is_called: boolean }>(
			`SELECT is_called FROM ${sequence}`,
		);
		return result.rows[0]?.is_called === true;
	};

	return {
		name,
		message,
		target,
		hasFired,
		async assertFired(): Promise<void> {
			if (await hasFired()) return;
			throw new Error(`E2E failpoint "${name}" was armed but did not fire`);
		},
		async disarm(): Promise<void> {
			const failures: unknown[] = [];
			const drops = [
				async (): Promise<void> => {
					await queryable.query(`
					DO $dbsp_failpoint_cleanup$
					BEGIN
						IF to_regclass(${quoteLiteral(tableReference)}) IS NOT NULL THEN
							EXECUTE ${quoteLiteral(`DROP TRIGGER IF EXISTS ${quoteIdentifier(triggerName)} ON ${tableReference}`)};
						END IF;
					END
					$dbsp_failpoint_cleanup$;
					`);
				},
				async (): Promise<void> => {
					await queryable.query(
						`DROP FUNCTION IF EXISTS ${functionReference}()`,
					);
				},
				async (): Promise<void> => {
					await queryable.query(`DROP SEQUENCE IF EXISTS ${sequence}`);
				},
			];
			for (const drop of drops) {
				try {
					await drop();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, 'E2E failpoint cleanup failed');
			}
		},
	};
}
