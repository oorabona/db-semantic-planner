import type {
	TransitionQueryClient,
	TransitionSessionClient,
} from '@dbsp/types';
import type { Pool } from 'pg';

declare const pool: Pool;

// @ts-expect-error A pool lacks the release() required of a raw acquired lease.
const _poolAsQueryClient: TransitionQueryClient = pool;

// @ts-expect-error Only core can mint an affinity-preserving transition session.
const _poolAsSessionClient: TransitionSessionClient = pool;
