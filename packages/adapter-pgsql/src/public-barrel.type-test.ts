// These execution primitives are deliberately reachable only through the
// internal subpath (or the admitted-operation façade), never the public API.
import type {
	PgCompileOnlyAdapterOptions,
	PgConvergeRefusalChange,
} from '@dbsp/adapter-pgsql';

const compileOnlyOptions: PgCompileOnlyAdapterOptions = {};
void compileOnlyOptions;

const refusalChange: PgConvergeRefusalChange = {
	kind: 'drop_index',
	table: 'users',
	details: 'Drop index users_email_index',
};
void refusalChange;

// @ts-expect-error destructive compatibility bridge is not public
import { executePgDestructiveOutcome } from '@dbsp/adapter-pgsql';

void executePgDestructiveOutcome;

// @ts-expect-error ordinary callers cannot mint a locked run from the package root
import { lockPgJournalRun } from '@dbsp/adapter-pgsql';

void lockPgJournalRun;

// @ts-expect-error recovery primitive is not public
import { recoverPgOutcomeClaim } from '@dbsp/adapter-pgsql';

void recoverPgOutcomeClaim;

// @ts-expect-error raw non-transactional runner is not public
import { runPgNonTransactionalOutcome } from '@dbsp/adapter-pgsql';

void runPgNonTransactionalOutcome;

// @ts-expect-error raw destructive resolution is not public
import { resolvePgDestructiveOutcome } from '@dbsp/adapter-pgsql';

void resolvePgDestructiveOutcome;

// @ts-expect-error raw re-address runner is not public
import { executePgTableReaddress } from '@dbsp/adapter-pgsql';

void executePgTableReaddress;

// @ts-expect-error decision lowering is internal only
import { compilePlan } from '@dbsp/adapter-pgsql';
import { compilePlan as internalCompilePlan } from '@dbsp/adapter-pgsql/internal';

void compilePlan;
void internalCompilePlan;
