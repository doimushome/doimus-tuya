"use strict";

const mqtt = require("mqtt");
const crypto = require("crypto");
const { crc32 } = require("../shared/crc32");

// Smart Life-compatible CRC32 wake loop: publish the CRC32 of the device's
// local_key to m/w/{devId} once per second for ~10s. Battery cameras keep a
// low-power MQTT session to the IPC broker and boot when they receive this.
const WAKE_REPEAT_INTERVAL_MS = 1000;
const WAKE_REPEAT_DURATION_MS = 10000;

/**
 * Wake a battery camera (sp / doorbell / peephole) by connecting to the IPC
 * MQTT broker and publishing the CRC32 wake loop. Standalone — used by the
 * P2P live-view path, which does not go through WebRTC signaling.
 */
async function wakeBatteryCamera(tuyaDevice, ctx, log) {
  const api = ctx.deviceManager && ctx.deviceManager.api;
  if (!api || !api.tokenInfo || !api.tokenInfo.uid) {
    log(
      "warn",
      `[Wake] No API/UID available — cannot wake "${tuyaDevice.name}"`,
    );
    return;
  }
  const uid = api.tokenInfo.uid;
  const deviceId = tuyaDevice.id;
  const localKey = tuyaDevice.local_key;
  if (!localKey) {
    log("warn", `[Wake] No local_key for "${tuyaDevice.name}" — cannot wake`);
    return;
  }

  let mqRes;
  try {
    mqRes = await api.post("/v2.0/open-iot-hub/access/config", {
      uid,
      unique_id: crypto.randomUUID(),
      link_type: "mqtt",
      topics: "ipc",
    });
  } catch (e) {
    log(
      "warn",
      `[Wake] IPC MQTT config fetch failed for "${tuyaDevice.name}": ${e.message}`,
    );
    return;
  }
  if (!mqRes || !mqRes.success || !mqRes.result) {
    log(
      "warn",
      `[Wake] IPC MQTT config unavailable for "${tuyaDevice.name}" (code=${mqRes?.code})`,
    );
    return;
  }

  const { url, client_id, username, password } = mqRes.result;
  const crc = crc32(localKey);
  const wakePayload = Buffer.alloc(4);
  wakePayload.writeUInt32BE(crc, 0);
  const topic = `m/w/${deviceId}`;

  const client = mqtt.connect(url, {
    clientId: client_id,
    username,
    password,
    keepalive: 30,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try {
      client.end(true);
    } catch (_) { /* already closed */ }
  };

  client.on("connect", () => {
    log(
      "info",
      `[Wake] IPC MQTT connected — wake loop on ${topic} (crc=${crc.toString(16)}, every ${WAKE_REPEAT_INTERVAL_MS}ms for ${WAKE_REPEAT_DURATION_MS}ms)`,
    );
    const send = () => {
      if (done) return;
      client.publish(topic, wakePayload, { qos: 0 }, (err) => {
        if (err) {
          log("warn", `[Wake] publish failed to ${topic}: ${err.message || err}`);
        }
      });
    };
    send();
    let ticks = 0;
    const iv = setInterval(() => {
      ticks++;
      if (ticks >= WAKE_REPEAT_DURATION_MS / WAKE_REPEAT_INTERVAL_MS) {
        clearInterval(iv);
        log("info", "[Wake] Wake loop finished");
        finish();
      } else {
        send();
      }
    }, WAKE_REPEAT_INTERVAL_MS);
  });

  client.on("error", (err) => {
    log("debug", `[Wake] IPC MQTT error: ${err.message}`);
  });

  // Hard stop after the wake window regardless of MQTT state.
  const stopTimer = setTimeout(finish, WAKE_REPEAT_DURATION_MS + 2000);
  if (stopTimer.unref) stopTimer.unref();
}

/**
 * Best-effort cloud-delivered wake, mirroring the Smart Life app's
 * `m.thing.device.common.issue` ATOP call. The direct MQTT publish to
 * m/w/{devId} works when the camera's low-power session is on the same
 * broker; some battery cameras only wake via the cloud's privileged channel,
 * so also deliver the CRC32 message through the cloud. Non-fatal — failures
 * are logged at debug and never block the normal wake path.
 */
async function cloudWakeBatteryCamera(tuyaDevice, ctx, log) {
  const api = ctx.deviceManager && ctx.deviceManager.api;
  if (!api || !api.tokenInfo || !api.tokenInfo.uid) {
    log(
      "debug",
      `[Wake] cloud wake skipped — no API/UID for "${tuyaDevice.name}"`,
    );
    return;
  }
  const deviceId = tuyaDevice.id;
  const localKey = tuyaDevice.local_key;
  if (!localKey) {
    log("debug", `[Wake] cloud wake skipped — no local_key for "${tuyaDevice.name}"`);
    return;
  }

  const crc = crc32(localKey);
  const crcBytes = Buffer.alloc(4);
  crcBytes.writeUInt32BE(crc, 0);
  const topic = `m/w/${deviceId}`;
  const opts = { suppressErrorLog: true };

  // Diagnostic: poll the camera's low-power connect state (the app's
  // checkAwakeStatus). Tells us whether the camera's low-power channel is up.
  try {
    const check = await api.request(
      "post",
      "/?a=m.thing.device.low.power.connect.batch.get&v=1.0&sp=1",
      null,
      { devIds: [deviceId] },
      opts,
    );
    log(
      "info",
      `[Wake] checkAwakeStatus ${deviceId} -> ${JSON.stringify(check).slice(0, 400)}`,
    );
  } catch (e) {
    log("debug", `[Wake] checkAwakeStatus failed: ${e.message}`);
  }

  // Deliver the CRC32 wake via the cloud (common.issue).
  try {
    const res = await api.request(
      "post",
      "/?a=m.thing.device.common.issue&v=1.0&sp=1",
      null,
      {
        devId: deviceId,
        topic,
        message: crcBytes.toString("base64"),
      },
      opts,
    );
    log(
      "info",
      `[Wake] cloud common.issue ${deviceId} -> code=${res && res.code} success=${res && res.success} msg=${res && res.msg}`,
    );
  } catch (e) {
    log("debug", `[Wake] cloud common.issue failed: ${e.message}`);
  }
}

module.exports = { wakeBatteryCamera, cloudWakeBatteryCamera };
