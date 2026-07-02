"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");

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
    let actualOpts = opts;
    let actualCb = cb;
    if (typeof opts === "function") {
      actualCb = opts;
      actualOpts = undefined;
    }
    this.publications.push({
      topic,
      payload: String(payload),
      opts: actualOpts,
    });
    if (actualCb) actualCb(null);
  }

  end() {
    this.ended = true;
  }
}

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

function makeApiMock() {
  return {
    tokenInfo: { uid: "uid-1" },
    get: async () => ({
      success: true,
      result: {
        supports_webrtc: true,
        auth: "auth-token",
        webrtc_token: "webrtc-token-xyz",
        moto_id: "moto-123",
        p2p_config: {
          ices: [{ urls: "stun:stun.l.google.com:19302" }],
        },
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
        source_topic: { ipc: "/av/u/clientX/{device_id}" },
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

test("connect subscribes to both raw and resolved source topics", async (t) => {
  const fakeClient = new FakeMqttClient();
  const mqttMock = {
    connect: () => fakeClient,
  };

  await withMockedDeps(
    {
      mqttMock,
      uuidValues: [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", // linkId
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", // sessionId
      ],
    },
    async (WebRTCSignaling) => {
      const api = makeApiMock();
      const logger = makeLogger();
      const wr = new WebRTCSignaling(api, logger.log.bind(logger));
      t.after(() => wr.disconnect());

      await wr.getConfigs("dev-123");
      wr.connect(
        "dev-123",
        "00112233445566778899aabbccddeeff",
        wr.webrtcConfig,
        false,
      );

      fakeClient.emit("connect");

      assert.deepEqual(fakeClient.subscriptions, [
        "/av/u/clientX/{device_id}",
        "/av/u/clientX/dev-123",
      ]);
    },
  );
});

test("sendOffer publishes to resolved sink topic with expected shape", async (t) => {
  const fakeClient = new FakeMqttClient();
  const mqttMock = {
    connect: () => fakeClient,
  };

  await withMockedDeps(
    {
      mqttMock,
      uuidValues: [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", // linkId
        "cccccccc-cccc-cccc-cccc-cccccccccccc", // sessionId
      ],
    },
    async (WebRTCSignaling) => {
      const api = makeApiMock();
      const logger = makeLogger();
      const wr = new WebRTCSignaling(api, logger.log.bind(logger));
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

      assert.equal(fakeClient.publications.length, 1);
      const sent = fakeClient.publications[0];
      assert.equal(sent.topic, "/av/moto/moto-123/u/dev-123");

      const payload = JSON.parse(sent.payload);
      assert.equal(payload.protocol, 302);
      assert.equal(payload.data.header.type, "offer");
      assert.equal(payload.data.header.to, "dev-123");
      assert.equal(payload.data.header.moto_id, "moto-123");
      assert.equal(payload.data.msg.mode, "webrtc");
      assert.equal(payload.data.msg.stream_type, 1);
      assert.equal(payload.data.msg.auth, "auth-token");
      assert.equal(payload.data.msg.token, "webrtc-token-xyz");
      assert.ok(!payload.data.msg.sdp.includes("a=extmap"));
    },
  );
});

test("incoming answer parses protocol as string and nested data envelope", async (t) => {
  const fakeClient = new FakeMqttClient();
  const mqttMock = {
    connect: () => fakeClient,
  };

  await withMockedDeps(
    {
      mqttMock,
      uuidValues: [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", // linkId
        "dddddddd-dddd-dddd-dddd-dddddddddddd", // sessionId
      ],
    },
    async (WebRTCSignaling) => {
      const api = makeApiMock();
      const logger = makeLogger();
      const wr = new WebRTCSignaling(api, logger.log.bind(logger));
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

      const incoming = {
        protocol: "302",
        data: {
          data: {
            header: {
              type: "answer",
              sessionid: "sess-xyz",
            },
            msg: {
              sdp: "v=0\\r\\n...answer...",
            },
          },
        },
      };

      fakeClient.emit(
        "message",
        "/av/u/clientX/dev-123",
        Buffer.from(JSON.stringify(incoming)),
      );

      assert.deepEqual(received, {
        sdp: "v=0\\r\\n...answer...",
        sessionId: "sess-xyz",
      });
    },
  );
});
