#!/bin/sh
set -a
. "$(dirname "$0")/.env.test"
set +a
exec node test/webrtc-self-test.js 2>&1 | sed 's/[📹🎉🔍⚠️❌ℹ️📨📋📥📤✅]/./g'
