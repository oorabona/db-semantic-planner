export type ConnectionTransport = 'tls' | 'plaintext' | 'fallback-plaintext';

export type ConnectionTestResult =
	| { ok: true; message: string; transport: ConnectionTransport }
	| { ok: false; message: string };

export function transportLabel(transport: ConnectionTransport): string {
	switch (transport) {
		case 'tls':
			return 'TLS';
		case 'plaintext':
			return 'Plaintext';
		case 'fallback-plaintext':
			return 'Plaintext fallback';
	}
}
