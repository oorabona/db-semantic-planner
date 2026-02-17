/**
 * UUIDv7 generator — time-sortable UUIDs per RFC 9562.
 *
 * Layout (128 bits):
 *   48-bit unix_ts_ms | 4-bit version (0111) | 12-bit rand_a
 *   2-bit variant (10) | 62-bit rand_b
 *
 * Guarantees lexicographic ordering by creation time while
 * maintaining uniqueness via 74 random bits.
 */
export function uuidv7(): string {
	const now = Date.now();

	// 48-bit timestamp
	const msHex = now.toString(16).padStart(12, '0');

	// Use a DataView for type-safe random access
	const buf = new Uint8Array(10);
	crypto.getRandomValues(buf);
	const view = new DataView(buf.buffer);

	// Bytes 0-1: 12-bit rand_a with version 7 (0b0111_xxxx_xxxx_xxxx)
	const randA = (view.getUint16(0) & 0x0fff) | 0x7000;
	const randAHex = randA.toString(16).padStart(4, '0');

	// Bytes 2-9: 62-bit rand_b with variant 10 (0b10xx_xxxx ...)
	// biome-ignore lint/style/noNonNullAssertion: Uint8Array(10) guarantees index 2 exists
	buf[2] = (buf[2]! & 0x3f) | 0x80;

	const randBHex = Array.from(buf.subarray(2))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	// Format: 8-4-4-4-12
	return `${msHex.slice(0, 8)}-${msHex.slice(8, 12)}-${randAHex}-${randBHex.slice(0, 4)}-${randBHex.slice(4, 16)}`;
}
