#!/usr/bin/env bash
# Build the Node.js SEA (Single Executable Application) sidecar binary.
# Must run on each target platform — SEA cannot cross-compile.
#
# Usage: ./scripts/build-sidecar.sh [--output <path>]
# Default output: src-tauri/binaries/dbsp-sidecar-<target-triple>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="$GUI_DIR/sidecar"
OUTPUT_DIR="$GUI_DIR/src-tauri/binaries"

# ─── Detect target triple ───────────────────────────────────────────
detect_target_triple() {
  local os arch triple
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)  os="unknown-linux-gnu" ;;
    Darwin) os="apple-darwin" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) os="pc-windows-msvc" ;;
    *) echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
  esac

  triple="${arch}-${os}"
  echo "$triple"
}

TARGET_TRIPLE="$(detect_target_triple)"

# Parse args
CUSTOM_OUTPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) CUSTOM_OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

BINARY_NAME="dbsp-sidecar-${TARGET_TRIPLE}"
if [[ "$TARGET_TRIPLE" == *"windows"* ]]; then
  BINARY_NAME="${BINARY_NAME}.exe"
fi

if [[ -n "$CUSTOM_OUTPUT" ]]; then
  OUTPUT_PATH="$CUSTOM_OUTPUT"
else
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_PATH="${OUTPUT_DIR}/${BINARY_NAME}"
fi

echo "Building sidecar for: ${TARGET_TRIPLE}"
echo "Output: ${OUTPUT_PATH}"

# ─── Step 1: Bundle with esbuild ────────────────────────────────────
BUNDLE_DIR="$GUI_DIR/.sidecar-build"
mkdir -p "$BUNDLE_DIR"

echo "→ Bundling sidecar with esbuild..."
npx esbuild "$SIDECAR_DIR/index.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="$BUNDLE_DIR/sidecar.cjs" \
  --external:pg-native \
  --sourcemap=inline

# ─── Step 2: Create SEA config ──────────────────────────────────────
SEA_CONFIG="$BUNDLE_DIR/sea-config.json"
cat > "$SEA_CONFIG" <<EOF
{
  "main": "$BUNDLE_DIR/sidecar.cjs",
  "output": "$BUNDLE_DIR/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
EOF

# ─── Step 3: Generate SEA blob ──────────────────────────────────────
echo "→ Generating SEA blob..."
node --experimental-sea-config "$SEA_CONFIG"

# ─── Step 4: Copy node binary and inject blob ───────────────────────
NODE_BIN="$(command -v node)"
echo "→ Copying Node.js binary from: ${NODE_BIN}"
cp "$NODE_BIN" "$OUTPUT_PATH"

# Remove code signature on macOS before injection
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "→ Removing code signature for injection..."
  codesign --remove-signature "$OUTPUT_PATH"
fi

echo "→ Injecting SEA blob..."
npx postject "$OUTPUT_PATH" NODE_SEA_BLOB "$BUNDLE_DIR/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Re-sign on macOS after injection
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "→ Re-signing binary (ad-hoc)..."
  codesign --sign - "$OUTPUT_PATH"
fi

# ─── Step 5: Verify ─────────────────────────────────────────────────
echo "→ Verifying sidecar..."
if "$OUTPUT_PATH" --version 2>/dev/null; then
  echo "✅ Sidecar built successfully: ${OUTPUT_PATH}"
else
  echo "⚠️  Sidecar built but --version check didn't produce output (may be expected for JSON-RPC stdin mode)"
  echo "✅ Sidecar binary created: ${OUTPUT_PATH}"
fi

# ─── Cleanup ─────────────────────────────────────────────────────────
rm -rf "$BUNDLE_DIR"

echo "Done."
