/**
 * Transport abstraction for sidecar IPC.
 * stdin/stdout for desktop (Tauri), HTTP/WebSocket for future web.
 */

// ── Types ────────────────────────────────────────────────────────

export type SidecarStatus =
	| 'stopped'
	| 'spawning'
	| 'handshaking'
	| 'ready'
	| 'restarting';

export interface IpcTransport {
	/** Send a JSON-RPC request string to the sidecar. */
	send(message: string): void;

	/** Register a callback for incoming messages (responses + notifications). */
	onMessage(callback: (message: string) => void): void;

	/** Register a callback for transport close/crash. */
	onClose(callback: (code: number | null) => void): void;

	/** Close the transport. */
	close(): void;
}

// ── JSON-RPC client types ────────────────────────────────────────

export interface JsonRpcClientResponse {
	readonly jsonrpc: '2.0';
	readonly id: string | number | null;
	readonly result?: unknown;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data?: unknown;
	};
}

export interface JsonRpcClientNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

// ── Pending request tracking ─────────────────────────────────────

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

// ── IPC Client ───────────────────────────────────────────────────

export class IpcClient {
	private nextId = 1;
	private readonly pending = new Map<string | number, PendingRequest>();
	private readonly notificationHandlers = new Map<
		string,
		(params?: Record<string, unknown>) => void
	>();
	private transport: IpcTransport | null = null;
	private _status: SidecarStatus = 'stopped';
	private readonly statusListeners = new Set<(status: SidecarStatus) => void>();
	private requestQueue: Array<{
		message: string;
		id: number;
		resolve: (v: unknown) => void;
		reject: (e: Error) => void;
	}> = [];

	get status(): SidecarStatus {
		return this._status;
	}

	/** Register a listener for status changes. */
	onStatusChange(listener: (status: SidecarStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	/** Register a handler for notifications (e.g., heartbeat). */
	onNotification(
		method: string,
		handler: (params?: Record<string, unknown>) => void,
	): () => void {
		this.notificationHandlers.set(method, handler);
		return () => this.notificationHandlers.delete(method);
	}

	/** Connect to a transport and perform handshake. */
	async connect(
		transport: IpcTransport,
		version: string,
	): Promise<{ version: string; capabilities: string[] }> {
		this.transport = transport;
		this.setStatus('spawning');

		transport.onMessage((raw) => this.handleMessage(raw));
		transport.onClose((code) => this.handleClose(code));

		this.setStatus('handshaking');

		const result = await this.call<{ version: string; capabilities: string[] }>(
			'handshake',
			{ version },
		);
		this.setStatus('ready');

		// Flush queued requests
		this.flushQueue();

		return result;
	}

	/** Send a JSON-RPC request and return the result. */
	async call<T = unknown>(
		method: string,
		params?: Record<string, unknown> | object,
	): Promise<T> {
		const id = this.nextId++;

		// Queue if not ready (unless it's the handshake itself)
		if (
			this._status !== 'ready' &&
			this._status !== 'handshaking' &&
			method !== 'handshake'
		) {
			return new Promise<T>((resolve, reject) => {
				const message =
					JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
				this.requestQueue.push({
					message,
					id,
					resolve: resolve as (v: unknown) => void,
					reject,
				});
			});
		}

		return this.sendRequest<T>(id, method, params);
	}

	/** Disconnect and clean up. */
	disconnect(): void {
		this.rejectAllPending(new Error('Disconnected'));
		this.transport?.close();
		this.transport = null;
		this.setStatus('stopped');
	}

	// ── Private ──────────────────────────────────────────────────

	private sendRequest<T>(
		id: number,
		method: string,
		params?: Record<string, unknown> | object,
	): Promise<T> {
		if (!this.transport) {
			return Promise.reject(new Error('No transport connected'));
		}

		const message =
			JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request ${id} (${method}) timed out after 30s`));
			}, 30_000);

			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			});

			this.transport!.send(message);
		});
	}

	private handleMessage(raw: string): void {
		const lines = raw.replace(/\r\n/g, '\n').split('\n');
		for (const line of lines) {
			if (line.trim().length === 0) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				console.warn('[IPC] Failed to parse message:', line);
				continue;
			}

			const msg = parsed as Record<string, unknown>;

			// Notification (no id)
			if (!('id' in msg) && typeof msg.method === 'string') {
				const handler = this.notificationHandlers.get(msg.method);
				handler?.(msg.params as Record<string, unknown> | undefined);
				continue;
			}

			// Response (has id)
			const id = msg.id as string | number | null;
			if (id == null) continue;

			const pending = this.pending.get(id);
			if (!pending) continue;

			clearTimeout(pending.timer);
			this.pending.delete(id);

			if ('error' in msg && msg.error) {
				const err = msg.error as { code: number; message: string };
				const error = new Error(err.message);
				(error as Error & { code: number }).code = err.code;
				pending.reject(error);
			} else {
				pending.resolve(msg.result);
			}
		}
	}

	private handleClose(code: number | null): void {
		if (this._status === 'ready') {
			// Unexpected close — restart
			this.setStatus('restarting');
			this.rejectAllPending(new Error('Engine restarting'));
		} else {
			this.setStatus('stopped');
			this.rejectAllPending(new Error('Sidecar stopped'));
		}
	}

	private rejectAllPending(error: Error): void {
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();

		// Also reject queued requests
		for (const queued of this.requestQueue) {
			queued.reject(error);
		}
		this.requestQueue = [];
	}

	private flushQueue(): void {
		const queue = this.requestQueue;
		this.requestQueue = [];
		for (const { message, id, resolve, reject } of queue) {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Queued request ${id} timed out`));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer });
			this.transport?.send(message);
		}
	}

	private setStatus(status: SidecarStatus): void {
		this._status = status;
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}
}
