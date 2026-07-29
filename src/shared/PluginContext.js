const { BiMap } = require("./BiMap");

class PluginContext {
  constructor() {
    this.debounceMap = new Map();
    this.lastKnownState = new Map();
    this.deviceManager = null;
    this.doimusDeviceMap = new BiMap();
    this.apiRef = null;
    this._wakeWatchers = new Map();
    this._streamFallbackTimers = new Map();
    this._motionTimers = null;
    this._onlineSnapshotTimers = null;
    this._webrtcClients = null;
    this._powerModeChanged = null;
    this._streamAllocProcs = null;
    this._streamAllocBootDelay = 30000;
    this._initRetryTimer = null;
    this._energyPollTimer = null;
    this._snapshotTimer = null;
    this._firstUpdateSeen = null;
    this.p2pClients = null;
  }
}

module.exports = { PluginContext };
