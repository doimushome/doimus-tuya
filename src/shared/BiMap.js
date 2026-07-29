class BiMap {
  constructor() {
    this._fwd = new Map();
    this._rev = new Map();
  }
  set(a, b) {
    const oldB = this._fwd.get(a);
    const oldA = this._rev.get(b);
    if (oldB !== undefined) this._rev.delete(oldB);
    if (oldA !== undefined) this._fwd.delete(oldA);
    this._fwd.set(a, b);
    this._rev.set(b, a);
  }
  get(a) {
    return this._fwd.get(a) ?? this._rev.get(a);
  }
  delete(a) {
    const b = this._fwd.get(a);
    const c = this._rev.get(a);
    if (b !== undefined) {
      this._fwd.delete(a);
      this._rev.delete(b);
    }
    if (c !== undefined) {
      this._rev.delete(a);
      this._fwd.delete(c);
    }
  }
  has(a) {
    return this._fwd.has(a) || this._rev.has(a);
  }
  get size() {
    return this._fwd.size;
  }
  keys() {
    return this._fwd.keys();
  }
  values() {
    return this._fwd.values();
  }
  clear() {
    this._fwd.clear();
    this._rev.clear();
  }
}

module.exports = { BiMap };
