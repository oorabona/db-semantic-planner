// These execution primitives are deliberately reachable only through the
// internal subpath (or the admitted-operation façade), never the public API.
// @ts-expect-error destructive compatibility bridge is not public
import { executePgDestructiveOutcome } from '@dbsp/adapter-pgsql';

void executePgDestructiveOutcome;

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
