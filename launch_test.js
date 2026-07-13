#!/usr/bin/env node
// Launcher: spawns the test detached, writes PID, exits immediately
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = '/tmp/doimus_webrtc_test';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'running.txt'), String(process.pid));

const child = spawn('node', ['test/webrtc-self-test.js'], {
  cwd: '/Users/matteocrippa/Repositories/Personal/doimus-tuya',
  env: {
    ...process.env,
    HUB: '192.168.1.55:8765',
    JWT: fs.readFileSync('/tmp/jwt.txt', 'utf8').trim(),
    DEVICE: 'a5f8b13f-3100-598e-8e27-0f8ba233022f',
    DEBUG: 'full'
  },
  stdio: [
    'ignore',
    fs.openSync(path.join(dir, 'test_output.txt'), 'w'),
    fs.openSync(path.join(dir, 'test_output.txt'), 'a')
  ],
  detached: true
});

child.unref();
fs.writeFileSync(path.join(dir, 'child_pid.txt'), String(child.pid));
console.log('spawned:' + child.pid);
