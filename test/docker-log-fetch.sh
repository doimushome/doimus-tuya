#!/bin/bash
# ──────────────────────────────────────────────────────────────────────
# Docker Log Fetcher — fetch & correlate logs with automation test runs
#
# Fetches docker logs from the hub and cross-references them with the
# WebRTC automation test output.
#
# Usage:
#   # Fetch logs from local docker
#   bash test/docker-log-fetch.sh
#
#   # Fetch logs from remote hub (SSH)
#   bash test/docker-log-fetch.sh <hub-ip>
#
#   # Fetch logs and correlate with a test run JSON file
#   bash test/docker-log-fetch.sh <hub-ip> webrtc-auto-1234567890.json
#
#   # Just show last N minutes
#   bash test/docker-log-fetch.sh hub.local 10
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

HUB="${1:-192.168.1.55}"
TEST_JSON="${2:-}"
SINCE_MIN="${3:-30}"

echo "══════════════════════════════════════════════════════════════"
echo " Docker Log Fetcher"
echo " Hub: $HUB"
echo " Since: ${SINCE_MIN} min ago"
if [ -n "$TEST_JSON" ]; then
  echo " Cross-ref: $TEST_JSON"
fi
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── Fetch logs ────────────────────────────────────────────────────
LOG_FILE="/tmp/doimus-docker-logs-$(date +%s).txt"

if ping -c1 -W1 "$HUB" &>/dev/null; then
  echo "≡ Fetching docker logs from $HUB (last ${SINCE_MIN} min)..."
  ssh "root@$HUB" \
    "docker compose logs --since=${SINCE_MIN}m 2>/dev/null || docker compose -f /opt/doimus/docker-compose.yml logs --since=${SINCE_MIN}m 2>/dev/null || journalctl -u doimus --since='${SINCE_MIN} minutes ago'" \
    > "$LOG_FILE" 2>/dev/null || {
    # Fallback: fetch from docker on the hub accessible via SSH
    echo "⚠ Could not fetch logs. Trying alternative..."
    ssh "root@$HUB" "docker logs \$(docker ps -q --filter name=backend) --since=${SINCE_MIN}m 2>&1" > "$LOG_FILE" 2>/dev/null || {
      echo "✗ Failed to fetch logs. Is the hub reachable?"
      exit 1
    }
  }
  echo "✓ Logs saved to $LOG_FILE ($(wc -l < "$LOG_FILE") lines)"
else
  echo "╷ Hub $HUB not reachable via SSH. Trying docker compose locally..."
  docker compose logs --since="${SINCE_MIN}m" 2>/dev/null > "$LOG_FILE" || {
    echo "✗ No local docker logs available."
    exit 1
  }
  echo "✓ Local logs saved to $LOG_FILE ($(wc -l < "$LOG_FILE") lines)"
fi

echo ""

# ── Filter for WebRTC/P2P/Stream events ───────────────────────────
echo "≡ WebRTC/P2P/Stream lines:"
grep -iE "webrtc|p2p|stream|wake|offer|answer|motion.*image|timeline.*image" "$LOG_FILE" | \
  head -80 | \
  while IFS= read -r line; do
    echo "  $line"
  done

echo ""
echo "≡ Camera disconnect lines:"
grep -iE "disconnect|camera.*disconnect" "$LOG_FILE" | head -20 | \
  while IFS= read -r line; do
    echo "  $line"
  done

echo ""
echo "≡ Error/Warning lines:"
grep -iE "error|warn|fail|timeout|no.*frame" "$LOG_FILE" | \
  grep -iE "webrtc|p2p|stream|wake|camera" | \
  head -20 | \
  while IFS= read -r line; do
    echo "  $line"
  done

echo ""
echo "≡ ffmpeg lines:"
grep -iE "ffmpeg" "$LOG_FILE" | head -10 | \
  while IFS= read -r line; do
    echo "  $line"
  done

# ── Cross-reference with test JSON ─────────────────────────────────
if [ -n "$TEST_JSON" ] && [ -f "$TEST_JSON" ]; then
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo " Cross-Reference with Test Run"
  echo "══════════════════════════════════════════════════════════════"
  echo ""

  # Extract test timeline from JSON
  START_TIME=$(node -e "
    const r = require('./$TEST_JSON');
    const start = r.events[0]?.ts;
    const end = r.events[r.events.length-1]?.ts;
    console.log(start + '|' + end);
  " 2>/dev/null || echo "|")

  TEST_START=$(echo "$START_TIME" | cut -d'|' -f1)
  TEST_END=$(echo "$START_TIME" | cut -d'|' -f2)

  if [ -n "$TEST_START" ] && [ -n "$TEST_END" ]; then
    # Convert ISO timestamps to Unix
    START_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${TEST_START%.*}" +%s 2>/dev/null || true)
    END_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${TEST_END%.*}" +%s 2>/dev/null || true)

    if [ -n "$START_EPOCH" ] && [ -n "$END_EPOCH" ]; then
      START_HUMAN=$(date -r "$START_EPOCH" "+%H:%M:%S" 2>/dev/null)
      END_HUMAN=$(date -r "$END_EPOCH" "+%H:%M:%S" 2>/dev/null)

      echo " Test ran from $START_HUMAN to $END_HUMAN"
      echo ""

      # Extract docker logs in that time window
      LOG_START=$(grep -n "T${START_HUMAN}" "$LOG_FILE" | head -1 | cut -d: -f1 || echo "")
      LOG_END=$(grep -n "T${END_HUMAN}" "$LOG_FILE" | tail -1 | cut -d: -f1 || echo "")

      if [ -n "$LOG_START" ] && [ -n "$LOG_END" ]; then
        echo " Docker log lines $LOG_START to $LOG_END:"
        sed -n "${LOG_START},${LOG_END}p" "$LOG_FILE" | \
          grep -iE "webrtc|p2p|stream|wake|offer|answer|disconnect|error|warn|ffmpeg" | \
          head -40
      else
        echo " (Could not find matching time window in docker logs)"
      fi
    fi
  fi

  # Print test summary
  echo ""
  node -e "
    const r = require('./$TEST_JSON');
    console.log(' Test summary:');
    console.log('   Attempts: ' + r.attempts);
    console.log('   wrtc: ' + r.wrtc);
    console.log('   Strategy: ' + r.strategy);

    const answers = r.events.filter(e => e.msg.includes('ANSWER RECEIVED'));
    const disconnects = r.events.filter(e => e.msg.includes('Camera disconnected'));
    const timeouts = r.events.filter(e => e.msg.includes('No response within timeout'));

    console.log('   Answers: ' + answers.length);
    console.log('   Disconnects: ' + disconnects.length);
    console.log('   Timeouts: ' + timeouts.length);

    // Show plugin key events
    const pluginEvents = r.pluginLogs
      .filter(e => /webrtc|p2p|stream|wake|offer|answer|disconnect/i.test(e.message))
      .slice(-15);
    if (pluginEvents.length > 0) {
      console.log('');
      console.log(' Last plugin events:');
      const base = new Date(pluginEvents[0].ts).getTime();
      for (const e of pluginEvents) {
        const t = ((new Date(e.ts).getTime() - base) / 1000).toFixed(1);
        console.log('   T+' + t.padStart(6) + 's  ' + e.message.slice(0, 130));
      }
    }
  "
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Done. Raw logs: $LOG_FILE"
echo "══════════════════════════════════════════════════════════════"
