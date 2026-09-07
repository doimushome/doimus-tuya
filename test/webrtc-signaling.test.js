"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Fake MQTT client
// ---------------------------------------------------------------------------

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = [];
    this.publications = [];
    this.ended = false;
    this.connected = false;
  }

  emit(event, ...args) {
    if (event === "connect") this.connected = true;
    return super.emit(event, ...args);
  }

  subscribe(topic, cb) {
    this.subscriptions.push(topic);
    if (cb) cb(null);
  }

  publish(topic, payload, opts, cb) {
    let actualCb = cb;
    let qos = 0;
    if (typeof opts === "function") {
      actualCb = opts;
    } else if (opts && typeof opts === "object") {
      qos = opts.qos || 0;
    }
    this.publications.push({ topic, payload: String(payload), qos });
    if (actualCb) actualCb(null);
  }

  end() {
    this.ended = true;
  }

  receive(topic, payload) {
    this.emit(
      "message",
      topic,
      Buffer.from(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      ),
    );
  }
}

function withMockedDeps({ mqttMock, uuidValues }, fn) {
  const originalLoad = Module._load;
  const uuids = Array.isArray(uuidValues) ? [...uuidValues] : ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  Module._load = function patched(request, parent, isMain) {
    if (request === "mqtt") return mqttMock;
    if (request === "uuid") {
      return {
        v4: () => (uuids.length === 0 ? "ffffffff-ffff-ffff-ffff-ffffffffffff" : uuids.shift()),
      };
    }
    return originalLoad.apply(this, arguments);
  };
  const modPath = path.resolve(__dirname, "../src/camera/WebRTCSignaling.js");
  delete require.cache[modPath];
  try {
    const WebRTCSignaling = require(modPath);
    return fn(WebRTCSignaling);
  } finally {
    delete require.cache[modPath];
    Module._load = originalLoad;
  }
}

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:turn.example.com:3478", username: "user", credential: "pass" },
];

function makeApiMock() {
  return {
    tokenInfo: { uid: "uid-1" },
    get: async () => ({
      success: true,
      result: {
        supports_webrtc: true,
        auth: "auth-token-base64==",
        moto_id: "moto-123",
        local_key: "",
        p2p_config: { ices: ICE_SERVERS },
      },
    }),
    post: async () => ({
      success: true,
      result: {
        url: "mqtt://example",
        client_id: "cid-1",
        username: "u",
        password: "p",
        expire_time: 7200,
        source_topic: { ipc: "/av/u/clientX" },
        sink_topic: { ipc: "/av/moto/moto_id/u/{device_id}" },
      },
    }),
  };
}

function makeLogger() {
  const lines = [];
  return { lines, log: (level, msg) => lines.push({ level, msg: String(msg) }) };
}

function setup(WebRTCSignaling) {
  const fakeClient = new FakeMqttClient();
  const api = makeApiMock();
  const logger = makeLogger();
  const wr = new WebRTCSignaling(api, logger.log.bind(logger));
  return { fakeClient, api, logger, wr };
}

function offerPubs(client) {
  return client.publications.filter((p) => {
    try {
      return JSON.parse(p.payload)?.data?.header?.type === "offer";
    } catch {
      return false;
    }
  });
}

async function startSession(WebRTCSignaling) {
  const { fakeClient, wr } = setup(WebRTCSignaling);
  let configEvent = null;
  wr.on("config", (cfg) => (configEvent = cfg));
  await wr.start("dev-123", "00112233445566778899aabbccddeeff");
  return { fakeClient, wr, configEvent };
}

// ---------------------------------------------------------------------------

test("start emits config and subscribes to the source topic", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps({ mqttMock: { connect: () => fakeClient } }, async (WebRTCSignaling) => {
    const { wr, configEvent } = await startSession(WebRTCSignaling);
    t.after(() => wr.disconnect());
    fakeClient.emit("connect");
    assert.ok(configEvent, "config event must fire");
    assert.equal(configEvent.motoId, "moto-123");
    assert.ok(configEvent.iceServers.length >= 2);
    assert.ok(fakeClient.subscriptions.includes("/av/u/clientX"));
    // Battery camera wake must be published to m/w/{deviceId}.
    assert.ok(
      fakeClient.publications.some((p) => p.topic === "m/w/dev-123"),
      "CRC32 wake published to m/w/{deviceId}",
    );
  });
});

test("sendOffer publishes QoS 1 offer with correct shape", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps({ mqttMock: { connect: () => fakeClient } }, async (WebRTCSignaling) => {
    const { wr } = await startSession(WebRTCSignaling);
    t.after(() => wr.disconnect());
    fakeClient.emit("connect");
    wr.sendOffer("v=0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\r\n", 1);

    const pubs = offerPubs(fakeClient);
    assert.ok(pubs.length >= 1, "offer publication not found");
    const offerPub = pubs.find((p) => p.qos === 1) || pubs[0];
    assert.equal(offerPub.topic, "/av/moto/moto-123/u/dev-123");
    assert.equal(offerPub.qos, 1, "offer must be QoS 1");

    const pl = JSON.parse(offerPub.payload);
    assert.equal(pl.protocol, 302);
    assert.equal(pl.pv, "2.2");
    const h = pl.data.header;
    assert.equal(h.type, "offer");
    assert.equal(h.from, "clientX");
    assert.equal(h.to, "dev-123");
    assert.equal(h.moto_id, "moto-123");
    assert.ok(typeof h.sessionid === "string" && h.sessionid.length > 0);
    const m = pl.data.msg;
    assert.equal(m.mode, "webrtc");
    assert.equal(m.stream_type, 1);
    assert.equal(m.auth, "auth-token-base64==");
    assert.ok(Array.isArray(m.token) && m.token.length >= 2, "token = ICE servers");
    // tuya-ipc-terminal sends replay:{is_replay:0}; the camera may reject the
    // offer without it.
    assert.deepEqual(m.replay, { is_replay: 0 });
    assert.equal(m.datachannel_enable, false);
    assert.ok(!m.sdp.includes("a=extmap"), "extmap stripped");
  });
});

test("offer → mock camera answer → answer event", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps({ mqttMock: { connect: () => fakeClient } }, async (WebRTCSignaling) => {
    const { wr } = await startSession(WebRTCSignaling);
    t.after(() => wr.disconnect());
    fakeClient.emit("connect");

    let answerReceived = null;
    wr.on("answer", (d) => (answerReceived = d));

    wr.sendOffer("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n", 1);
    const sessionid = JSON.parse(offerPubs(fakeClient)[0].payload).data.header.sessionid;

    fakeClient.receive("/av/u/clientX", {
      protocol: 302,
      pv: "2.2",
      t: Math.floor(Date.now() / 1000),
      data: {
        header: { type: "answer", sessionid, from: "dev-123", to: "clientX" },
        msg: { mode: "webrtc", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=recvonly\r\n" },
      },
    });

    assert.ok(answerReceived, "answer event must fire");
    assert.equal(answerReceived.sessionId, sessionid);
    assert.ok(answerReceived.sdp.includes("a=recvonly"));
  });
});

test("candidate relay and disconnect", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps({ mqttMock: { connect: () => fakeClient } }, async (WebRTCSignaling) => {
    const { wr } = await startSession(WebRTCSignaling);
    t.after(() => wr.disconnect());
    fakeClient.emit("connect");
    wr.sendOffer("v=0\r\n", 1);

    let got = null;
    wr.on("candidate", (d) => (got = d));
    fakeClient.receive("/av/u/clientX", {
      protocol: 302,
      data: { header: { type: "candidate", sessionid: "x" }, msg: { mode: "webrtc", candidate: "0 1 udp 1 2.3.4.5 9 typ host" } },
    });
    assert.ok(got, "candidate event must fire");
    assert.equal(got.candidate, "0 1 udp 1 2.3.4.5 9 typ host");

    wr.sendCandidate("0 1 udp 1 2.3.4.5 9 typ host");
    const candPub = fakeClient.publications.find((p) => {
      try {
        return JSON.parse(p.payload)?.data?.header?.type === "candidate";
      } catch {
        return false;
      }
    });
    assert.ok(candPub, "candidate published");
    assert.equal(candPub.qos, 1);
  });
});
