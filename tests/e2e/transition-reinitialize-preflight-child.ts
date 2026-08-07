import pg from 'pg';
import { writeAdoptionFileAtomically } from '../../packages/cli/src/commands/preflight.js';
import { checkpoint } from './harness/index.js';
import {
	reinitializePreflightChildApplicationName,
	runPreflight,
} from './transition-reinitialize-preflight-testkit.js';

const [schema, out] = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;

if (!schema || !out || !databaseUrl) {
	throw new Error(
		'reinitialize-preflight child requires schema, output path, and DATABASE_URL',
	);
}

const pool = new pg.Pool({
	connectionString: databaseUrl,
	max: 1,
	application_name: reinitializePreflightChildApplicationName(process.pid),
});

void runPreflight([schema], {
	pool,
	declarations: { version: 1, digest: 'e2e-child-empty', declarations: [] },
	observer: async (name) => checkpoint(name),
	writeAdoptionFile: (report) => writeAdoptionFileAtomically(out, report),
})
	.then(async (report) => {
		const failures = report.scopes.filter(
			(scope) => scope.outcome === 'failed',
		);
		if (failures.length > 0) {
			process.stderr.write(
				`reinitialize-preflight child failed scopes: ${JSON.stringify(failures.map(({ ledger, reason }) => ({ ledger, reason })))}\n`,
			);
			throw new Error('reinitialize-preflight child received a failed scope');
		}
	})
	.finally(async () => {
		await pool.end();
	})
	.catch((error: unknown) => {
		process.stderr.write(
			`reinitialize-preflight child failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exitCode = 1;
	});
