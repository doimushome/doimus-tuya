function isValidCid(cid) {
  return /^[0-9a-f]{16}$/i.test(cid);
}

function prepareChildPayload(childId, dps, version) {
  if (version === '3.3') {
    return { cid: childId, dps };
  }
  return { protocol: 5, data: { cid: childId, dps } };
}

function prepareChildQueryPayload(childId, version) {
  return prepareChildPayload(childId, {}, version);
}

function extractChildData(payload) {
  if (payload && payload.cid && payload.dps !== undefined) {
    return { childId: payload.cid, dps: payload.dps };
  }
  if (payload && payload.protocol === 5 && payload.data && payload.data.cid && payload.data.dps !== undefined) {
    return { childId: payload.data.cid, dps: payload.data.dps };
  }
  return null;
}

module.exports = { isValidCid, prepareChildPayload, prepareChildQueryPayload, extractChildData };
