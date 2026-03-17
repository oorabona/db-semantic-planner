import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useConnection } from '@/hooks/useConnection';
import { isAuthError } from '@/lib/connect-utils';
import type { ConnectionProfile } from '@/stores/connection-store';

// F-004 / INV-06: module-level guard — single in-flight connect across all surfaces
let globalConnecting = false;

interface ConnectFlowState {
	promptOpen: boolean;
	promptProfile: ConnectionProfile | null;
	promptError: string | null;
	connecting: boolean;
}

const INITIAL_STATE: ConnectFlowState = {
	promptOpen: false,
	promptProfile: null,
	promptError: null,
	connecting: false,
};

/**
 * Shared connect-with-prompt flow (INV-06: single in-flight connect).
 *
 * 1. Attempt connection without password
 * 2. Auth failure → open PasswordPrompt
 * 3. Non-auth failure → toast error
 * 4. Password submitted → retry with password
 *
 * Consumed by: useAutoConnect, SidebarConnectionPanel, ConnectionQuickPick.
 */
export function useConnectFlow() {
	const { connectFromProfile, disconnect } = useConnection();
	const [state, setState] = useState<ConnectFlowState>(INITIAL_STATE);

	const quickConnect = useCallback(
		async (profile: ConnectionProfile) => {
			if (globalConnecting) return;
			globalConnecting = true;
			setState((s) => ({ ...s, connecting: true }));

			try {
				// INV-06: disconnect current before new connect
				await disconnect().catch(() => {});
				// Attempt without password
				await connectFromProfile(profile, '');
				setState(INITIAL_STATE);
			} catch (err) {
				if (isAuthError(err)) {
					// Auth failure → show password prompt (ERR-01/ERR-03)
					setState({
						promptOpen: true,
						promptProfile: profile,
						promptError: null,
						connecting: false,
					});
				} else {
					// Non-auth failure → toast error (ERR-07)
					toast.error(`Connection failed: ${String(err)}`);
					setState(INITIAL_STATE);
				}
			} finally {
				globalConnecting = false;
			}
		},
		[connectFromProfile, disconnect],
	);

	const submitPassword = useCallback(
		async (password: string) => {
			const profile = state.promptProfile;
			if (!profile) return;

			setState((s) => ({ ...s, connecting: true, promptError: null }));
			try {
				await connectFromProfile(profile, password);
				setState(INITIAL_STATE);
			} catch (err) {
				setState((s) => ({
					...s,
					promptError: String(err),
					connecting: false,
				}));
			}
		},
		[state.promptProfile, connectFromProfile],
	);

	const cancelPassword = useCallback(() => {
		setState(INITIAL_STATE);
	}, []);

	return {
		quickConnect,
		submitPassword,
		cancelPassword,
		promptOpen: state.promptOpen,
		promptProfile: state.promptProfile,
		promptError: state.promptError,
		connecting: state.connecting,
	};
}
