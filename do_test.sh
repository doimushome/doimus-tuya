#!/bin/sh
JWT=$(cat /tmp/jwt.txt)
HUB=192.168.1.55:8765 DEVICE=a5f8b13f-3100-598e-8e27-0f8ba233022f DEBUG=full timeout 90 node test/webrtc-self-test.js
echo "EXIT:$?"
