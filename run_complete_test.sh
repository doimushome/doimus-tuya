#!/bin/bash
#
# WebRTC Self-Test Runner for Tuya Battery Camera
# Usage: bash run_complete_test.sh
#
# This script:
# 1. Extracts JWT from Docker logs
# 2. Runs the WebRTC self-test (90s)
# 3. Captures filtered Docker logs
# 4. Writes all output to /tmp/doimus_webrtc_test/
#
set -e

OUTDIR=/tmp/doimus_webrtc_test
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

echo "============================================"
echo "  Tuya Battery Camera WebRTC Self-Test"
echo "============================================"
echo ""

# ── Step 1: Extract JWT ──
echo "[1/3] Extracting JWT from Docker logs..."
JWT=$(cd /Users/matteocrippa/Repositories/Personal/doimus-embed && docker compose logs 2>&1 | grep -oE 'eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}' | head -1)

if [ -z "$JWT" ]; then
  echo "  Trying config file..."
  JWT=$(grep -oE 'eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}' ~/.doimus/config.yaml 2>/dev/null | head -1)
fi

if [ -z "$JWT" ]; then
  echo "  ❌ No JWT found. Is Docker running?"
  exit 1
fi
echo "  ✅ JWT found: ${JWT:0:40}..."
echo "$JWT" > "$OUTDIR/jwt.txt"

# ── Step 2: Run WebRTC self-test ──
echo ""
echo "[2/3] Running WebRTC self-test (90s timeout)..."
cd /Users/matteocrippa/Repositories/Personal/doimus-tuya
npm install 2>&1 | tail -3
echo "  Starting test..."
HUB=192.168.1.55:8765 \
JWT="$JWT" \
DEVICE=a5f8b13f-3100-598e-8e27-0f8ba233022f \
DEBUG=full \
timeout 90 node test/webrtc-self-test.js 2>&1 | tee "$OUTDIR/test_output.txt"
TEST_EXIT=${PIPESTATUS[0]}
echo "  Test exit code: $TEST_EXIT"

# ── Step 3: Docker logs ──
echo ""
echo "[3/3] Capturing Docker logs..."
cd /Users/matteocrippa/Repositories/Personal/doimus-embed
docker compose logs --tail=80 2>&1 | grep -iE "(WebRTC|peephole|Sending|wake DP|Wake-up|Camera check|ipc_work|wireless_power)" | tee "$OUTDIR/docker_filtered.txt" || echo "  (no matching log lines)"

echo ""
echo "============================================"
echo "  Test complete! Output saved to:"
echo "  $OUTDIR/test_output.txt"
echo "  $OUTDIR/docker_filtered.txt"
echo "============================================"
