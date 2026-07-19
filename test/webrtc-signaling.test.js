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
  }

  subscribe(topic, cb) {
    this.subscriptions.push(topic);
    if (cb) cb(null);
  }

  publish(topic, payload, opts, cb) {
    let actualCb = cb;
    if (typeof opts === "function") {
      actualCb = opts;
    }
    this.publications.push({ topic, payload: String(payload) });
    if (actualCb) actualCb(null);
  }

  end() {
    this.ended = true;
  }

  // Test helper: simulate an inbound MQTT message from the camera.
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

// ---------------------------------------------------------------------------
// Module mock helper – swaps `mqtt` and `uuid` for the duration of `fn`.
// ---------------------------------------------------------------------------

function withMockedDeps({ mqttMock, uuidValues }, fn) {
  const originalLoad = Module._load;
  const uuids = Array.isArray(uuidValues)
    ? [...uuidValues]
    : ["11111111-1111-1111-1111-111111111111"];

  Module._load = function patched(request, parent, isMain) {
    if (request === "mqtt") return mqttMock;
    if (request === "uuid") {
      return {
        v4: () => {
          if (uuids.length === 0) return "ffffffff-ffff-ffff-ffff-ffffffffffff";
          return uuids.shift();
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  const modPath = path.resolve(__dirname, "../core/WebRTCSignaling.js");
  delete require.cache[modPath];

  try {
    const WebRTCSignaling = require(modPath);
    return fn(WebRTCSignaling);
  } finally {
    delete require.cache[modPath];
    Module._load = originalLoad;
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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
  return {
    lines,
    log(level, msg) {
      lines.push({ level, msg: String(msg) });
    },
  };
}

function setup(WebRTCSignaling) {
  const fakeClient = new FakeMqttClient();
  const api = makeApiMock();
  const logger = makeLogger();
  const wr = new WebRTCSignaling(api, logger.log.bind(logger));
  return { fakeClient, api, logger, wr };
}

const UUIDS = {
  subscribe: [
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", // linkId
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  ],
  offer: [
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "cccccccc-cccc-cccc-cccc-cccccccccccc", // sessionId
  ],
  answer: [
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "dddddddd-dddd-dddd-dddd-dddddddddddd",
  ],
  roundtrip: [
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", // sessionId used in reply
  ],
};

// ---------------------------------------------------------------------------
// Test 1: subscribe topics
// ---------------------------------------------------------------------------

test("connect subscribes to source topic, resolved source topic, and wildcard", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps(
    { mqttMock: { connect: () => fakeClient }, uuidValues: UUIDS.subscribe },
    async (WebRTCSignaling) => {
      const { wr } = setup(WebRTCSignaling);
      t.after(() => wr.disconnect());
      await wr.getConfigs("dev-123");
      wr.connect(
        "dev-123",
        "00112233445566778899aabbccddeeff",
        wr.webrtcConfig,
        false,
      );
      fakeClient.emit("connect");

      // source topic has no placeholder here, so raw == resolved → deduplicated to 1
      assert.ok(fakeClient.subscriptions.includes("/av/u/clientX"));
      // wildcard must also be subscribed
      assert.ok(fakeClient.subscriptions.includes("#"));
    },
  );
});

// ---------------------------------------------------------------------------
// Test 2: offer payload shape
// ---------------------------------------------------------------------------

test("sendOffer publishes to resolved sink topic with correct shape", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps(
    { mqttMock: { connect: () => fakeClient }, uuidValues: UUIDS.offer },
    async (WebRTCSignaling) => {
      const { wr } = setup(WebRTCSignaling);
      t.after(() => wr.disconnect());
      await wr.getConfigs("dev-123");
      wr.connect(
        "dev-123",
        "00112233445566778899aabbccddeeff",
        wr.webrtcConfig,
        false,
      );
      fakeClient.emit("connect");

      wr.sendOffer(
        "v=0\r\na=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid\r\n",
        1,
      );

      // Find the offer publication (skip any wake/other publishes)
      const offerPub = fakeClient.publications.find((p) => {
        try {
          return JSON.parse(p.payload)?.data?.header?.type === "offer";
        } catch {
          return false;
        }
      });
      assert.ok(offerPub, "offer publication not found");

      // ── topic ──
      assert.equal(offerPub.topic, "/av/moto/moto-123/u/dev-123");

      const pl = JSON.parse(offerPub.payload);
      // ── envelope ──
      assert.equal(pl.protocol, 302);
      assert.equal(pl.pv, "2.2");

      // ── header ──
      const h = pl.data.header;
      assert.equal(h.type, "offer");
      assert.equal(h.from, "clientX"); // UID per Tuya docs (string after /av/u/)
      assert.equal(h.to, "dev-123");
      assert.equal(h.moto_id, "moto-123");
      assert.ok(typeof h.sessionid === "string" && h.sessionid.length === 32);

      // ── msg ──
      const m = pl.data.msg;
      assert.equal(m.mode, "webrtc");
      assert.equal(m.stream_type, 1);
      assert.equal(m.auth, "auth-token-base64==");
      // token carries ICE server config so the camera can establish the relay
      assert.ok(Array.isArray(m.token), "token should be ICE servers array");
      assert.ok(m.token.length >= 2, "token should have STUN + TURN servers");
      assert.ok(
        m.token.some((s) => s.urls?.some?.((u) => u.startsWith("stun:"))),
        "token should contain a STUN server",
      );
      assert.equal(m.datachannel_enable, false);
      // extmap lines stripped
      assert.ok(!m.sdp.includes("a=extmap"));

      // ── log payload size for manual inspection ──
      console.log(
        `  [debug] offer payloadLen=${offerPub.payload.length} fields=${Object.keys(m).join(",")}`,
      );
      console.log(`  [debug] offer JSON:\n${JSON.stringify(pl, null, 2)}`);
    },
  );
});

// ---------------------------------------------------------------------------
// Test 3: incoming answer – string protocol, nested data envelope
// ---------------------------------------------------------------------------

test("incoming answer parses protocol as string and nested data envelope", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps(
    { mqttMock: { connect: () => fakeClient }, uuidValues: UUIDS.answer },
    async (WebRTCSignaling) => {
      const { wr } = setup(WebRTCSignaling);
      t.after(() => wr.disconnect());
      await wr.getConfigs("dev-123");
      wr.connect(
        "dev-123",
        "00112233445566778899aabbccddeeff",
        wr.webrtcConfig,
        false,
      );
      fakeClient.emit("connect");
      wr.sendOffer("v=0\r\n", 1);

      let received = null;
      wr.on("answer", (d) => {
        received = d;
      });

      fakeClient.receive("/av/u/clientX", {
        protocol: "302",
        data: {
          data: {
            header: { type: "answer", sessionid: "sess-xyz" },
            msg: { sdp: "v=0\r\n...answer..." },
          },
        },
      });

      assert.deepEqual(received, {
        sdp: "v=0\r\n...answer...",
        sessionId: "sess-xyz",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Test 4: full mock-camera round-trip
//   Client sends offer → mock camera echoes answer on source topic
//   → client emits "answer" event and cancels fallback timer
// ---------------------------------------------------------------------------

test("full round-trip: offer → mock camera answer → client receives answer", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps(
    { mqttMock: { connect: () => fakeClient }, uuidValues: UUIDS.roundtrip },
    async (WebRTCSignaling) => {
      const { wr } = setup(WebRTCSignaling);
      t.after(() => wr.disconnect());
      await wr.getConfigs("dev-123");
      wr.connect(
        "dev-123",
        "00112233445566778899aabbccddeeff",
        wr.webrtcConfig,
        false,
      );
      fakeClient.emit("connect");

      let answerReceived = null;
      let fallbackFired = false;
      wr.on("answer", (d) => {
        answerReceived = d;
      });
      wr.on("fallback", () => {
        fallbackFired = true;
      });

      wr.sendOffer("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n", 1);

      // Grab the offer publication and extract sessionid
      const offerPub = fakeClient.publications.find((p) => {
        try {
          return JSON.parse(p.payload)?.data?.header?.type === "offer";
        } catch {
          return false;
        }
      });
      assert.ok(offerPub, "offer must have been published");
      const sessionid = JSON.parse(offerPub.payload).data.header.sessionid;

      // ── Simulate mock camera: receive offer, reply with answer ──
      const mockAnswer = {
        protocol: 302,
        pv: "2.2",
        t: Math.floor(Date.now() / 1000),
        data: {
          header: {
            type: "answer",
            sessionid,
            from: "camera-dev-123",
            to: "clientX",
          },
          msg: {
            mode: "webrtc",
            sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\na=recvonly\r\n",
          },
        },
      };
      fakeClient.receive("/av/u/clientX", mockAnswer);

      // ── Assertions ──
      assert.ok(answerReceived, "answer event must have fired");
      assert.equal(answerReceived.sessionId, sessionid);
      assert.ok(answerReceived.sdp.includes("a=recvonly"));
      assert.equal(
        fallbackFired,
        false,
        "fallback must NOT fire when answer arrives",
      );

      console.log(
        `  [debug] round-trip answer.sdp: ${answerReceived.sdp.trim()}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Test 5: wildcard catches camera reply on unexpected topic
// ---------------------------------------------------------------------------

test("wildcard subscription catches camera reply on unexpected topic", async (t) => {
  const fakeClient = new FakeMqttClient();
  await withMockedDeps(
    { mqttMock: { connect: () => fakeClient }, uuidValues: UUIDS.roundtrip },
    async (WebRTCSignaling) => {
      const { wr } = setup(WebRTCSignaling);
      t.after(() => wr.disconnect());
      await wr.getConfigs("dev-123");
      wr.connect(
        "dev-123",
        "00112233445566778899aabbccddeeff",
        wr.webrtcConfig,
        false,
      );
      fakeClient.emit("connect");

      assert.ok(
        fakeClient.subscriptions.includes("#"),
        "must have wildcard subscription",
      );

      wr.sendOffer("v=0\r\n", 1);

      const offerPub = fakeClient.publications.find((p) => {
        try {
          return JSON.parse(p.payload)?.data?.header?.type === "offer";
        } catch {
          return false;
        }
      });
      const sessionid = JSON.parse(offerPub.payload).data.header.sessionid;

      let answerReceived = null;
      wr.on("answer", (d) => {
        answerReceived = d;
      });

      // Camera replies on a completely different topic (caught by #)
      fakeClient.receive("/av/some/unexpected/topic/bfc467f1", {
        protocol: 302,
        pv: "2.2",
        t: Math.floor(Date.now() / 1000),
        data: {
          header: { type: "answer", sessionid },
          msg: { mode: "webrtc", sdp: "v=0\r\n...camera-answer..." },
        },
      });

      assert.ok(
        answerReceived,
        "answer must be received even on unexpected topic",
      );
      assert.equal(answerReceived.sessionId, sessionid);
      console.log(
        `  [debug] caught on unexpected topic – answer.sdp length: ${answerReceived.sdp.length}`,
      );
    },
  );
});
