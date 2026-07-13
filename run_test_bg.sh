#!/bin/sh
set -a
. "$(dirname "$0")/.env.test"
set +a
touch /tmp/doimus_webrtc_test/running.txt
node test/webrtc-self-test.js >/tmp/doimus_webrtc_test/test_output.txt 2>&1
echo $? >/tmp/doimus_webrtc_test/test_exit.txt
rm -f /tmp/doimus_webrtc_test/running.txt
touch /tmp/doimus_webrtc_test/done.txt
