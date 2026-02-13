import { describe, expect, it } from 'vitest';

/**
 * Tests for build-sidecar.sh logic — validates target triple detection
 * and binary naming conventions used by Tauri's externalBin resolution.
 */

/** Mirrors the target triple detection from build-sidecar.sh */
function detectTargetTriple(
	os: string,
	arch: string,
): string | null {
	let osPart: string;
	switch (os) {
		case 'Linux':
			osPart = 'unknown-linux-gnu';
			break;
		case 'Darwin':
			osPart = 'apple-darwin';
			break;
		case 'Windows_NT':
		case 'MINGW64_NT':
			osPart = 'pc-windows-msvc';
			break;
		default:
			return null;
	}

	let archPart: string;
	switch (arch) {
		case 'x86_64':
		case 'amd64':
			archPart = 'x86_64';
			break;
		case 'aarch64':
		case 'arm64':
			archPart = 'aarch64';
			break;
		default:
			return null;
	}

	return `${archPart}-${osPart}`;
}

function binaryName(triple: string): string {
	const name = `dbsp-sidecar-${triple}`;
	return triple.includes('windows') ? `${name}.exe` : name;
}

describe('target triple detection', () => {
	it('detects Linux x86_64', () => {
		expect(detectTargetTriple('Linux', 'x86_64')).toBe(
			'x86_64-unknown-linux-gnu',
		);
	});

	it('detects macOS arm64', () => {
		expect(detectTargetTriple('Darwin', 'arm64')).toBe(
			'aarch64-apple-darwin',
		);
	});

	it('detects macOS aarch64', () => {
		expect(detectTargetTriple('Darwin', 'aarch64')).toBe(
			'aarch64-apple-darwin',
		);
	});

	it('detects Windows x86_64', () => {
		expect(detectTargetTriple('Windows_NT', 'amd64')).toBe(
			'x86_64-pc-windows-msvc',
		);
	});

	it('detects MINGW Windows', () => {
		expect(detectTargetTriple('MINGW64_NT', 'x86_64')).toBe(
			'x86_64-pc-windows-msvc',
		);
	});

	it('returns null for unsupported OS', () => {
		expect(detectTargetTriple('FreeBSD', 'x86_64')).toBeNull();
	});

	it('returns null for unsupported arch', () => {
		expect(detectTargetTriple('Linux', 'riscv64')).toBeNull();
	});
});

describe('binary naming', () => {
	it('Linux binary has no extension', () => {
		expect(binaryName('x86_64-unknown-linux-gnu')).toBe(
			'dbsp-sidecar-x86_64-unknown-linux-gnu',
		);
	});

	it('macOS binary has no extension', () => {
		expect(binaryName('aarch64-apple-darwin')).toBe(
			'dbsp-sidecar-aarch64-apple-darwin',
		);
	});

	it('Windows binary has .exe extension', () => {
		expect(binaryName('x86_64-pc-windows-msvc')).toBe(
			'dbsp-sidecar-x86_64-pc-windows-msvc.exe',
		);
	});
});

describe('tauri externalBin convention', () => {
	it('tauri resolves externalBin by appending target triple', () => {
		// Tauri externalBin: ["binaries/dbsp-sidecar"]
		// Tauri appends: -<target-triple>[.exe]
		// Our script produces: dbsp-sidecar-<target-triple>[.exe]
		// These must match.
		const tauriBase = 'binaries/dbsp-sidecar';
		const triple = 'x86_64-unknown-linux-gnu';
		const tauriResolved = `${tauriBase}-${triple}`;
		const ourOutput = `binaries/${binaryName(triple)}`;
		expect(ourOutput).toBe(tauriResolved);
	});

	it('Windows convention includes .exe', () => {
		const tauriBase = 'binaries/dbsp-sidecar';
		const triple = 'x86_64-pc-windows-msvc';
		const tauriResolved = `${tauriBase}-${triple}.exe`;
		const ourOutput = `binaries/${binaryName(triple)}`;
		expect(ourOutput).toBe(tauriResolved);
	});
});
