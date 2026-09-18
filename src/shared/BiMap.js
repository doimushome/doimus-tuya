// Bidirectional map: keeps forward (a→b) and reverse (b→a) indexes in sync so
// get/has/delete work from either direction. Iteration (keys/values/size) is
// over the forward entries only.
class BiMap {
  constructor() {
    this._forward = new Map();
    this._reverse = new Map();
  }
  set(a, b) {
    if (this._forward.has(a)) {
      this._reverse.delete(this._forward.get(a));
    }
    if (this._reverse.has(b)) {
      this._forward.delete(this._reverse.get(b));
    }
    this._forward.set(a, b);
    this._reverse.set(b, a);
  }
  get(a) {
    return this._forward.has(a) ? this._forward.get(a) : this._reverse.get(a);
  }
  delete(a) {
    if (this._forward.has(a)) {
      this._reverse.delete(this._forward.get(a));
      this._forward.delete(a);
    } else if (this._reverse.has(a)) {
      this._forward.delete(this._reverse.get(a));
      this._reverse.delete(a);
    }
  }
  has(a) {
    return this._forward.has(a) || this._reverse.has(a);
  }
  get size() {
    return this._forward.size;
  }
  keys() {
    return this._forward.keys();
  }
  values() {
    return this._forward.values();
  }
  clear() {
    this._forward.clear();
    this._reverse.clear();
  }
}

module.exports = { BiMap };
