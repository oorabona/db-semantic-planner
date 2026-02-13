import { useCallback, useEffect } from "react";
import { useConnectionStore } from "@/stores/connection-store";
import { useSchemaStore, type IntrospectionResult } from "@/stores/schema-store";
import { sidecarApi } from "@/lib/ipc";

/**
 * Schema introspection hook.
 * Auto-loads schema when connection becomes active.
 * Provides manual refresh capability.
 */
export function useSchema() {
	const active = useConnectionStore((s) => s.active);
	const status = useConnectionStore((s) => s.status);
	const { schema, loading, error, setSchema, clearSchema, setLoading, setError } =
		useSchemaStore();

	const loadSchema = useCallback(
		async (connectionId: string, schemaName?: string) => {
			setLoading(true);
			try {
				const result = (await sidecarApi.introspect(
					connectionId,
					schemaName,
				)) as IntrospectionResult;
				setSchema(result);
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "Introspection failed";
				setError(message);
			} finally {
				setLoading(false);
			}
		},
		[setSchema, setError, setLoading],
	);

	// Auto-load schema when connection becomes active
	useEffect(() => {
		if (status === "connected" && active) {
			loadSchema(active.connectionId, active.schema);
		} else if (status === "disconnected") {
			clearSchema();
		}
	}, [status, active, loadSchema, clearSchema]);

	const refresh = useCallback(() => {
		if (active) {
			loadSchema(active.connectionId, active.schema);
		}
	}, [active, loadSchema]);

	return {
		schema,
		loading,
		error,
		refresh,
	};
}
