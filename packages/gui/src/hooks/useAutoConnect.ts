import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useConnectFlow } from '@/hooks/useConnectFlow';
import { useConnectionStore } from '@/stores/connection-store';
import { useProjectStore } from '@/stores/project-store';
import { useSidecarStore } from '@/stores/sidecar-store';

/**
 * Auto-connect on project open when `defaultConnection` is set (F1).
 *
 * Gates (all must be true before attempting):
 * - PRE-01: mode === 'project'
 * - PRE-02: settings.defaultConnection is set
 * - PRE-03: profiles loaded (length > 0)
 * - PRE-04: sidecar status === 'ready'
 * - Not already connected (active === null)
 *
 * PRE-05: Resets on project change (folderPath changes).
 */
export function useAutoConnect() {
	const mode = useProjectStore((s) => s.mode);
	const settings = useProjectStore((s) => s.settings);
	const folderPath = useProjectStore((s) => s.folderPath);
	const profiles = useConnectionStore((s) => s.profiles);
	const active = useConnectionStore((s) => s.active);
	const sidecarStatus = useSidecarStore((s) => s.status);

	const {
		quickConnect,
		promptOpen,
		promptProfile,
		promptError,
		connecting,
		submitPassword,
		cancelPassword,
	} = useConnectFlow();

	const attemptedRef = useRef(false);
	const projectPathRef = useRef<string | null>(null);

	useEffect(() => {
		// PRE-05: Reset attempt flag on project change
		if (folderPath !== projectPathRef.current) {
			attemptedRef.current = false;
			projectPathRef.current = folderPath;
		}

		// Gate checks
		if (attemptedRef.current) return;
		if (mode !== 'project') return;
		if (sidecarStatus !== 'ready') return; // PRE-04
		if (!settings?.defaultConnection) return; // PRE-02
		if (active) return; // Already connected
		if (profiles.length === 0) return; // PRE-03

		const profile = profiles.find((p) => p.name === settings.defaultConnection);
		if (!profile) {
			// ERR-02: Profile not found → toast warning
			toast.warning(
				`Default connection '${settings.defaultConnection}' not found`,
			);
			attemptedRef.current = true;
			return;
		}

		attemptedRef.current = true;
		quickConnect(profile);
	}, [
		mode,
		settings,
		profiles,
		active,
		sidecarStatus,
		folderPath,
		quickConnect,
	]);

	return {
		promptOpen,
		promptProfile,
		promptError,
		connecting,
		submitPassword,
		cancelPassword,
	};
}
