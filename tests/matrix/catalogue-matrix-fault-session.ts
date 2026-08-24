type MatrixFaultSessionClient = {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
	release(error?: unknown): void | Promise<void>;
};

/** Inject a present NULL into a live projection without changing its session. */
export function sessionWithPresentNull(
	executor: { connect(): Promise<MatrixFaultSessionClient> },
	field: string,
	isLiveProjection: (sql: string) => boolean,
) {
	let fired = 0;
	return {
		async connect() {
			const client = await executor.connect();
			return {
				async query(sql: string, params?: readonly unknown[]) {
					const result = await client.query(sql, params);
					if (!isLiveProjection(sql)) return { rows: result.rows };
					fired += 1;
					return {
						rows: result.rows.map((row) => ({ ...row, [field]: null })),
					};
				},
				release: (error?: unknown) => client.release(error),
			};
		},
		/** Ensures a test cannot pass merely because its SQL fault hook went stale. */
		assertFiredOnce() {
			if (fired !== 1)
				throw new Error(
					`matrix fault injector for ${field} fired ${fired} times; expected once`,
				);
		},
	};
}
