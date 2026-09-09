// Thin wrapper over Map for bidirectional lookups. Stores each pair twice
// (a→b and b→a) so get/has/delete work from either direction.
class BiMap {
  constructor() {
    this._map = new Map();
  }
  set(a, b) {
    this._map.set(a, b);
    this._map.set(b, a);
  }
  get(a) {
    return this._map.get(a);
  }
  delete(a) {
    const b = this._map.get(a);
    if (b !== undefined) {
      this._map.delete(a);
      this._map.delete(b);
    }
  }
  has(a) {
    return this._map.has(a);
  }
  get size() {
    return this._map.size / 2;
  }
  clear() {
    this._map.clear();
  }
}

module.exports = { BiMap };
