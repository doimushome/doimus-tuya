function createPluginContext() {
  return {
    debounceMap: new Map(),
    lastKnownState: new Map(),
    deviceManager: null,
    doimusDeviceMap: new Map(),
    apiRef: null,
    _wakeWatchers: new Map(),
    _streamFallbackTimers: new Map(),
    _motionTimers: null,
    _onlineSnapshotTimers: null,
    _webrtcClients: null,
    _powerModeChanged: null,
    _streamAllocProcs: null,
    _streamAllocBootDelay: 30000,
    _initRetryTimer: null,
    _energyPollTimer: null,
    _snapshotTimer: null,
    _firstUpdateSeen: null,
    p2pClients: null,
  };
}

module.exports = { createPluginContext };
