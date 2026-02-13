/**
 * Zustand store for sidecar lifecycle state.
 */
import { create } from "zustand";
import type { SidecarStatus } from "@/lib/ipc-transport";

interface SidecarState {
	status: SidecarStatus;
	lastHeartbeat: number | null;
	error: string | null;

	setStatus: (status: SidecarStatus) => void;
	setHeartbeat: () => void;
	setError: (error: string | null) => void;
	reset: () => void;
}

export const useSidecarStore = create<SidecarState>((set) => ({
	status: "stopped",
	lastHeartbeat: null,
	error: null,

	setStatus: (status) => set({ status, error: null }),
	setHeartbeat: () => set({ lastHeartbeat: Date.now() }),
	setError: (error) => set({ error }),
	reset: () => set({ status: "stopped", lastHeartbeat: null, error: null }),
}));
