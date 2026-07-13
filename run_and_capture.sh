#!/bin/bash
OUTDIR=/tmp/doimus_webrtc_test
rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

cd /Users/matteocrippa/Repositories/Personal/doimus-tuya
JWT="$(cat /tmp/jwt.txt)"
HUB=192.168.1.55:8765 DEVICE=a5f8b13f-3100-598e-8e27-0f8ba233022f DEBUG=full \
  timeout 90 node test/webrtc-self-test.js \
  > "$OUTDIR/test_output.txt" 2>&1
echo $? > "$OUTDIR/test_exit.txt"

cd /Users/matteocrippa/Repositories/Personal/doimus-embed
docker compose logs --tail=80 2>&1 | cat -v | \
  grep -iE "(WebRTC|peephole|Sending|wake DP|Wake-up|Camera check|ipc_work|wireless_power)" \
  > "$OUTDIR/docker_filtered.txt" 2>&1

echo "DONE" > "$OUTDIR/status.txt"
