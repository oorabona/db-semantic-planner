export type ConnectionTransport = 'tls' | 'plaintext' | 'fallback-plaintext';

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

export function isNonLocalConnectionHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return !(
		normalized === 'localhost' ||
		normalized === '::1' ||
		normalized === '[::1]' ||
		normalized.startsWith('127.') ||
		normalized.startsWith('/')
	);
}
